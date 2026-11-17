import { ChannelPool } from "@stellar-x402/signer-pool";
import { describe, expect, it } from "vitest";
import { jsonLogger } from "../src/logger.js";
import type { SettlementAttempt, SettlementRecord } from "../src/ports/index.js";
import { createChannelHolder } from "../src/settlement/open-channels.js";

/**
 * 0090: a new process holds back the channels the previous one left a transaction open on, until
 * reconciliation answers for it. The store is a map; the pool is the real one.
 */

type Row = { record: SettlementRecord; attempts: SettlementAttempt[] };

function fakeStore(rows: Row[]) {
  const byKey = new Map<string, Row>(rows.map((row) => [row.record.key, row]));
  return {
    rows: byKey,
    async listNonFinal() {
      return [...byKey.values()]
        .map((r) => r.record)
        .filter((r) => !["success", "failed", "expired", "rejected"].includes(r.state));
    },
    async attempts(key: SettlementRecord["key"]) {
      return byKey.get(key)?.attempts ?? [];
    },
    async get(key: SettlementRecord["key"]) {
      return byKey.get(key)?.record;
    },
  };
}

const row = (key: string, state: string, attempts: SettlementAttempt[]): Row => ({
  record: {
    key,
    state,
    payer: "G",
    paymentPayload: { payload: {} },
  } as unknown as SettlementRecord,
  attempts,
});

const holderFor = (store: ReturnType<typeof fakeStore>, pool: ChannelPool, ledger = 100) =>
  createChannelHolder({
    store,
    network: "stellar:testnet",
    channels: ["C1", "C2", "C3"],
    latestLedger: async () => ledger,
    hold: (address, until) => pool.hold(address, until),
    logger: jsonLogger("error", () => {}),
    intervalMs: 5,
    now: () => 1_000_000,
  });

const settled = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("createChannelHolder (0090)", () => {
  it("holds only channels with an attempt that may still land", async () => {
    const store = fakeStore([
      row("open", "pending", [
        { hash: "a", state: "sent", channel: "C1", maxLedger: 150 },
        // Past its bound: it can't land any more.
        { hash: "b", state: "unknown", channel: "C2", maxLedger: 99 },
      ]),
      // Already answered by the network.
      row("dead", "signed", [{ hash: "c", state: "dead", channel: "C3", maxLedger: 150 }]),
      // Not one of ours.
      row("other", "signed", [{ hash: "d", state: "sent", channel: "CX", maxLedger: 150 }]),
    ]);
    const pool = new ChannelPool(["C1", "C2", "C3"]);
    const holder = holderFor(store, pool);
    await holder.holdOpen();
    expect(pool.held).toBe(1);
    const free = [await pool.acquire(), await pool.acquire()].map((c) => c.address);
    expect(free.sort()).toEqual(["C2", "C3"]);
    holder.close();
  });

  it("frees the channel once reconciliation marks the attempt dead", async () => {
    const store = fakeStore([
      row("k", "pending", [{ hash: "a", state: "sent", channel: "C1", maxLedger: 150 }]),
    ]);
    const pool = new ChannelPool(["C1"]);
    const holder = holderFor(store, pool);
    await holder.holdOpen();
    const waiter = pool.acquire();
    await settled();
    expect(pool.queued).toBe(1);
    store.rows.get("k")!.attempts[0]!.state = "dead";
    expect((await waiter).address).toBe("C1");
    holder.close();
  });

  it("frees the channel once its record is final, whatever its other attempts say", async () => {
    // `land()` marks the attempt that landed and leaves the record's others as they were.
    const store = fakeStore([
      row("k", "pending", [
        { hash: "a", state: "sent", channel: "C1", maxLedger: 150 },
        { hash: "b", state: "sent", channel: "C1", maxLedger: 150 },
      ]),
    ]);
    const pool = new ChannelPool(["C1"]);
    const holder = holderFor(store, pool);
    await holder.holdOpen();
    const waiter = pool.acquire();
    store.rows.get("k")!.attempts[0]!.state = "landed";
    await settled();
    expect(pool.queued).toBe(1);
    store.rows.get("k")!.record.state = "success";
    expect((await waiter).address).toBe("C1");
    holder.close();
  });

  it("holds an attempt by its time bound when it has no ledger bound", async () => {
    const store = fakeStore([
      row("open", "pending", [{ hash: "a", state: "stored", channel: "C1", maxTime: 1_001 }]),
      row("past", "pending", [{ hash: "b", state: "stored", channel: "C2", maxTime: 999 }]),
    ]);
    const pool = new ChannelPool(["C1", "C2"]);
    const holder = holderFor(store, pool);
    await holder.holdOpen();
    expect((await pool.acquire()).address).toBe("C2");
    expect(pool.held).toBe(1);
    holder.close();
  });

  it("rejects when the store can't be read, so the lease isn't taken up", async () => {
    const store = fakeStore([]);
    store.listNonFinal = async () => {
      throw new Error("store down");
    };
    const pool = new ChannelPool(["C1"]);
    await expect(holderFor(store, pool).holdOpen()).rejects.toThrow("store down");
  });

  it("keeps the hold while a re-read fails", async () => {
    const store = fakeStore([
      row("k", "pending", [{ hash: "a", state: "sent", channel: "C1", maxLedger: 150 }]),
    ]);
    const pool = new ChannelPool(["C1"]);
    const holder = holderFor(store, pool);
    await holder.holdOpen();
    const get = store.get;
    store.get = async () => {
      throw new Error("store down");
    };
    const waiter = pool.acquire();
    await settled();
    expect(pool.queued).toBe(1);
    store.get = get;
    store.rows.get("k")!.attempts[0]!.state = "dead";
    expect((await waiter).address).toBe("C1");
    holder.close();
  });
});
