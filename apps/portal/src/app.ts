import {
  FREE_PLAN,
  apiKeyHash,
  monthEnd,
  monthStart,
  newApiKey,
  utcInstant,
  type AccountPlan,
  type AccountPlanStore,
  type AccountUsageReader,
  type OwnerKeys,
  type SealedKeyStore,
} from "@stellar-x402/api-keys";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { capOf, rfc3339 } from "./cap.js";
import type { Config } from "./config.js";
import { accountAge } from "./eligibility.js";
import { verifyHubToken, type Act, type HubCaller } from "./hub-token.js";
import type { Logger } from "./logger.js";
import { rateLimiter } from "./rate-limit.js";
import type { Sealer } from "./seal.js";

/**
 * Calls a minute from one address (an IPv6 /56) whose token doesn't verify: guessing, not the hub.
 */
export const STRANGER_LIMIT_PER_MINUTE = 30;
/** Calls a minute for one account, as its token names it: the hub's calls on its behalf. */
export const ACCOUNT_LIMIT_PER_MINUTE = 60;
/**
 * How long one probe of the database answers `/health`, for every call that comes in meanwhile.
 * The route needs no token and the hostname is public, so a call must not be a query and a
 * failed one an error line. No longer than the deploy's wait between its probes (2 s after each
 * answer) or Docker's healthcheck's interval (10 s), so neither is answered from a probe it saw.
 */
export const HEALTH_WINDOW_MS = 2_000;

export interface AppDeps {
  config: Pick<Config, "hubSecret" | "minAccountAgeMinutes" | "clientIp" | "accountPlans">;
  keys: SealedKeyStore;
  /** The plan name the operator gave an account, if any (0107). */
  plans: AccountPlanStore;
  /** What the account's payments count to this month (0107). */
  usage: AccountUsageReader;
  sealer: Sealer;
  logger: Logger;
  /** Rejects when the database can't be reached. */
  ready: () => Promise<void>;
  now?: () => number;
}

const ownerOf = (discordId: string) => `discord:${discordId}`;
/** What the hub shows and the logs carry of a key: enough to tell two apart, not enough to use. */
const keyIdOf = (hash: string) => hash.slice(0, 12);

/**
 * The backend the hub calls (0106): one account's API key, issued, shown and revoked on the
 * word of a short token the hub signs. There is no sign-in, session or cookie here, and no
 * browser reaches it, so no CORS header is ever sent.
 *
 * - `GET /api/hub/v1/account` is the state of the key and the account's use this month
 *   (`act: read`).
 * - `POST /api/hub/v1/key/reveal` is the key itself (`act: reveal`).
 * - `POST /api/hub/v1/key/revoke` ends it at once (`act: revoke`).
 * - `POST /api/hub/v1/key/issue` gives the account a key if it may have one (`act: issue`).
 *
 * Each call runs the token's checks first, then the handler. Whatever the token says, an
 * answer never holds a store's error message.
 */
