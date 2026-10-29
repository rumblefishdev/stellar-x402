import { createHash } from "node:crypto";
import * as bazaarLib from "@stellar-x402/bazaar";
import type { DiscoveryResource } from "@x402/extensions/bazaar";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
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
import { askMcpSeller, askSeller } from "./seller-check.js";

export type BazaarApi = Pick<typeof bazaarLib, "validate" | "normalize" | "toExtensionResponses">;

export interface CatalogerDeps {
  store: CatalogStore;
  attempts: CatalogAttemptStore;
  /** Where the seller-check budgets are counted. */
  rateLimits: Pick<RateLimitStore, "hit">;
  logger: Logger;
  metrics: Metrics;
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
}

export type Cataloger = Pick<SettlementHooks, "extensionResponses" | "onSuccess"> & {
  /** Resolves once every in-flight `onSuccess` has settled (tests, graceful shutdown). */
  drain(): Promise<void>;
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
/** The steps of `catalog` taken once the seller is asked: a failure there is the seller stage's. */
const SELLER_STEPS = ["ask", "seller", "upsert", "report"];

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
  const internalError = (
    stage: string,
    record: SettlementRecord,
    origin: SettlementOrigin,
    error?: unknown,
  ) =>
    report(() => {
      logger.error("catalog_internal_error", { ...context(record, origin), stage, error });
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
    record: SettlementRecord,
    origin: SettlementOrigin,
  ): Promise<void> {
    const { stage, outcome, reason = "" } = attempt;
    report(() => {
      metrics.increment("catalog_attempts_total", { origin, stage, outcome, reason });
      const fields = {
        ...context(record, origin),
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
        logger.info("catalog_check_skipped", { ...fields, budget: reason });
      else if (outcome === "unchanged") logger.debug("catalog_unchanged", fields);
      else if (
        outcome !== "refreshed" &&
        outcome !== "stale" &&
        outcome !== "upsert_failed" &&
        outcome !== "internal_error"
      )
        logger.info("catalog_rejected", fields);
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
        logger.error("catalog_attempt_write_failed", { ...context(record, origin), error });
        metrics.increment("catalog_attempt_write_failures_total", { origin });
      });
    }
  }

  async function catalog(record: SettlementRecord, origin: SettlementOrigin): Promise<void> {
    if (record.state !== "success") return internalError("not_success", record, origin);
    // The success transition sets it (0019); the entry still carries it.
    if (record.ledger === undefined) return internalError("no_ledger", record, origin);
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
          internalError(stage, record, origin, result.detail);
          const failed = { stage: "payment", outcome: "internal_error", reason: stage } as const;
          return await finish({ ...attempt, ...failed, detail: result.detail }, record, origin);
        }
        const { reason, detail, bytes: fieldBytes } = result;
        const rejected = {
          stage: "payment",
          outcome: "rejected",
          reason,
          detail,
          fieldBytes,
        } as const;
        return await finish({ ...attempt, ...rejected }, record, origin);
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
        return await finish({ ...tried, ...toolUrl }, record, origin);
      }

      stage = "compare";
      const stored = await store.get(key);
      if (stored && bazaarLib.sameListing(stored, echoed.resource)) {
        return await finish({ ...tried, stage: "payment", outcome: "unchanged" }, record, origin);
      }

      // From here the copy differs from the stored listing: kept to compare with the answer.
      const compared = { ...tried, copy: echoed.resource };
      known = { ...known, ...compared };

      stage = "budget";
      const host = new URL(result.resourceUrl).hostname;
      const budget = await overBudget(rateLimits, key, host, checksPerHost, attempt.at);
      if (budget) {
        const skipped = { stage: "payment", outcome: "over_budget", reason: budget } as const;
        return await finish({ ...compared, ...skipped }, record, origin);
      }

      stage = "ask";
      const checkedAt = now();
      // An MCP listing is checked with an MCP client (row 5), an HTTP one with one request.
      const input = result.discovered.discoveryInfo.input;
      const answer =
        input.type === "mcp"
          ? await askMcpSeller(result.resourceUrl, bazaarLib.toolCall(input), {
              ...sellerLimits,
              maxResponseBytes: MCP_RESPONSE_BYTES,
            })
          : await askSeller(
              bazaarLib.sellerRequest(result.resourceUrl, { ...input, method: key.method }),
              sellerLimits,
            );
      if (!answer.ok) {
        const { reason, detail } = answer;
        const failed = { stage: "seller", outcome: "not_askable", reason, detail } as const;
        return await finish({ ...compared, ...failed }, record, origin);
      }

      const asked = { ...compared, answer: answer.paymentRequired };

      known = { ...known, ...asked };

      stage = "seller";
      const listing = bazaarLib.listingFromSeller(
        answer.paymentRequired,
        { url: result.resourceUrl, network: key.network, payTo: key.payTo },
        options,
      );
      if (!listing.ok) {
        const { reason, detail, bytes: fieldBytes } = listing;
        const refused = { ...asked, stage: "seller", detail, fieldBytes } as const;
        // These two are outcomes of their own, and a 402 without a listing is no usable answer.
        if (reason === "other_pay_to" || reason === "too_large")
          return await finish({ ...refused, outcome: reason }, record, origin);
        if (reason === "no_listing")
          return await finish({ ...refused, outcome: "not_askable", reason }, record, origin);
        return await finish({ ...refused, outcome: "rejected", reason }, record, origin);
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
        return await finish(
          { ...asked, stage: "seller", outcome: "other_key", detail },
          record,
          origin,
        );
      }
      const entry: CatalogEntry = {
        key: listing.entry.key as CatalogKey,
        keyVersion: listing.entry.keyVersion,
        ledger: record.ledger,
        checkedAt,
        // The time of the seller's answer (0063): when the listing was last confirmed.
        resource: { ...listing.entry.resource, lastUpdated: new Date(now()).toISOString() },
      };
      const written = { ...asked, key: entry.key, contentHash: contentHash(entry.resource) };

      stage = "upsert";
      let outcome: UpsertOutcome;
      try {
        outcome = await upsert(entry);
      } catch (error) {
        report(() => {
          logger.error("catalog_upsert_failed", { ...context(record, origin), error });
          metrics.increment("catalog_upsert_failures_total", { origin });
        });
        return await finish(
          { ...written, stage: "seller", outcome: "upsert_failed" },
          record,
          origin,
        );
      }
      stage = "report";
      logger.info("catalog_upserted", {
        ...context(record, origin),
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
      if (outcome === "stale")
        await finish({ ...written, stage: "seller", outcome: "stale" }, record, origin);
      else
        await finish(
          { ...written, stage: "seller", outcome: "refreshed", reason: outcome },
          record,
          origin,
        );
    } catch (error) {
      internalError(stage, record, origin, error);
      // Still an attempt (row 23), named by the step it failed at.
      const failed = {
        stage: SELLER_STEPS.includes(stage) ? "seller" : "payment",
        outcome: "internal_error",
        reason: stage,
        detail: String(error),
      } as const;
      await finish({ ...known, ...failed }, record, origin);
    }
  }

  return {
    extensionResponses(record) {
      if (record.state !== "success") return undefined;
      try {
        const result = bazaar.validate(record.paymentPayload, record.paymentRequirements, options);
        return result && bazaar.toExtensionResponses(result);
      } catch (error) {
        internalError("header", record, "settle", error);
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
  };
}
