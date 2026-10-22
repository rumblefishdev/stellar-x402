import { describe, expect, it } from "vitest";
import { attemptUpdates } from "../src/settlement/records.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("attemptUpdates (0019 decision 7)", () => {
  it("marks every attempt before the last dead with txBadSeq, and the landed one landed", () => {
    const attempts = [
      { hash: A, sent: "yes" as const },
      { hash: B, sent: "yes" as const },
    ];
    expect(attemptUpdates(attempts, { status: "success", channel: "GC" })).toEqual([
      { hash: A, state: "dead", errorCode: "txBadSeq", channel: "GC" },
      { hash: B, state: "landed", channel: "GC" },
    ]);
    expect(attemptUpdates(attempts, { status: "failed", channel: "GC" })[1]?.state).toBe("landed");
  });

  it("marks a refused or expired attempt dead, with the network's code", () => {
    const attempts = [{ hash: A, sent: "yes" as const }];
    expect(
      attemptUpdates(attempts, {
        status: "rejected",
        channel: "GC",
        errorCode: "txInsufficientFee",
      }),
    ).toEqual([{ hash: A, state: "dead", errorCode: "txInsufficientFee", channel: "GC" }]);
    expect(attemptUpdates(attempts, { status: "expired", channel: "GC" })).toEqual([
      { hash: A, state: "dead", channel: "GC" },
    ]);
  });

  it("keeps a pending attempt sent or unknown, as the pool saw the send", () => {
    expect(
      attemptUpdates([{ hash: A, sent: "yes" }], { status: "pending", channel: "GC" }),
    ).toEqual([{ hash: A, state: "sent", channel: "GC" }]);
    expect(
      attemptUpdates([{ hash: A, sent: "unknown" }], { status: "pending", channel: "GC" }),
    ).toEqual([{ hash: A, state: "unknown", channel: "GC" }]);
  });

  it("after a rejected submit: an uncertain send is unknown, one never sent is dead", () => {
    const error = new Error("boom");
    expect(attemptUpdates([{ hash: A, sent: "unknown" }], { error })).toEqual([
      { hash: A, state: "unknown" },
    ]);
    expect(
      attemptUpdates(
        [
          { hash: A, sent: "yes" },
          { hash: B, sent: "no" },
        ],
        { error },
      ),
    ).toEqual([
      { hash: A, state: "dead", errorCode: "txBadSeq" },
      { hash: B, state: "dead" },
    ]);
    // Accepted, then an unexpected error: it may still land.
    expect(attemptUpdates([{ hash: A, sent: "yes" }], { error })).toEqual([
      { hash: A, state: "sent" },
    ]);
  });
});
