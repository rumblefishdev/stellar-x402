import type { RequestHandler, Response } from "express";
import type { ApiKeyStore } from "../ports/index.js";
import type { Caller } from "../settlement/hooks.js";
import { apiKeyHash, bearerApiKey, requiresApiKey } from "./api-key.js";
import type { RateLimiter } from "./rate-limit.js";

export interface Admission {
  /** Reads the body: `express.json` with the route's size limit. */
  json: RequestHandler;
  /** The route's budget. */
  limiter: RateLimiter;
  apiKeys: Pick<ApiKeyStore, "ownerOf">;
}

/** Why a request that needs an API key got a 401, as its body's `error`. */
type KeyRefusal = "missing_api_key" | "invalid_api_key";

/** The request's `paymentRequirements.network`, as the client sent it, before any check of it. */
function namedNetwork(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const requirements = (body as Record<string, unknown>).paymentRequirements;
  if (typeof requirements !== "object" || requirements === null) return undefined;
  return (requirements as Record<string, unknown>).network;
}

/** A 401 with RFC 6750's challenge; the answer never says whether a key was unknown or revoked. */
function refuse(res: Response, error: KeyRefusal): void {
  res.setHeader(
    "WWW-Authenticate",
    error === "missing_api_key" ? "Bearer" : 'Bearer error="invalid_token"',
  );
  res.status(401).json({ error });
}

/**
 * Lets a `/verify` or `/settle` request in (AD-11, 0105): reads its body, then counts it against
 * the route's budget under the client its network calls for.
 *
 * - A network that requires an API key (`requiresApiKey`: `stellar:pubnet`): the key from
 *   `Authorization: Bearer`, looked up in the registry on every request, so a revocation holds
 *   from the next one. No key is a 401 `missing_api_key`, and anything but an active key a 401
 *   `invalid_api_key`; neither counts anywhere, or a caller without a key could use up the budget
 *   of one with a key, or of an address its sellers share. An active key's request counts under
 *   the key's owner, and the owner is passed on in `res.locals` ({@link callerOf}).
 * - Any other network, and a body that names none (malformed, too large, not JSON): the request
 *   counts under the client's IP, and the `Authorization` header isn't read at all.
 *
 * The network is in the body, so the body is read before the request is counted: at most the
 * body limit is read and parsed for a client already over its budget. An owner over its budget
 * costs the registry read as well, since only the read names the owner. The network is the one the
 * settlement runs on, `paymentRequirements.network`: the checks refuse any other the payload
 * names. A registry or counter error rejects, which Express answers with a 500: nothing is let in
 * unchecked.
 */
export function admit({ json, limiter, apiKeys }: Admission): RequestHandler {
  return async (req, res, next) => {
    // body-parser never answers: it calls back, with its error for a body it refuses.
    const bodyError = await new Promise<unknown>((resolve) => json(req, res, resolve));
    if (bodyError !== undefined || !requiresApiKey(namedNetwork(req.body))) {
      // A refused body counts like any other request, then gets body-parser's 4xx.
      if (await limiter.byIp(req, res)) next(bodyError);
      return;
    }
    const authorization = req.get("authorization");
    if (authorization === undefined) return refuse(res, "missing_api_key");
    const key = bearerApiKey(authorization);
    const owner = key === undefined ? undefined : await apiKeys.ownerOf(apiKeyHash(key));
    if (owner === undefined) return refuse(res, "invalid_api_key");
    if (!(await limiter.byOwner(owner, res))) return;
    res.locals.caller = { owner } satisfies Caller;
    next();
  };
}

/** The caller {@link admit} let in with an API key; `undefined` on a network that takes none. */
export const callerOf = (res: Response): Caller | undefined =>
  res.locals.caller as Caller | undefined;
