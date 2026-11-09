import { STATUS_CODES } from "node:http";
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema } from "@x402/core/schemas";
import type { SupportedResponse, VerifyRequest, VerifyResponse } from "@x402/core/types";
import { byName } from "@stellar-x402/metrics-catalog";
import { RpcUnavailableError } from "@stellar-x402/signer-pool";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import type { SignerState } from "../adapters/openbao-signer.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type { Stores } from "../ports/index.js";
import type { SettlementHooks } from "../settlement/hooks.js";
import type { LeaseKeeper } from "../settlement/lease.js";
import type { Reconciliation } from "../settlement/reconcile.js";
import type { Settle } from "../settlement/settle.js";
import { TRUSTLINE_REASONS } from "../settlement/trustline.js";
import {
  FEE_EXCEEDS_MAXIMUM,
  UpstreamTimeoutError,
  type Verify,
  type VerifyTrace,
} from "../settlement/verify.js";
import type { BalanceReader } from "../spend/balance-floor.js";
import { discoveryResources } from "./discovery.js";
import { EXTENSION_RESPONSES_HEADER, encodeExtensionResponses } from "./extension-responses.js";
import { rateLimit } from "./rate-limit.js";

/** What the composition root hands to the HTTP adapter. Lanes add their services here. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  metrics: ProcessMetrics;
  stores: Stores;
  verify: Verify;
  settle: Settle;
  /** The `EXTENSION-RESPONSES` header of a `success` settle answer (AD-8). */
  extensionResponses: SettlementHooks["extensionResponses"];
  /** The `GET /supported` answer, fixed for the life of the process. */
  supported: SupportedResponse;
  /** Settlement reconciliation (0019), started and stopped with the server. */
  reconciliation?: Reconciliation;
  /**
   * The channel lease (0025), started and stopped with the server. While it isn't held,
   * `/settle` answers 503; tests that pass no `lease` settle as if they held it.
   */
  lease?: LeaseKeeper;
  /**
   * The fee account's balance floor (0024), read from before the lease is taken until the
   * server closes. `/settle` refuses below it, and before its first reading.
   */
  floor?: BalanceReader;
  /** Whether the process is shutting down (0025); `start()` sets it. */
  closing?: () => boolean;
  /**
   * The settlement drain (0025): closes the pool, refusing every call that sent nothing, then
   * waits for each submission under way and its record write. Run by `start()`'s `close()`.
   */
  drain?: () => Promise<void>;
  /** The facilitator key's signer as `/health` reports it (0036); tests may leave it out. */
  signerState?: () => SignerState;
}

/** Seconds a client waits before it tries `/settle` again on a process that can't settle now. */
export const NO_LEASE_RETRY_AFTER_S = 5;

/**
 * How long a seller should wait before it sends the same `/verify` again after the RPC gave no
 * answer: one ledger. No measurement of how fast an RPC recovers sets it; it only asks a seller not
 * to retry at once.
 */
export const RPC_UNAVAILABLE_RETRY_AFTER_S = 5;

/**
 * The refusals whose message the `verified` and `settled` logs carry: it names the account and the
 * asset (0078), or the archived entries to restore (0066). Both are bounded.
 */
const LOGGED_MESSAGES: ReadonlySet<string | undefined> = new Set([
  ...TRUSTLINE_REASONS,
  FEE_EXCEEDS_MAXIMUM,
]);

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
 * The routes `http_requests_total` names, from its catalog entry (the only list of them); every
 * other path is `other`. `/discovery` also counts its subpaths.
 */
const COUNTED_ROUTES: ReadonlySet<string> = new Set(
  (byName("http_requests_total")?.values?.route ?? []).filter((r) => r !== "other"),
);

/**
 * The `route` label of a request: a fixed value, never the raw path, so a scan of made-up paths
 * adds no series. Express routes ignore case and a trailing slash, so the label does too. Read
 * from `req.path`, as `req.route` isn't set for a 404 or a request a rate limit refused.
 */
export function routeLabel(path: string): string {
  const p = path.toLowerCase().replace(/(.)\/$/, "$1");
  if (COUNTED_ROUTES.has(p)) return p;
  if (p.startsWith("/discovery/")) return "/discovery";
  return "other";
}

/**
 * Counts every answer as `http_requests_total{route,status}`, once, when its response closes.
 * Mounted first, so it sees the 404s, the 429s, body-parser's 4xx, the lease's 503s and the error
 * handler's 500s. A response that didn't finish is `aborted`: the client left first, or the
 * connection was cut. That includes a route that threw after its headers went out, before its
 * body ended: the error handler can't send a 500 then, Express destroys the socket, and the
 * status that reads 200 was never answered in full. It counts as `aborted`, not 200 or 500, and
 * the `http_error` log carries it.
 */
