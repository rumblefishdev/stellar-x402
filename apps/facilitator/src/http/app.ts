import { STATUS_CODES } from "node:http";
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema } from "@x402/core/schemas";
import type { VerifyRequest } from "@x402/core/types";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Stores } from "../ports/index.js";
import type { SettlementHooks } from "../settlement/hooks.js";
import type { Settle } from "../settlement/settle.js";
import type { Verify } from "../settlement/verify.js";
import { EXTENSION_RESPONSES_HEADER, encodeExtensionResponses } from "./extension-responses.js";

/** What the composition root hands to the HTTP adapter. Lanes add their services here. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  stores: Stores;
  verify: Verify;
  settle: Settle;
  /** The `EXTENSION-RESPONSES` header of a `success` settle answer (AD-8). */
  extensionResponses: SettlementHooks["extensionResponses"];
}

/** The status as a body code, like `not_found`: 413 → `payload_too_large`. */
const code = (status: number) =>
  (STATUS_CODES[status] ?? "error").toLowerCase().replace(/[^a-z]+/g, "_");

const notImplemented: RequestHandler = (_req, res) => {
  res.status(501).json({ error: "not_implemented" });
};

/**
 * How deeply a request body may nest. The x402 objects need about 6 levels; `extensions` is free
 * JSON, and the settlement fingerprint's canonical JSON recurses once per level.
 */
export const MAX_BODY_DEPTH = 32;

/** Whether `value` nests deeper than `max` arrays and objects, counted without recursion. */
function nestsDeeper(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop()!;
    if (item === null || typeof item !== "object") continue;
    if (depth >= max) return true;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * An x402 v2 verify or settle request (AD-13), checked with `@x402/core`'s schemas. The objects
 * pass on as the client sent them; `undefined` means a 400.
 *
 * The schema takes any non-empty `amount`, and upstream's `BigInt(amount)` throws on anything but
 * an integer, which it reports as `unexpected_verify_error`: our 500. So `amount` must be digits.
 * A body nested deeper than {@link MAX_BODY_DEPTH} is a 400 too, before anything recurses on it.
 */
export function parsePaymentRequest(body: unknown): VerifyRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (nestsDeeper(body, MAX_BODY_DEPTH)) return undefined;
  const { x402Version, paymentPayload, paymentRequirements } = body as Record<string, unknown>;
  const requirements = PaymentRequirementsV2Schema.safeParse(paymentRequirements);
  const valid =
    x402Version === 2 &&
    PaymentPayloadV2Schema.safeParse(paymentPayload).success &&
    requirements.success &&
    /^\d+$/.test(requirements.data.amount);
  return valid ? (body as VerifyRequest) : undefined;
}

/**
 * The inbound HTTP adapter (AD-13). The routes answer 501 until their tasks land: `/supported`
 * (0020) and `/discovery/resources` (0032). There is a body size limit and
 * no CORS anywhere (spine "HTTP hardening"); rate limits come in 0023.
 */
export function createApp({
  config,
  logger,
  verify,
  settle,
  extensionResponses,
}: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.http.bodyLimitBytes }));

  // A verify outcome, valid or not, is a 200 with an x402 body; a thrown error is a 500.
  app.post("/verify", async (req, res) => {
    const request = parsePaymentRequest(req.body);
    if (!request) {
      res.status(400).json({ error: code(400) });
      return;
    }
    const response = await verify(request.paymentPayload, request.paymentRequirements);
    logger.info("verified", {
      network: request.paymentRequirements.network,
      isValid: response.isValid,
      invalidReason: response.invalidReason,
      // Our own code next to upstream's, e.g. for a channel account.
      reason: response.extra?.reason,
      payer: response.payer,
    });
    res.json(response);
  });
  // Like `/verify`: any settle outcome is a 200 with an x402 body (AD-6). A thrown error, such as
  // upstream verify failing or the store down before the claim, is a 500.
  app.post("/settle", async (req, res) => {
    const request = parsePaymentRequest(req.body);
    if (!request) {
      res.status(400).json({ error: code(400) });
      return;
    }
    // A client that left before the answer: a repeat stops waiting, and no success is used up.
    const left = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) left.abort();
    });
    const { response, record, afterResponse, key, replay } = await settle(
      request.paymentPayload,
      request.paymentRequirements,
      left.signal,
    );
    // Every `success` answer carries the header (a success is answered once, AD-6); it never
    // changes the body.
    if (response.success && record) {
      try {
        const header = extensionResponses(record);
        if (header) res.setHeader(EXTENSION_RESPONSES_HEADER, encodeExtensionResponses(header));
      } catch (error) {
        logger.error("extension_responses_failed", { settlementKey: record.key, error });
      }
    }
    logger.info("settled", {
      network: response.network,
      settlementKey: key,
      replay: replay ?? false,
      success: response.success,
      errorReason: response.errorReason,
      payer: response.payer,
      transaction: response.transaction || undefined,
    });
    res.json(response);
    // `onSuccess` after the response; a client that already left has closed it (0031).
    if (afterResponse) {
      if (res.closed) afterResponse();
      else res.once("close", afterResponse);
    }
  });
  app.get("/supported", notImplemented);
  app.get("/discovery/resources", notImplemented);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    // body-parser marks the client's mistakes as `expose` (400 malformed JSON, 413 body over the
    // limit, 415 charset or encoding); anything else is ours.
    const status: number =
      error?.expose && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) logger.error("http_error", { error });
    // A route that already started its answer can't switch to an error: Express ends the
    // connection.
    if (res.headersSent) return next(error);
    res.status(status).json({ error: status === 500 ? "internal_error" : code(status) });
  };
  app.use(onError);
  return app;
}
