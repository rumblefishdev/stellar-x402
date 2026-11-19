import { byName } from "@stellar-x402/metrics-catalog";
import type { SubmitterEvent } from "@stellar-x402/signer-pool";
import { describe, expect, it } from "vitest";
import type { SignerFailure } from "../src/adapters/openbao-signer.js";
import type { CatalogAttemptOutcome, CatalogAttemptStage } from "../src/ports/catalog-store.js";
import type { SettlementOrigin } from "../src/settlement/hooks.js";
import { UNSENT_REASONS } from "../src/settlement/reasons.js";
import { REFUSED_AFTER_VERIFY } from "../src/settlement/settle.js";
import { FAULT_LABELS } from "../src/spend/policy.js";

/**
 * A closed list the catalog copies from its source, without its `other`, sorted. A renamed value
 * would be written as `other`, and an alarm on it would read nothing (0027 spine AD-2).
 */
const listed = (metric: string, label: string) => {
  const def = byName(metric);
  return (def?.values?.[label] ?? def?.fieldValues?.[label] ?? [])
    .filter((value) => value !== "other")
    .sort();
};

/** Every `SubmitterEvent` type once: the compiler rejects a missing or an extra key. */
const SUBMITTER_EVENT_TYPES: Record<SubmitterEvent["type"], true> = {
  sent: true,
  "sequence-resync": true,
  "channel-quarantined": true,
  resolved: true,
  "read-retry": true,
  "send-retry": true,
  "prepared-ahead": true,
  "fee-raised": true,
  final: true,
  refused: true,
};

/** Each union's members once, as `SUBMITTER_EVENT_TYPES`: the compiler checks the keys. */
const SIGNER_FAILURES: Record<SignerFailure, true> = {
  sealed: true,
  denied: true,
  refused: true,
  error: true,
  timeout: true,
  unreachable: true,
  address_mismatch: true,
};
const ATTEMPT_OUTCOMES: Record<CatalogAttemptOutcome, true> = {
  rejected: true,
  unchanged: true,
  over_budget: true,
  not_askable: true,
  other_pay_to: true,
  other_key: true,
  too_large: true,
  refreshed: true,
  stale: true,
  upsert_failed: true,
  internal_error: true,
};
const ATTEMPT_STAGES: Record<CatalogAttemptStage, true> = { payment: true, seller: true };
const ORIGINS: Record<SettlementOrigin, true> = { settle: true, resolved: true };
const keys = (record: object) => Object.keys(record).sort();

describe("the catalog's closed lists match their sources (0027)", () => {
  it("pool_events_total's types are signer-pool's SubmitterEvent types", () => {
    expect(listed("pool_events_total", "type")).toEqual(Object.keys(SUBMITTER_EVENT_TYPES).sort());
  });

  it("spend_failure_attributed_total's faults are policy.ts's FAULT_LABELS", () => {
    expect(listed("spend_failure_attributed_total", "fault")).toEqual(
      Object.values(FAULT_LABELS).sort(),
    );
  });

  // 0139 step 4: the log fields that are Prometheus labels.
  it("settlement_reopened_total's reasons are UNSENT_REASONS", () => {
    expect(listed("settlement_reopened_total", "reason")).toEqual([...UNSENT_REASONS].sort());
  });

  it("settlement_refused_after_verify_total's reasons are REFUSED_AFTER_VERIFY", () => {
    expect(listed("settlement_refused_after_verify_total", "reason")).toEqual(
      [...REFUSED_AFTER_VERIFY].sort(),
    );
  });

  it("signer_failures_total's reasons are the signer's SignerFailure values", () => {
    expect(listed("signer_failures_total", "reason")).toEqual(keys(SIGNER_FAILURES));
  });

  it("catalog_attempts_total's outcomes, stages and origins are the catalog store's", () => {
    expect(listed("catalog_attempts_total", "outcome")).toEqual(keys(ATTEMPT_OUTCOMES));
    expect(listed("catalog_attempts_total", "stage")).toEqual(keys(ATTEMPT_STAGES));
    for (const metric of [
      "catalog_attempts_total",
      "catalog_internal_errors_total",
      "catalog_upsert_failures_total",
      "catalog_attempt_write_failures_total",
      "catalog_route_template_ignored_total",
    ])
      expect(listed(metric, "origin"), metric).toEqual(keys(ORIGINS));
  });
});
