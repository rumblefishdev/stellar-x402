import { STATUS_CODES } from "node:http";
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema } from "@x402/core/schemas";
import type { SupportedResponse, VerifyRequest } from "@x402/core/types";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { Stores } from "../ports/index.js";
import type { SettlementHooks } from "../settlement/hooks.js";
import type { Settle } from "../settlement/settle.js";
import type { Verify, VerifyTrace } from "../settlement/verify.js";
import { discoveryResources } from "./discovery.js";
import { EXTENSION_RESPONSES_HEADER, encodeExtensionResponses } from "./extension-responses.js";
import { rateLimit } from "./rate-limit.js";

/** What the composition root hands to the HTTP adapter. Lanes add their services here. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  stores: Stores;
  verify: Verify;
  settle: Settle;
  /** The `EXTENSION-RESPONSES` header of a `success` settle answer (AD-8). */
  extensionResponses: SettlementHooks["extensionResponses"];
  /** The `GET /supported` answer, fixed for the life of the process. */
  supported: SupportedResponse;
}

/** The status as a body code, like `not_found`: 413 → `payload_too_large`. */
const code = (status: number) =>
  (STATUS_CODES[status] ?? "error").toLowerCase().replace(/[^a-z]+/g, "_");

/**
 * How deeply a request body may nest. The x402 objects need about 6 levels, but `extensions` is
 * free JSON: upstream's client copies a seller's whole Bazaar declaration into it, JSON Schema
 * included, and each nullable object in an output schema adds 4. The settlement fingerprint's
 * canonical JSON recurses once per level and overflows only at about 20 000.
 */
export const MAX_BODY_DEPTH = 256;

/**
 * A NUL, or a lone UTF-16 surrogate (`\p{Cs}` matches only an unpaired one under the `u` flag).
 * PostgreSQL refuses a NUL in `text` and `jsonb`, and `jsonb` a lone surrogate, so either would
 * fail the settlement's store write with a 500.
 */
const UNSTORABLE_TEXT = /[\0\p{Cs}]/u;

/**
 * Whether `value` nests deeper than `max` arrays and objects, or holds a string or key matching
 * {@link UNSTORABLE_TEXT}; walked without recursion.
 */
function refusedBody(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop()!;
    if (typeof item === "string" && UNSTORABLE_TEXT.test(item)) return true;
    if (item === null || typeof item !== "object") continue;
    if (depth >= max) return true;
    for (const [key, child] of Object.entries(item)) {
      if (UNSTORABLE_TEXT.test(key)) return true;
      stack.push([child, depth + 1]);
    }
  }
  return false;
}

/**
 * An x402 v2 verify or settle request (AD-13), checked with `@x402/core`'s schemas. The objects
 * pass on as the client sent them; `undefined` means a 400.
 *
 * The schema takes any non-empty `amount`, and upstream's `BigInt(amount)` throws on anything but
 * an integer, which it reports as `unexpected_verify_error`: our 500. So `amount` must be digits.
 * A body nested deeper than {@link MAX_BODY_DEPTH} is a 400 too, before anything recurses on it,
 * and so is a NUL or a lone surrogate anywhere in it.
 */
export function parsePaymentRequest(body: unknown): VerifyRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (refusedBody(body, MAX_BODY_DEPTH)) return undefined;
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
 * The inbound HTTP adapter (AD-13). There is a body size limit and no CORS anywhere (spine "HTTP
 * hardening"). `/verify`, `/settle` and `/discovery/*` each have a rate limit (AD-11), applied
 * before the body is read, so a malformed or oversized request counts too; `/supported` has none.
 */
export function createApp({
  config,
  logger,
  metrics,
  stores,
  verify,
  settle,
  extensionResponses,
  supported,
}: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  const limit = (route: string, budget: number) =>
    rateLimit({
      route,
      limit: budget,
      windowMs: config.http.rateLimit.windowMs,
      clientIp: config.http.clientIp,
      store: stores.rateLimits,
      logger,
    });
  const json = express.json({ limit: config.http.bodyLimitBytes });

  // A verify outcome, valid or not, is a 200 with an x402 body; a thrown error is a 500.
  app.post("/verify", limit("verify", config.http.rateLimit.verify), json, async (req, res) => {
    const request = parsePaymentRequest(req.body);
    if (!request) {
      res.status(400).json({ error: code(400) });
      return;
    }
    const trace: VerifyTrace = {};
    const response = await verify(request.paymentPayload, request.paymentRequirements, trace);
    logger.info("verified", {
      network: request.paymentRequirements.network,
      isValid: response.isValid,
      invalidReason: response.invalidReason,
      // Our own code next to upstream's, e.g. for a channel account.
      reason: response.extra?.reason,
      payer: response.payer,
      // Which RPC URL answered: a lagging fallback rejects valid payments (AD-3).
      rpc: trace.rpc,
    });
    res.json(response);
  });
  // Like `/verify`: any settle outcome is a 200 with an x402 body (AD-6). A thrown error, such as
  // upstream verify failing or the store down before the claim, is a 500.
  app.post("/settle", limit("settle", config.http.rateLimit.settle), json, async (req, res) => {
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
  app.get("/supported", (_req, res) => {
    res.json(supported);
  });
  app.use("/discovery", limit("discovery", config.http.rateLimit.discovery));
  app.get(
    "/discovery/resources",
    discoveryResources(stores.catalog, logger, metrics, config.network),
  );

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