export function createApp(deps: AppDeps): Express {
  const { config, keys, plans, usage, sealer, logger } = deps;
  const now = deps.now ?? Date.now;

  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");

  const strangers = rateLimiter(STRANGER_LIMIT_PER_MINUTE, 60_000, now);
  /** Until when `hub_strangers_limited` has been logged for the current window. */
  let strangersLoggedUntil = 0;
  const accounts = rateLimiter(ACCOUNT_LIMIT_PER_MINUTE, 60_000, now);

  const reply = (res: Response, status: number, code: string, message: string, details?: object) =>
    void res.status(status).json({ code, message, ...(details && { details }) });
  const rateLimited = (res: Response, retryAfterSeconds: number | undefined) => {
    res.set("Retry-After", String(retryAfterSeconds ?? 1));
    reply(res, 429, "rate_limited", "Too many requests; try again shortly.");
  };

  /**
   * Who a call came from, for the limit on tokens that don't verify: its address, and an IPv6
   * one's /56, as the facilitator counts it, since one /64 alone holds more addresses than any
   * window. Behind Cloudflare's tunnel the socket's is always the tunnel, so its header is read
   * instead, and only then.
   */
  const clientOf = (req: Request) => {
    const header = req.headers["cf-connecting-ip"];
    const address =
      (config.clientIp === "cloudflare" && typeof header === "string" && header) ||
      req.socket.remoteAddress;
    return address ? ipKeyGenerator(address) : "unknown";
  };

  /**
   * The account's payments this month against its plan's quota (0107), in Prices' shape. `null`
   * when either read fails: the key is still answered, and the hub shows no figures.
   */
  const usageOf = async (caller: HubCaller, owner: string): Promise<object | null> => {
    const at = now();
    try {
      const name = await plans.planOf(owner);
      // A plan the config no longer has reads as the free one, as the facilitator reads it.
      const plan: AccountPlan =
        (name === undefined ? undefined : config.accountPlans.get(name)) ??
        config.accountPlans.get(FREE_PLAN)!;
      const used = await usage.paymentsSince(owner, monthStart(at));
      const end = utcInstant(monthEnd(at));
      return {
        used,
        remaining: Math.max(0, plan.payments - used),
        limit: plan.payments,
        period_start: utcInstant(monthStart(at)),
        period_end: end,
        resets_at: end,
        as_of: utcInstant(at),
        plan: { name: plan.name, quota_limit: plan.payments, quota_period: "month" },
      };
    } catch (error) {
      logger.error("hub_usage_unavailable", { jti: caller.jti, act: caller.act, error });
      return null;
    }
  };

  /**
   * Token, then act, then the account's limit, in that order: nothing is spent on an account
   * before the token has proved the account exists. A token that doesn't verify costs its
   * address (an IPv6 one's /56), so guessing is limited without a good caller sharing the count.
   */
  const gate =
    (act: Act, handle: (caller: HubCaller, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      const bearer = /^Bearer ([^ ]+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const caller =
        bearer === undefined ? undefined : verifyHubToken(bearer, config.hubSecret, now());
      if (caller === undefined) {
        const hit = strangers.hit(clientOf(req));
        if (!hit.allowed) {
          // One line per window, not one per refused call: a flood must not become a log flood.
          if (now() >= strangersLoggedUntil) {
            logger.warn("hub_strangers_limited", {});
            strangersLoggedUntil = now() + (hit.retryAfterSeconds ?? 1) * 1000;
          }
          return rateLimited(res, hit.retryAfterSeconds);
        }
        // No bearer at all is a probe, not a hub with a bad token: quieter.
        if (bearer === undefined) logger.debug("hub_call_refused", { reason: "invalid_token" });
        else logger.warn("hub_call_refused", { reason: "invalid_token" });
        return reply(res, 401, "invalid_token", "The token is missing or not valid.");
      }
      if (caller.act !== act) {
        logger.warn("hub_call_refused", {
          jti: caller.jti,
          act: caller.act,
          reason: "action_not_allowed",
        });
        return reply(res, 403, "action_not_allowed", "The token is for another action.");
      }
      // Keyed by the account and never logged: the Discord id stays out of the logs.
      const hit = accounts.hit(caller.discordId);
      if (!hit.allowed) return rateLimited(res, hit.retryAfterSeconds);
      await handle(caller, res);
    };

  /**
   * A failure of the store: logged with its error, answered without it. A 502, as Prices answers
   * one, so the hub doesn't call again at once (it retries a 503 only).
   */
  const unavailable = (caller: HubCaller, res: Response, error: unknown) => {
    logger.error("hub_call_failed", { jti: caller.jti, act: caller.act, error });
    reply(res, 502, "key_unavailable", "The key store is not available; try again shortly.");
  };

  /**
   * The key in an active key's copy, or `undefined`: no copy (the operator's script issued it),
   * or one that doesn't open (another key, edited, moved). `showable` and `reveal` both go by this.
   */
  const keyOf = (active: NonNullable<OwnerKeys["active"]>, owner: string): string | undefined => {
    if (active.sealed === undefined) return undefined;
    try {
      return sealer.open(active.sealed, owner, active.hash);
    } catch {
      return undefined;
    }
  };

  /** The probe `/health` answers from, and until when it does: one query a window, however many calls. */
  let health: { until: number; ready: Promise<boolean> } | undefined;
  /** Until when `not_ready` has been logged: probes that hung together must not log together. */
  let notReadyLoggedUntil = 0;
  const readiness = (): Promise<boolean> => {
    const at = now();
    if (health === undefined || at >= health.until) {
      health = {
        until: at + HEALTH_WINDOW_MS,
        // Through an async function, so a `ready` that throws is a rejection like any other.
        ready: (async () => deps.ready())().then(
          () => true,
          (error: unknown) => {
            if (now() >= notReadyLoggedUntil) {
              logger.error("not_ready", { error });
              notReadyLoggedUntil = now() + HEALTH_WINDOW_MS;
            }
            return false;
          },
        ),
      };
    }
    return health.ready;
  };

  app.get("/health", async (_req, res) => {
    if (await readiness()) res.json({ ready: true });
    else res.status(503).json({ ready: false });
  });

  app.use("/api", (_req, res, next) => {
    // Every answer here is about one account, and one of them is its key.
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });

  // Express answers HEAD from a GET route; the contract has GET and POST only, and a call it
  // doesn't have is a 404 before any token is read.
  app.use("/api/hub/v1", (req, res, next) => {
    if (req.method === "GET" || req.method === "POST") return next();
    reply(res, 404, "not_found", "There is nothing at this address.");
  });

  app.get(
    "/api/hub/v1/account",
    gate("read", async (caller, res) => {
      const owner = ownerOf(caller.discordId);
      let held: OwnerKeys;
      try {
        held = await keys.keysOf(owner);
      } catch (error) {
        return unavailable(caller, res, error);
      }
      const log = (state: string, keyId?: string) =>
        logger.info("hub_account_answered", {
          jti: caller.jti,
          act: caller.act,
          state,
          ...(keyId && { key_id: keyId }),
        });
      if (held.active) {
        log("active", keyIdOf(held.active.hash));
        const showable = keyOf(held.active, owner) !== undefined;
        // With the wrong encryption key every key reads as not showable and the hub hides Show,
        // so `reveal` is never called: this is where that gets seen.
        if (!showable && held.active.sealed !== undefined) {
          logger.error("hub_key_copy_unreadable", {
            jti: caller.jti,
            act: caller.act,
            key_id: keyIdOf(held.active.hash),
          });
        }
        res.json({
          key: {
            state: "active",
            key_id: keyIdOf(held.active.hash),
            created_at: rfc3339(held.active.createdAt),
            can_issue: false,
          },
          details: { showable, usage: await usageOf(caller, owner) },
        });
      } else if (held.lastRevokedAt !== undefined) {
        log("revoked");
        const cap = capOf(held.lastRevokedAt, now());
        res.json({
          key: {
            state: "revoked",
            revoked_at: rfc3339(held.lastRevokedAt),
            ...(cap.capped && { next_eligible_at: cap.nextEligibleAt }),
            can_issue: !cap.capped,
          },
          details: { showable: false, usage: await usageOf(caller, owner) },
        });
      } else {
        log("none");
        res.json({ key: { state: "none", can_issue: true }, details: { showable: false } });
      }
    }),
  );

  app.post(
    "/api/hub/v1/key/reveal",
    gate("reveal", async (caller, res) => {
      const owner = ownerOf(caller.discordId);
      const base = { jti: caller.jti, act: caller.act };
      let held: OwnerKeys;
      try {
        held = await keys.keysOf(owner);
      } catch (error) {
        return unavailable(caller, res, error);
      }
      if (!held.active) {
        const cap = capOf(held.lastRevokedAt, now());
        if (held.lastRevokedAt !== undefined && cap.capped) {
          logger.info("hub_reveal_refused", { ...base, outcome: "key_revoked" });
          return reply(res, 404, "key_revoked", "The key was revoked.", {
            next_eligible_at: cap.nextEligibleAt,
            revoked_at: rfc3339(held.lastRevokedAt),
          });
        }
        logger.info("hub_reveal_refused", { ...base, outcome: "no_key" });
        return reply(res, 404, "no_key", "The account has no key.");
      }
      const keyId = keyIdOf(held.active.hash);
      const value = keyOf(held.active, owner);
      if (value === undefined) {
        // A copy that exists and doesn't open is a fault to look at; no copy is how the operator's keys are.
        if (held.active.sealed !== undefined) {
          logger.error("hub_key_copy_unreadable", { ...base, key_id: keyId });
        }
        logger.info("hub_reveal_refused", { ...base, outcome: "key_not_viewable", key_id: keyId });
        return reply(
          res,
          409,
          "key_not_viewable",
          "This key cannot be shown; revoke it for a new one.",
        );
      }
      logger.info("hub_key_revealed", { ...base, key_id: keyId });
      res.json({ key_id: keyId, value, created_at: rfc3339(held.active.createdAt) });
    }),
  );

  app.post(
    "/api/hub/v1/key/revoke",
    gate("revoke", async (caller, res) => {
      const owner = ownerOf(caller.discordId);
      const base = { jti: caller.jti, act: caller.act };
      const refuse = () => {
        logger.info("hub_revoke_refused", { ...base, outcome: "no_key" });
        reply(res, 404, "no_key", "The account has no active key.");
      };
      try {
        // Read first for the key's id to log; the revoke itself says whether one was active.
        const active = (await keys.keysOf(owner)).active;
        if (!active) return refuse();
        const at = now();
        if (!(await keys.revoke(owner, at))) return refuse();
        logger.info("hub_key_revoked", { ...base, key_id: keyIdOf(active.hash) });
        const cap = capOf(at, at);
        res.json({
          revoked: true,
          revoked_at: rfc3339(at),
          next_eligible_at: cap.capped ? cap.nextEligibleAt : undefined,
        });
      } catch (error) {
        unavailable(caller, res, error);
      }
    }),
  );

  app.post(
    "/api/hub/v1/key/issue",
    gate("issue", async (caller, res) => {
      const owner = ownerOf(caller.discordId);
      const base = { jti: caller.jti, act: caller.act };
      const at = now();
      /** Always a 200: what asking came to is the answer, not a fault of the call. */
      const outcome = (name: string, extra: { next_eligible_at?: string } = {}) => {
        if (name !== "issued" && name !== "failed") {
          logger.info("hub_issue_refused", { ...base, outcome: name });
        }
        res.json({ outcome: name, ...extra });
      };

      const age = accountAge(caller.discordId, config.minAccountAgeMinutes, at);
      // Can't happen today: the token's subject is already digits. Kept as a defence.
      if (age === undefined) {
        logger.warn("hub_call_refused", { ...base, reason: "invalid_token" });
        return reply(res, 401, "invalid_token", "The token is missing or not valid.");
      }
      if (age.kind === "too_young")
        return outcome("too_young", { next_eligible_at: age.oldEnoughAt });

      try {
        const held = await keys.keysOf(owner);
        if (held.active) return outcome("has_key");
        const cap = capOf(held.lastRevokedAt, at);
        if (cap.capped) return outcome("capped", { next_eligible_at: cap.nextEligibleAt });

        const key = newApiKey();
        const hash = apiKeyHash(key);
        const sealed = sealer.seal(key, owner, hash);
        // Losing to a concurrent issue is the same answer as finding the key already there.
        if (!(await keys.issue({ hash, owner, sealed, now: at }))) return outcome("has_key");
        logger.info("hub_key_issued", { ...base, key_id: keyIdOf(hash) });
        outcome("issued");
      } catch (error) {
        logger.error("hub_call_failed", { ...base, error });
        outcome("failed");
      }
    }),
  );

  // A path or method the contract doesn't have: no token is read, so nothing is learnt by asking.
  app.use((_req, res) => reply(res, 404, "not_found", "There is nothing at this address."));

  // Express tells an error handler by its four parameters, so `_next` must be there unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("hub_call_failed", { error });
    reply(res, 500, "internal", "Something went wrong.");
  });

  return app;
}