function countRequests(metrics: ProcessMetrics): RequestHandler {
  return (req, res, next) => {
    // Read now: inside `app.use("/discovery", …)` Express strips the prefix from `req.url`, and a
    // 429 answered there, or a client that leaves there, closes the response before it is back.
    const route = routeLabel(req.path);
    res.once("close", () => {
      metrics.increment("http_requests_total", {
        route,
        status: res.writableFinished ? String(res.statusCode) : "aborted",
      });
    });
    next();
  };
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
  reconciliation,
  lease,
  closing,
  signerState,
}: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // Before everything else, so every answer is counted (process-scoped: no `network`).
  app.use(countRequests(metrics));
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
  // First on `/settle`, so a process that is stopping or doesn't hold the lease answers at once,
  // with no store call and without reading the body (0025 decisions 1, 4, 8).
  const leased: RequestHandler = (_req, res, next) => {
    const refusal = closing?.() ? "shutting_down" : lease && !lease.held() ? "no_lease" : undefined;
    if (refusal) {
      res.setHeader("Retry-After", `${NO_LEASE_RETRY_AFTER_S}`);
      res.status(503).json({ error: refusal });
      return;
    }
    next();
  };

  // A verify outcome, valid or not, is a 200 with an x402 body. An RPC that gave no answer is a
  // 503: the payment wasn't judged, so the same request may come again. Any other thrown error is a
  // 500. Upstream's `unexpected_verify_error` stays a 500: it doesn't say whether the RPC failed.
  app.post("/verify", limit("verify", config.http.rateLimit.verify), json, async (req, res) => {
    const request = parsePaymentRequest(req.body);
    if (!request) {
      res.status(400).json({ error: code(400) });
      return;
    }
    const trace: VerifyTrace = {};
    let response: VerifyResponse;
    try {
      response = await verify(request.paymentPayload, request.paymentRequirements, trace);
    } catch (error) {
      // `FallbackRpc` turns its own timeouts into `RpcUnavailableError` once every URL failed.
      const noAnswer =
        error instanceof UpstreamTimeoutError || error instanceof RpcUnavailableError;
      if (!noAnswer) throw error;
      logger.warn("verify_rpc_unavailable", {
        network: request.paymentRequirements.network,
        error,
      });
      res.setHeader("Retry-After", `${RPC_UNAVAILABLE_RETRY_AFTER_S}`);
      res.status(503).json({ error: "rpc_unavailable" });
      return;
    }
    logger.info("verified", {
      network: request.paymentRequirements.network,
      isValid: response.isValid,
      invalidReason: response.invalidReason,
      // Our own code next to upstream's, e.g. for a channel account.
      reason: response.extra?.reason,
      payer: response.payer,
      // Which RPC URL answered: a lagging fallback rejects valid payments (AD-3).
      rpc: trace.rpc,
      message: LOGGED_MESSAGES.has(response.invalidReason) ? response.invalidMessage : undefined,
    });
    res.json(response);
  });
  // Like `/verify`: any settle outcome is a 200 with an x402 body (AD-6). A thrown error, such as
  // upstream verify failing or the store down before the claim, is a 500.
  app.post(
    "/settle",
    leased,
    limit("settle", config.http.rateLimit.settle),
    json,
    async (req, res) => {
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
        message: LOGGED_MESSAGES.has(response.errorReason) ? response.errorMessage : undefined,
        payer: response.payer,
        transaction: response.transaction || undefined,
      });
      res.json(response);
      // `onSuccess` after the response; a client that already left has closed it (0031).
      if (afterResponse) {
        if (res.closed) afterResponse();
        else res.once("close", afterResponse);
      }
    },
  );
  app.get("/supported", (_req, res) => {
    res.json(supported);
  });
  // Liveness for the container healthcheck: 200 while the server is up, whatever the lease or the
  // store (ADR 0011). The deploy waits for `ready`, the lease held outside a shutdown, as `/settle`
  // needs (`main()` starts only on a migrated schema; 0049 adds the frozen RPCs), and `listed`, a
  // sweep having listed the open records (0019 decision 36), and for `signer` ok, so an image that
  // can't sign doesn't become the last good one. Tests without them count as both.
  app.get("/health", (_req, res) => {
    res.json({
      ready: !closing?.() && (lease?.held() ?? true),
      // Not part of `ready`: the service runs and verifies without OpenBao (0036 decision 4).
      ...(signerState && { signer: signerState() }),
      listed: reconciliation?.listed() ?? true,
      // Which build answers, so a conformance run's record can name it (0029).
      commit: config.gitCommit,
    });
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
