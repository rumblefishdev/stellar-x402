import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySettlementStore } from "../src/adapters/memory.js";
import { jsonLogger } from "../src/logger.js";
import { memoryMetrics } from "../src/metrics.js";
import { LEASE_SKEW_MARGIN_MS } from "../src/ports/index.js";
import { createLeaseKeeper, leaseName, type LeaseKeeperDeps } from "../src/settlement/lease.js";

const network = "stellar:testnet" as const;
const TTL = 30_000;

/** A keeper on `store` with its own clock, which the test moves. */
function keeper(store: MemorySettlementStore, overrides: Partial<LeaseKeeperDeps> = {}) {
  const lines: string[] = [];
  const clock = { now: 1_000_000 };
  const metrics = memoryMetrics();
  const lease = createLeaseKeeper({
    store,
    network,
    ttlMs: TTL,
    logger: jsonLogger("info", (line) => lines.push(line)),
    metrics,
    now: () => clock.now,
    ...overrides,
  });
  const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lease, clock, metrics, events };
}

describe("lease keeper (0025)", () => {
  afterEach(() => vi.useRealTimers());

  it("names the lease after the network's channel set", () => {
    expect(leaseName("stellar:pubnet")).toBe("stellar:pubnet:channels");
  });

  it("gives the lease to the first process and keeps a second one out", async () => {
    const store = new MemorySettlementStore();
    const a = keeper(store);
    const b = keeper(store);
    await a.lease.runOnce();
    await b.lease.runOnce();
    expect([a.lease.held(), b.lease.held()]).toEqual([true, false]);
    expect(a.events()).toMatchObject([
      { event: "lease_acquired", network, lease: "stellar:testnet:channels" },
    ]);
    // Waiting for a lease another process holds is the normal case: nothing is logged.
    expect(b.events()).toEqual([]);
    expect(a.metrics.value("lease_changes_total", { held: "true" })).toBe(1);
  });

  it("renews the held lease, so a second process stays out past the first TTL", async () => {
    const store = new MemorySettlementStore();
    const a = keeper(store);
    const b = keeper(store);
    await a.lease.runOnce();
    a.clock.now += TTL / 3;
    await a.lease.runOnce();
    b.clock.now = a.clock.now + TTL - 1;
    await b.lease.runOnce();
    a.clock.now = b.clock.now;
    expect([a.lease.held(), b.lease.held()]).toEqual([true, false]);
  });

  it("lets a new process take the lease once a crashed holder's TTL and the margin passed", async () => {
    const store = new MemorySettlementStore();
    const crashed = keeper(store);
    await crashed.lease.runOnce();
    const next = keeper(store);
    next.clock.now = crashed.clock.now + TTL + LEASE_SKEW_MARGIN_MS;
    await next.lease.runOnce();
    expect(next.lease.held()).toBe(false);
    next.clock.now += 1;
    await next.lease.runOnce();
    expect(next.lease.held()).toBe(true);
  });

  it("drops the lease at once when a renewal finds another holder", async () => {
    const store = new MemorySettlementStore();
    const a = keeper(store);
    await a.lease.runOnce();
    // A holder whose clock runs ahead takes over early (the skew margin is a later decision).
    const b = keeper(store);
    b.clock.now = a.clock.now + TTL + LEASE_SKEW_MARGIN_MS + 1;
    await b.lease.runOnce();
    a.clock.now += TTL / 3;
    await a.lease.runOnce();
    expect([a.lease.held(), b.lease.held()]).toEqual([false, true]);
    expect(a.events().at(-1)).toMatchObject({ event: "lease_lost", reason: "taken" });
    expect(a.metrics.value("lease_changes_total", { held: "false" })).toBe(1);
  });

  it("drops the lease at once when the store fails a renewal, and takes it back later", async () => {
    const store = new MemorySettlementStore();
    const { lease, clock, events } = keeper(store);
    await lease.runOnce();
    const renew = vi.spyOn(store, "renewLease").mockRejectedValueOnce(new Error("store down"));
    clock.now += TTL / 3;
    await lease.runOnce();
    expect(renew).toHaveBeenCalledTimes(1);
    // Still ours in the store until its TTL, but the process can't know that (decision 3).
    expect(lease.held()).toBe(false);
    expect(events().at(-1)).toMatchObject({ event: "lease_lost", reason: "store_failed" });
    clock.now += TTL / 3;
    await lease.runOnce();
    expect(lease.held()).toBe(true);
  });

  it("logs a failed attempt to take the lease and keeps trying", async () => {
    const store = new MemorySettlementStore();
    vi.spyOn(store, "acquireLease").mockRejectedValueOnce(new Error("store down"));
    const { lease, events } = keeper(store);
    await lease.runOnce();
    expect(lease.held()).toBe(false);
    expect(events()).toMatchObject([{ event: "lease_acquire_failed" }]);
    await lease.runOnce();
    expect(lease.held()).toBe(true);
  });

  it("ends held() at its own expiry while a renewal hangs", async () => {
    const store = new MemorySettlementStore();
    const { lease, clock } = keeper(store);
    await lease.runOnce();
    vi.spyOn(store, "renewLease").mockReturnValueOnce(new Promise(() => {}));
    clock.now += TTL / 3;
    void lease.runOnce();
    clock.now += TTL - TTL / 3 - 1;
    expect(lease.held()).toBe(true);
    clock.now += 1;
    expect(lease.held()).toBe(false);
  });

  it("logs a renewal past its own expiry as expired, not taken", async () => {
    const store = new MemorySettlementStore();
    const { lease, clock, events } = keeper(store);
    await lease.runOnce();
    clock.now += TTL + 1;
    await lease.runOnce();
    expect(events().at(-1)).toMatchObject({ event: "lease_lost", reason: "expired" });
  });

  it("gives a held lease up on release, so another process takes it at once (decision 10)", async () => {
    const store = new MemorySettlementStore();
    const a = keeper(store);
    const b = keeper(store);
    await a.lease.runOnce();
    await a.lease.release();
    expect(a.lease.held()).toBe(false);
    expect(a.events().at(-1)).toMatchObject({ event: "lease_released" });
    b.clock.now = a.clock.now;
    await b.lease.runOnce();
    expect(b.lease.held()).toBe(true);
  });

  it("releases nothing it doesn't hold, and never rejects when the store fails", async () => {
    const store = new MemorySettlementStore();
    const releaseLease = vi.spyOn(store, "releaseLease");
    const idle = keeper(store);
    await idle.lease.release();
    expect(releaseLease).not.toHaveBeenCalled();
    const { lease, events } = keeper(store);
    await lease.runOnce();
    releaseLease.mockRejectedValueOnce(new Error("store down"));
    await expect(lease.release()).resolves.toBeUndefined();
    expect(events().at(-1)).toMatchObject({ event: "lease_release_failed" });
    expect(lease.held()).toBe(false);
  });

  it("tries at start and then every third of the TTL, until closed", async () => {
    vi.useFakeTimers();
    const store = new MemorySettlementStore();
    const acquire = vi.spyOn(store, "acquireLease");
    const renew = vi.spyOn(store, "renewLease");
    const { lease } = keeper(store, { now: Date.now });
    await lease.start();
    expect([acquire.mock.calls.length, renew.mock.calls.length]).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(TTL / 3 - 1);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TTL);
    expect(renew).toHaveBeenCalledTimes(4);
    expect(lease.held()).toBe(true);
    await lease.close();
    await vi.advanceTimersByTimeAsync(10 * TTL);
    expect(renew).toHaveBeenCalledTimes(4);
  });

  it("waits for an attempt under way when closed, and starts none after it", async () => {
    vi.useFakeTimers();
    const store = new MemorySettlementStore();
    const { lease } = keeper(store, { now: Date.now });
    await lease.start();
    let release!: () => void;
    const renew = vi.spyOn(store, "renewLease").mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return true;
    });
    await vi.advanceTimersByTimeAsync(TTL / 3);
    let closed = false;
    const closing = lease.close().then(() => (closed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    release();
    await closing;
    await vi.advanceTimersByTimeAsync(10 * TTL);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
