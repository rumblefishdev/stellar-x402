import { createHash } from "node:crypto";
import * as bazaarLib from "@stellar-x402/bazaar";
import { isStellarNetwork } from "@stellar-x402/config";
import type { PaymentRequired } from "@x402/core/types";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import type { Logger } from "../logger.js";
import type { ProcessMetrics } from "../metrics.js";
import type {
  CatalogAttempt,
  CatalogAttemptStore,
  CatalogEntry,
  CatalogKey,
  CatalogStore,
  RateLimitStore,
  SettlementRecord,
  UpsertOutcome,
} from "../ports/index.js";
import type { SettlementHooks, SettlementOrigin } from "../settlement/hooks.js";
import { CHECKS_PER_HOST, overBudget } from "./budget.js";
import type { SearchVectors } from "./search-vectors.js";
import { askMcpSeller, askSeller, type SellerAnswer } from "./seller-check.js";

export type BazaarApi = Pick<typeof bazaarLib, "validate" | "normalize" | "toExtensionResponses">;

/** What a check's log lines carry about what started it: a settlement's `context`, or a seed's. */
type LogFields = Record<string, unknown>;

/** What started a check: a settlement (`settle`, `resolved`) or the seed command (0155). */
type CheckOrigin = SettlementOrigin | "seed";

/** One listing key to ask its seller about, and what the attempt knew before asking. */
interface SellerCheck {
  url: string;
  input: bazaarLib.Discovered["discoveryInfo"]["input"];
  key: CatalogKey;
  /** The settlement's ledger, kept on the entry; `null` for a seed (0155). */
  ledger: number | null;
  compared: Omit<CatalogAttempt, "stage" | "outcome">;
  /**
   * The seller's 402 when it was already asked with this listing's method (the seed's, 0155), and
   * when it was asked: the listing was confirmed then, not when the check reads it.
   */
  answer?: { paymentRequired: PaymentRequired; at: number };
}

export interface CatalogerDeps {
  store: CatalogStore;
  attempts: CatalogAttemptStore;
  /** Where the seller-check budgets are counted. */
  rateLimits: Pick<RateLimitStore, "hit">;
  logger: Logger;
  metrics: ProcessMetrics;
  /** Injectable for fault-injection tests; the real package otherwise. */
  bazaar?: BazaarApi;
  /** A slower write counts as failed, so a hung store can't pile up writes or block `drain()`. */
  upsertTimeoutMs?: number;
  /**
   * Development only (`CATALOG_LIST_LOCAL`): list local, private and IP resource URLs too, and ask
   * a seller on this machine over http.
   */
  listLocal?: boolean;
  /** A seller slower than this to answer the check gave no usable answer. */
  sellerTimeoutMs?: number;
  checksPerHost?: number;
  /** The app clock, ms. */
  now?: () => number;
  /** The search vectors (ADR 0014): asked for the vector of each listing written. */
  vectors?: Pick<SearchVectors, "listed">;
}

/** How seeding one resource URL ended, a line of the seed's report (0155). */
export interface SeedResult {
  url: string;
  /** The method the listing was asked with: the file's, or the one the seller's 402 declares. */
  method: string;
  /** Set once the seller's 402 named the offer's network and account. */
  network?: string;
  payTo?: string;
  /** An attempt's outcome, or `not_askable` / `refused` / `internal_error` before any attempt. */
  outcome: string;
  reason?: string;
  detail?: string;
}

export type Cataloger = Pick<SettlementHooks, "extensionResponses" | "onSuccess"> & {
  /** Resolves once every in-flight `onSuccess` has settled (tests, graceful shutdown). */
  drain(): Promise<void>;
  /**
   * Seeds the catalog with one resource URL from its seller's own file (0155): one unpaid request
   * learns the listing's keys from the 402, then each key gets the check a payment would start, on
   * that same 402 unless the seller declares another method or an MCP tool. `requests` counts the
   * requests sent, for the seed's pace. Never rejects: every failure is a result with its reason.
   */
  seed(url: string, method: string): Promise<{ results: SeedResult[]; requests: number }>;
};

