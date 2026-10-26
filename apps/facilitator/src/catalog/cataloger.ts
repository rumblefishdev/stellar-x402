import * as bazaarLib from "@stellar-x402/bazaar";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type {
  CatalogEntry,
  CatalogKey,
  CatalogStore,
  SettlementRecord,
  UpsertOutcome,
} from "../ports/index.js";
import type { SettlementHooks, SettlementOrigin } from "../settlement/hooks.js";

export type BazaarApi = Pick<typeof bazaarLib, "validate" | "normalize" | "toExtensionResponses">;

export interface CatalogerDeps {
  store: CatalogStore;
  logger: Logger;
  metrics: Metrics;
  /** Injectable for fault-injection tests; the real package otherwise. */
  bazaar?: BazaarApi;
  /** A slower write counts as failed, so a hung store can't pile up writes or block `drain()`. */
  upsertTimeoutMs?: number;
  /** Development only: list local, private and IP resource URLs too (`CATALOG_LIST_LOCAL`). */
  listLocal?: boolean;
}

export type Cataloger = Pick<SettlementHooks, "extensionResponses" | "onSuccess"> & {
  /** Resolves once every in-flight `onSuccess` has settled (tests, graceful shutdown). */
  drain(): Promise<void>;
};

/**
 * Cataloging after a successful settlement (AD-8, AD-19), plugged in through `SettlementHooks`.
 * The header is computed synchronously before the settle response; the catalog write runs after
 * it. Neither ever throws into `/settle`, fetches a seller URL or compiles a seller schema.
 */
export function createCataloger({
  store,
  logger,
  metrics,
  bazaar = bazaarLib,
  upsertTimeoutMs = 10_000,
  listLocal = false,
}: CatalogerDeps): Cataloger {
  const inFlight = new Set<Promise<void>>();
  const options = { listLocal };

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

  async function catalog(record: SettlementRecord, origin: SettlementOrigin): Promise<void> {
    if (record.state !== "success") return internalError("not_success", record, origin);
    // The success transition sets it (0019); without it writes can't be ordered.
    if (record.ledger === undefined) return internalError("no_ledger", record, origin);
    let stage = "validate";
    try {
      // Validated again rather than cached: pure, so header and catalog agree, and a late
      // `resolved` success never computed a header.
      const result = bazaar.validate(record.paymentPayload, record.paymentRequirements, options);
      if (!result) return;
      if (!result.ok) {
        // A library failure, not a bad listing.
        if (result.reason === "internal_error")
          return internalError(stage, record, origin, result.detail);
        logger.info("catalog_rejected", {
          ...context(record, origin),
          reason: result.reason,
          detail: result.detail,
        });
        metrics.increment("catalog_rejections_total", { origin, reason: result.reason });
        return;
      }
      stage = "normalize";
      const { key, keyVersion, resource } = bazaar.normalize(result, record.paymentRequirements);
      const entry: CatalogEntry = {
        // Built from the verified requirements, whose network is the record's.
        key: key as CatalogKey,
        keyVersion,
        ledger: record.ledger,
        // When the record turned `success`, so a repeated call writes the same state.
        resource: { ...resource, lastUpdated: new Date(record.updatedAt).toISOString() },
      };
      stage = "upsert";
      let outcome: UpsertOutcome;
      try {
        outcome = await upsert(entry);
      } catch (error) {
        report(() => {
          logger.error("catalog_upsert_failed", { ...context(record, origin), error });
          metrics.increment("catalog_upsert_failures_total", { origin });
        });
        return;
      }
      stage = "report";
      logger.info("catalog_upserted", {
        ...context(record, origin),
        type: entry.resource.type,
        method: entry.key.method,
        resourceUrl: entry.key.resourceUrl,
        keyVersion: entry.keyVersion,
        outcome,
        routeTemplateIgnored: result.routeTemplateIgnored,
      });
      metrics.increment("catalog_upserts_total", { origin, outcome });
      if (result.routeTemplateIgnored && outcome !== "stale")
        metrics.increment("catalog_route_template_ignored_total", { origin });
    } catch (error) {
      internalError(stage, record, origin, error);
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
