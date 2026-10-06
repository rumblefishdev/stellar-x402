import { describe, expect, it } from "vitest";
import { LedgerClock, SubmitterStats } from "../src/index.js";

/** An RPC whose `getLatestLedger` answers from a script: a sequence, or "fail". */
function scripted(answers: (number | "fail")[]) {
  let last = 0;
  return {
    calls: 0,
    async getLatestLedger() {
      this.calls++;
      const a = answers.shift() ?? last;
      if (a === "fail") throw new Error("fetch failed");
      last = a;
      return { sequence: a } as never;
    },
  };
}

describe("LedgerClock", () => {
  it("keeps waiters waiting through failed polls and resolves them once a poll succeeds", async () => {
    const rpc = scripted(["fail", "fail", 7]);
    const clock = new LedgerClock(rpc, 1, async () => {});
    expect(await clock.next(0)).toBe(7);
    expect(rpc.calls).toBe(3);
  });

  it("ends a wait at its deadline when no ledger can be read", async () => {
    let t = 0;
    const clock = new LedgerClock(
      scripted(Array(100).fill("fail")),
      1000,
      async (ms) => {
        t += ms;
      },
      () => t,
    );
    expect(await clock.next(0, 5_000)).toBe(0);
    expect(t).toBeGreaterThanOrEqual(5_000);
  });

  it("following() waits past the network's current ledger, not a stale one", async () => {
    const rpc = scripted([10, 20, 20, 21]);
    const clock = new LedgerClock(rpc, 1, async () => {});
    expect(await clock.next(0)).toBe(10); // `current` is now 10, while the network is at 20
    expect(await clock.following()).toBe(21);
  });
});

describe("SubmitterStats", () => {
  it("keeps landings for the last 20 ledgers", () => {
    const stats = new SubmitterStats();
    for (let ledger = 1; ledger <= 25; ledger++)
      stats.record({
        type: "final",
        result: { status: "success", channel: "C", ledger },
        queuedMs: 0,
        totalMs: 0,
      });
    const kept = Object.keys(stats.snapshot({ channels: 1, busy: 0, queued: 0 }).landingsByLedger);
    expect(kept.map(Number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6));
  });
});
