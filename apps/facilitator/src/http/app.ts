import { STATUS_CODES } from "node:http";
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema } from "@x402/core/schemas";
import type { VerifyRequest } from "@x402/core/types";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Stores } from "../ports/index.js";
import type { Verify } from "../settlement/verify.js";

/** What the composition root hands to the HTTP adapter. Lanes add their services here. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  stores: Stores;
  verify: Verify;
}

/** The status as a body code, like `not_found`: 413 → `payload_too_large`. */
const code = (status: number) =>
  (STATUS_CODES[status] ?? "error").toLowerCase().replace(/[^a-z]+/g, "_");

const notImplemented: RequestHandler = (_req, res) => {
  res.status(501).json({ error: "not_implemented" });
};

/**
 * An x402 v2 verify or settle request (AD-13), checked with `@x402/core`'s schemas. The objects
 * pass on as the client sent them; `undefined` means a 400.
 */
export function parsePaymentRequest(body: unknown): VerifyRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { x402Version, paymentPayload, paymentRequirements } = body as Record<string, unknown>;
  const valid =
    x402Version === 2 &&
    PaymentPayloadV2Schema.safeParse(paymentPayload).success &&
    PaymentRequirementsV2Schema.safeParse(paymentRequirements).success;
  return valid ? (body as VerifyRequest) : undefined;
}

/**
 * The inbound HTTP adapter (AD-13). The routes answer 501 until their tasks land: `/settle`
 * (0009), `/supported` (0020) and `/discovery/resources` (0032). There is a body size limit and
 * no CORS anywhere (spine "HTTP hardening"); rate limits come in 0023.
 */
export function createApp({ config, logger, verify }: AppDeps): Express {
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
      payer: response.payer,
    });
    res.json(response);
  });
  app.post("/settle", notImplemented);
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
