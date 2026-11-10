import { byName } from "@stellar-x402/metrics-catalog";
import type { SubmitterEvent } from "@stellar-x402/signer-pool";
import { describe, expect, it } from "vitest";
import { FAULT_LABELS } from "../src/spend/policy.js";

/**
 * A closed list the catalog copies from its source, without its `other`, sorted. A renamed value
 * would be written as `other`, and an alarm on it would read nothing (0027 spine AD-2).
 */
const listed = (metric: string, dim: string) =>
  (byName(metric)?.values?.[dim] ?? []).filter((value) => value !== "other").sort();

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

describe("the catalog's closed lists match their sources (0027)", () => {
  it("pool_events_total's types are signer-pool's SubmitterEvent types", () => {
    expect(listed("pool_events_total", "type")).toEqual(Object.keys(SUBMITTER_EVENT_TYPES).sort());
  });

  it("spend_failure_attributed_total's faults are policy.ts's FAULT_LABELS", () => {
    expect(listed("spend_failure_attributed_total", "fault")).toEqual(
      Object.values(FAULT_LABELS).sort(),
    );
  });
});