/**
 * The largest seller response read by a check. Measured sellers answer an unpaid request with an
 * empty body or the listing's example (0063), which sits in the 32 KiB `bazaar` block.
 */
const SELLER_RESPONSE_BYTES = 64 * 1024;
/**
 * The largest MCP seller response read by a check: twice the largest `tools/list` measured
 * (122,729 B, 35 tools, 2026-10-28), since the tool's schemas come with it.
 */
const MCP_RESPONSE_BYTES = 256 * 1024;
/** A library error lists every issue; the attempt's row keeps its start. */
const DETAIL_CHARS = 1_000;

const contentHash = (resource: Omit<DiscoveryResource, "lastUpdated">) =>
  createHash("sha256")
    .update(JSON.stringify({ ...resource, lastUpdated: undefined }))
    .digest("hex");

/**
 * Cataloging after a successful settlement (AD-8, AD-19, 0063), plugged in through
 * `SettlementHooks`. The header comes from the payment's copy alone, synchronously, before the
 * settle response. After it, a listing is written only from the seller's own unpaid 402: the copy
 * just decides whether to ask, when it differs from the stored listing and a budget allows.
 * Every attempt to change a listing is a row in `attempts`. Nothing here ever throws into
 * `/settle` or compiles a seller schema.
 */
export function createCataloger({
  store,
  attempts,
  rateLimits,
  logger,
  metrics,
  bazaar = bazaarLib,
  upsertTimeoutMs = 10_000,
  listLocal = false,
  sellerTimeoutMs = 10_000,
  checksPerHost = CHECKS_PER_HOST,
  now = Date.now,
  vectors,
}: CatalogerDeps): Cataloger {
  const inFlight = new Set<Promise<void>>();
  const options = { listLocal };
  const sellerLimits = {
    timeoutMs: sellerTimeoutMs,
    maxResponseBytes: SELLER_RESPONSE_BYTES,
    allowInsecureLocal: listLocal,
  };

  const context = (record: SettlementRecord, origin: SettlementOrigin) => ({
    network: record.network,
    settlementKey: record.key,
    transaction: record.hashes.at(-1),
    origin,
  });
  // Reporting must not throw either: on the header path that would turn a paid answer into a 500.
  const report = (write: () => void) => {
    try {
      write();
    } catch (error) {
      console.error("catalog_report_failed", error);
    }
  };
  const internalError = (stage: string, fields: LogFields, origin: CheckOrigin, error?: unknown) =>
    report(() => {
      logger.error("catalog_internal_error", { ...fields, stage, error });
      metrics.increment("catalog_internal_errors_total", { stage, origin });
    });

  async function upsert(entry: CatalogEntry): Promise<UpsertOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("catalog upsert timed out")), upsertTimeoutMs);
    });
    try {
      return await Promise.race([store.upsert(entry), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Counts, logs and records how an attempt ended; an unchanged copy is counted only. A failed
   * record write is logged, not thrown.
   */
  async function finish(
    attempt: CatalogAttempt,
    fields: LogFields,
    origin: CheckOrigin,
  ): Promise<void> {
    const { stage, outcome, reason = "" } = attempt;
    report(() => {
      metrics.increment("catalog_attempts_total", { origin, stage, outcome, reason });
      const line = {
        ...fields,
        stage,
        outcome,
        reason: attempt.reason,
        detail: attempt.detail,
        url: attempt.url,
        payTo: attempt.payTo,
        payer: attempt.payer,
        bytes: attempt.fieldBytes,
      };
      if (outcome === "over_budget")
        logger.info("catalog_check_skipped", { ...line, budget: reason });
      else if (outcome === "unchanged") logger.debug("catalog_unchanged", line);
      else if (
        outcome !== "refreshed" &&
        outcome !== "stale" &&
        outcome !== "upsert_failed" &&
        outcome !== "internal_error"
      )
        logger.info("catalog_rejected", line);
    });
    // A copy equal to the stored listing tried to change nothing: counted, not a row.
    if (outcome === "unchanged") return;
    try {
      await attempts.record({
        ...attempt,
        url: attempt.url?.slice(0, bazaarLib.LIMITS.urlChars),
        detail: attempt.detail?.slice(0, DETAIL_CHARS),
      });
    } catch (error) {
      report(() => {
        logger.error("catalog_attempt_write_failed", { ...fields, error });
        metrics.increment("catalog_attempt_write_failures_total", { origin });
      });
    }
  }

  async function catalog(record: SettlementRecord, origin: SettlementOrigin): Promise<void> {
    const fields = context(record, origin);
    if (record.state !== "success") return internalError("not_success", fields, origin);
    // The success transition sets it (0019); the entry still carries it.
    if (record.ledger === undefined) return internalError("no_ledger", fields, origin);
    const paidUrl = (record.paymentPayload.resource as { url?: unknown } | undefined)?.url;
    const attempt = {
      at: now(),
      network: record.network,
      payTo: record.paymentRequirements.payTo,
      payer: record.payer,
      transaction: record.hashes.at(-1),
      url: typeof paidUrl === "string" ? paidUrl : undefined,
    };
    let stage = "validate";
    // What the attempt knew so far (key, copy, answer), for a row if a later step throws.
    let known: CatalogAttempt = { ...attempt, stage: "payment", outcome: "internal_error" };
    try {
      // Validated again rather than cached: pure, so header and catalog agree, and a late
      // `resolved` success never computed a header.
      const result = bazaar.validate(record.paymentPayload, record.paymentRequirements, options);
      if (!result) return;
      if (!result.ok) {
        // A library failure, not a bad listing.
        if (result.reason === "internal_error") {
          internalError(stage, fields, origin, result.detail);
          const failed = { stage: "payment", outcome: "internal_error", reason: stage } as const;
          return await finish({ ...attempt, ...failed, detail: result.detail }, fields, origin);
        }
        const { reason, detail, bytes: fieldBytes } = result;
        const rejected = {
          stage: "payment",
          outcome: "rejected",
          reason,
          detail,
          fieldBytes,
        } as const;
        return await finish({ ...attempt, ...rejected }, fields, origin);
      }
      stage = "normalize";
      const echoed = bazaar.normalize(result, record.paymentRequirements);
      // Built from the verified requirements, whose network is the record's.
      const key = echoed.key as CatalogKey;
      const tried = { ...attempt, key, contentHash: contentHash(echoed.resource) };
      known = { ...known, ...tried };
      // Upstream's default `mcp://tool/<name>` names the tool, not a server to ask (row 6).
      if (result.resourceUrl.startsWith("mcp:")) {
        const toolUrl = {
          stage: "seller",
          outcome: "not_askable",
          reason: "mcp_tool_url",
        } as const;
        return await finish({ ...tried, ...toolUrl }, fields, origin);
      }

      stage = "compare";
      const stored = await store.get(key);
      if (stored && bazaarLib.sameListing(stored, echoed.resource)) {
        return await finish({ ...tried, stage: "payment", outcome: "unchanged" }, fields, origin);
      }

      // From here the copy differs from the stored listing: kept to compare with the answer.
      const compared = { ...tried, copy: echoed.resource };
      known = { ...known, ...compared };

      stage = "budget";
      const host = new URL(result.resourceUrl).hostname;
      const budget = await overBudget(rateLimits, key, host, checksPerHost, attempt.at);
      if (budget) {
        const skipped = { stage: "payment", outcome: "over_budget", reason: budget } as const;
        return await finish({ ...compared, ...skipped }, fields, origin);
      }

      await checkSeller(fields, origin, {
        url: result.resourceUrl,
        input: result.discovered.discoveryInfo.input,
        key,
        ledger: record.ledger,
        compared,
      });
    } catch (error) {
      internalError(stage, fields, origin, error);
      // Still an attempt (row 23), named by the step it failed at.
      const failed = {
        stage: "payment",
        outcome: "internal_error",
        reason: stage,
        detail: String(error),
      } as const;
      await finish({ ...known, ...failed }, fields, origin);
    }
  }

  /**
   * Asks the seller about one listing key and writes its answer (0063): the steps after the
   * payment's copy showed a check is due. A step that throws is still an attempt (row 23), named
   * by the step it failed at.
   */
  async function checkSeller(
    fields: LogFields,
    origin: CheckOrigin,
    { url, input, key, ledger, compared, answer: given }: SellerCheck,
  ): Promise<CatalogAttempt> {
    // The attempt the check ended with, recorded, for the seed's report.
    const end = async (attempt: CatalogAttempt) => {
      await finish(attempt, fields, origin);
      return attempt;
    };
    let stage = "ask";
    // What the attempt knew so far (key, copy, answer), for a row if a later step throws.
    let known: Omit<CatalogAttempt, "stage" | "outcome"> = compared;
    try {
      const checkedAt = given ? given.at : now();
      // An MCP listing is checked with an MCP client (row 5), an HTTP one with one request.
      let answer: SellerAnswer;
      if (given) answer = { ok: true, paymentRequired: given.paymentRequired };
      else if (input.type === "mcp")
        answer = await askMcpSeller(
          url,
          bazaarLib.toolCall(input),
          { ...sellerLimits, maxResponseBytes: MCP_RESPONSE_BYTES },
          logger,
        );
      else
        answer = await askSeller(
          bazaarLib.sellerRequest(url, { ...input, method: key.method }),
          sellerLimits,
        );
      if (!answer.ok) {
        const { reason, detail } = answer;
        const failed = { stage: "seller", outcome: "not_askable", reason, detail } as const;
        return await end({ ...compared, ...failed });
      }

      const asked = { ...compared, answer: answer.paymentRequired };

      known = asked;

      stage = "seller";
      const listing = bazaarLib.listingFromSeller(
        answer.paymentRequired,
        { url, network: key.network, payTo: key.payTo },
        options,
      );
      if (!listing.ok) {
        const { reason, detail, bytes: fieldBytes } = listing;
        const refused = { ...asked, stage: "seller", detail, fieldBytes } as const;
        // These two are outcomes of their own, and a 402 without a listing is no usable answer.
        if (reason === "other_pay_to" || reason === "too_large")
          return await end({ ...refused, outcome: reason });
        if (reason === "no_listing")
          return await end({ ...refused, outcome: "not_askable", reason });
        return await end({ ...refused, outcome: "rejected", reason });
      }
      // The answer speaks for the listing asked about only: on a host or MCP server several sellers
      // share, one route's 402 could otherwise name another's method, route or tool and replace it.
      const answered = listing.entry.key as CatalogKey;
      if (
        answered.network !== key.network ||
        answered.payTo !== key.payTo ||
        answered.method !== key.method ||
        answered.resourceUrl !== key.resourceUrl
      ) {
        const detail = `asked ${key.method} ${key.resourceUrl}, answered ${answered.method} ${answered.resourceUrl}`;
        return await end({ ...asked, stage: "seller", outcome: "other_key", detail });
      }
      const entry: CatalogEntry = {
        key: listing.entry.key as CatalogKey,
        keyVersion: listing.entry.keyVersion,
        ledger,
        checkedAt,
        // The time of the seller's answer (0063): when the listing was last confirmed.
        resource: {
          ...listing.entry.resource,
          lastUpdated: new Date(given ? given.at : now()).toISOString(),
        },
      };
      const written = { ...asked, key: entry.key, contentHash: contentHash(entry.resource) };

      stage = "upsert";
      let outcome: UpsertOutcome;
      try {
        outcome = await upsert(entry);
      } catch (error) {
        report(() => {
          logger.error("catalog_upsert_failed", { ...fields, error });
          metrics.increment("catalog_upsert_failures_total", { origin });
        });
        return await end({ ...written, stage: "seller", outcome: "upsert_failed" });
      }
      stage = "report";
      logger.info("catalog_upserted", {
        ...fields,
        type: entry.resource.type,
        method: entry.key.method,
        resourceUrl: entry.key.resourceUrl,
        keyVersion: entry.keyVersion,
        outcome,
        droppedFields: listing.droppedFields,
        routeTemplateIgnored: listing.routeTemplateIgnored,
      });
      if (listing.routeTemplateIgnored && outcome !== "stale")
        metrics.increment("catalog_route_template_ignored_total", { origin });
      // Not awaited: the listing is stored, and a slow or failing model must not hold up the
      // check. `drain()` still waits for it, so it ends before the pools do.
      if (vectors && outcome !== "stale") {
        const vectored = vectors
          .listed(entry.key)
          .catch((error: unknown) => internalError("vector", fields, origin, error));
        inFlight.add(vectored);
        void vectored.finally(() => inFlight.delete(vectored));
      }
      if (outcome === "stale") return await end({ ...written, stage: "seller", outcome: "stale" });
      return await end({ ...written, stage: "seller", outcome: "refreshed", reason: outcome });
    } catch (error) {
      internalError(stage, fields, origin, error);
      const failed = {
        stage: "seller",
        outcome: "internal_error",
        reason: stage,
        detail: String(error),
      } as const;
      return await end({ ...known, ...failed });
    }
  }

  return {
    extensionResponses(record) {
      if (record.state !== "success") return undefined;
      try {
        const result = bazaar.validate(record.paymentPayload, record.paymentRequirements, options);
        return result && bazaar.toExtensionResponses(result);
      } catch (error) {
        internalError("header", context(record, "settle"), "settle", error);
        return { bazaar: { status: "rejected", rejectedReason: "internal_error" } };
      }
    },
    onSuccess(record, origin) {
      // Never rejects: an unhandled rejection would fail `/settle`'s process.
      const done = catalog(record, origin).catch((error: unknown) =>
        console.error("catalog_internal_error", error),
      );
      inFlight.add(done);
      void done.finally(() => inFlight.delete(done));
      return done;
    },
    async drain() {
      await Promise.allSettled([...inFlight]);
    },
    async seed(url, method) {
      const fields = { url, origin: "seed" };
      let requests = 1;
      try {
        const askedAt = now();
        const probe = await askSeller(bazaarLib.sellerRequest(url, { method }), sellerLimits);
        if (!probe.ok) {
          const { reason, detail } = probe;
          return { results: [{ url, method, outcome: "not_askable", reason, detail }], requests };
        }
        // A listing per account the seller's Stellar offers pay, on either network (decision 6).
        const accounts = new Map<string, { network: string; payTo: string }>();
        for (const { network, payTo } of probe.paymentRequired.accepts)
          if (isStellarNetwork(network)) accounts.set(`${network} ${payTo}`, { network, payTo });
        if (accounts.size === 0)
          return {
            results: [{ url, method, outcome: "not_askable", reason: "no_stellar_offer" }],
            requests,
          };
        const results: SeedResult[] = [];
        for (const { network, payTo } of accounts.values()) {
          const listing = bazaarLib.listingFromSeller(
            probe.paymentRequired,
            { url, network, payTo },
            options,
          );
          if (!listing.ok) {
            const { reason, detail } = listing;
            results.push({ url, method, network, payTo, outcome: "refused", reason, detail });
            continue;
          }
          // The listing's own method and example, which the seller's 402 declares (decision 10).
          const key = listing.entry.key as CatalogKey;
          // The probe answered this method over HTTP: it is the check's answer, not asked again.
          const answered = listing.input.type === "http" && key.method === method;
          if (!answered) requests++;
          const ended = await checkSeller({ ...fields, network }, "seed", {
            url,
            input: listing.input,
            key,
            ledger: null,
            compared: { at: now(), network, payTo, url, key },
            answer: answered ? { paymentRequired: probe.paymentRequired, at: askedAt } : undefined,
          });
          const { outcome, reason, detail } = ended;
          results.push({ url, method: key.method, network, payTo, outcome, reason, detail });
        }
        return { results, requests };
      } catch (error) {
        internalError("seed", fields, "seed", error);
        return {
          results: [{ url, method, outcome: "internal_error", detail: String(error) }],
          requests,
        };
      }
    },
  };
}
