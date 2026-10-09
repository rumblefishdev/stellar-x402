import * as bazaarLib from "@stellar-x402/bazaar";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import type { CatalogEntry, CatalogStore, SettlementRecord } from "../ports/index.js";
import type { SettlementHooks, SettlementOrigin } from "../settlement/hooks.js";

export type BazaarApi = Pick<typeof bazaarLib, "validate" | "normalize" | "toExtensionResponses">;

export interface CatalogerDeps {
  store: CatalogStore;
  logger: Logger;
  metrics: Metrics;
  /** Injectable for fault-injection tests; the real package otherwise. */
  bazaar?: BazaarApi;
  /** Development only: catalog `http:` resources too (`packages/bazaar` `allowHttp`). */
  allowHttp?: boolean;
}

export type Cataloger = Pick<SettlementHooks, "extensionResponses" | "onSuccess"> & {
  /** Resolves once every in-flight `onSuccess` has settled (tests, graceful shutdown in 0025). */
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
  allowHttp = false,
}: CatalogerDeps): Cataloger {
  const options = { allowHttp };
  const inFlight = new Set<Promise<void>>();

  const context = (record: SettlementRecord, origin?: SettlementOrigin) => ({
    network: record.network,
    settlementKey: record.key,
    transaction: record.hashes.at(-1),
    origin,
  });
  const internalError = (stage: string, record: SettlementRecord, error?: unknown) => {
    logger.error("catalog_internal_error", { ...context(record), stage, error });
    metrics.increment("catalog_internal_errors_total", { stage });
  };

  async function catalog(record: SettlementRecord, origin: SettlementOrigin): Promise<void> {
    if (record.state !== "success") return internalError("not_success", record);
    let stage = "validate";
    try {
      // Validated again rather than cached: pure, so header and catalog agree, and a late
      // `resolved` success never computed a header.
      const result = bazaar.validate(record.paymentPayload, record.paymentRequirements, options);
      if (!result) return;
      if (!result.ok) {
        logger.info("catalog_rejected", {
          ...context(record, origin),
          reason: result.reason,
          detail: result.detail,
        });
        metrics.increment("catalog_rejections_total", { origin, reason: result.reason });
        return;
      }
      stage = "normalize";
      const normalized = bazaar.normalize(result, record.paymentRequirements);
      stage = "map";
      if (
        normalized.key.network !== record.network ||
        normalized.key.payTo !== record.paymentRequirements.payTo
      )
        throw new Error("catalog key does not match the settlement record");
      const bazaarBlock = normalized.resource.extensions?.bazaar;
      const entry: CatalogEntry = {
        key: { ...normalized.key, network: record.network },
        keyVersion: normalized.keyVersion,
        resource: {
          ...normalized.resource,
          // Only the bazaar block, even if normalize() ever let another client extension through.
          extensions: bazaarBlock === undefined ? undefined : { bazaar: bazaarBlock },
          // When the record turned `success`, so a repeated call writes the same state.
          lastUpdated: new Date(record.updatedAt).toISOString(),
        },
      };
      if (result.routeTemplateIgnored)
        metrics.increment("catalog_route_template_ignored_total", { origin });
      stage = "upsert";
      let outcome;
      try {
        outcome = await store.upsert(entry);
      } catch (error) {
        logger.error("catalog_upsert_failed", { ...context(record, origin), error });
        metrics.increment("catalog_upsert_failures_total", { origin });
        return;
      }
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
    } catch (error) {
      internalError(stage, record, error);
    }
  }

  return {
    extensionResponses(record) {
      if (record.state !== "success") return undefined;
      try {
        const result = bazaar.validate(record.paymentPayload, record.paymentRequirements, options);
        return result && bazaar.toExtensionResponses(result);
      } catch (error) {
        internalError("header", record, error);
        return { bazaar: { status: "rejected", rejectedReason: "internal_error" } };
      }
    },
    onSuccess(record, origin) {
      // Never rejects: an unhandled rejection would fail `/settle`'s process.
      const done = catalog(record, origin).catch(() => {});
      inFlight.add(done);
      void done.finally(() => inFlight.delete(done));
      return done;
    },
    async drain() {
      await Promise.allSettled([...inFlight]);
    },
  };
}
