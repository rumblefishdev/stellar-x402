import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { ChannelPool, NOT_FOUND_MARGIN_LEDGERS } from "@stellar-x402/signer-pool";
import { describe, expect, it } from "vitest";
import { jsonLogger } from "../src/logger.js";
import type { SettlementAttempt, SettlementRecord } from "../src/ports/index.js";
import { createChannelHolder } from "../src/settlement/open-channels.js";
import { transferPayload } from "./payment.js";

const PAYER = Keypair.random().publicKey();
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 7));

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

/** The network as the holder reads it: ledger 100, closed at 1,000 s; tests move it. */
const network = () => ({ sequence: 100, closeTime: 1_000, reads: 0, down: false });

const holderFor = (
  store: ReturnType<typeof fakeStore>,
  pool: ChannelPool,
  net = network(),
  lines: string[] = [],
) =>
  createChannelHolder({
    store,
    network: "stellar:testnet",
    channels: ["C1", "C2", "C3"],
    latestLedger: async () => {
      net.reads++;
      if (net.down) throw new Error("rpc down");
      return { sequence: net.sequence, closeTime: net.closeTime };
    },
    hold: (address, until) => pool.hold(address, until),
    logger: jsonLogger("info", (line) => lines.push(line)),
    intervalMs: 5,
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

  it("ends a hold once the network is past the bound by the NOT_FOUND margin (review D1)", async () => {
    // Reconciliation never answers: the hash is past the RPC's history, or the sweep stopped.
    const store = fakeStore([
      row("k", "pending", [{ hash: "a", state: "sent", channel: "C1", maxLedger: 150 }]),
    ]);
    const pool = new ChannelPool(["C1"]);
    const net = network();
    const holder = holderFor(store, pool, net);
    await holder.holdOpen();
    const waiter = pool.acquire();
    // Past the bound, but not by the margin: a read this close may miss a landing.
    net.sequence = 150 + NOT_FOUND_MARGIN_LEDGERS - 1;
    await settled();
    expect(pool.queued).toBe(1);
    net.sequence = 150 + NOT_FOUND_MARGIN_LEDGERS;
    expect((await waiter).address).toBe("C1");
    expect(store.rows.get("k")!.attempts[0]!.state).toBe("sent");
    holder.close();
  });

  it("keeps the hold while the ledger can't be read", async () => {
    const store = fakeStore([
      row("k", "pending", [{ hash: "a", state: "sent", channel: "C1", maxLedger: 150 }]),
    ]);
    const pool = new ChannelPool(["C1"]);
    const net = network();
    const holder = holderFor(store, pool, net);
    await holder.holdOpen();
    net.down = true;
    net.sequence = 1_000;
    const waiter = pool.acquire();
    await settled();
    expect(pool.queued).toBe(1);
    net.down = false;
    expect((await waiter).address).toBe("C1");
    holder.close();
  });

  it("bounds a hash stored without bounds by its payer's auth expiry", async () => {
    const payload = (expiration: number) =>
      transferPayload(
        {
          payer: PAYER,
          payTo: PAYER,
          requirements: {
            scheme: "exact",
            network: "stellar:testnet",
            asset: ASSET,
            amount: "1",
            payTo: PAYER,
            maxTimeoutSeconds: 60,
            extra: {},
          },
        },
        expiration,
      );
    const withPayload = (key: string, channel: string, expiration: number): Row => ({
      record: {
        key,
        state: "pending",
        payer: PAYER,
        paymentPayload: payload(expiration),
      } as unknown as SettlementRecord,
      attempts: [{ hash: key, state: "stored", channel }],
    });
    const store = fakeStore([
      withPayload("open", "C1", 150),
      withPayload("past", "C2", 99),
      // No payload to read a bound from: held, as reconciliation keeps it open.
      row("unreadable", "pending", [{ hash: "u", state: "stored", channel: "C3" }]),
    ]);
    const pool = new ChannelPool(["C1", "C2", "C3"]);
    const holder = holderFor(store, pool);
    await holder.holdOpen();
    expect((await pool.acquire()).address).toBe("C2");
    expect(pool.held).toBe(2);
    holder.close();
  });

  it("reads no ledger when nothing is open, so a down RPC doesn't keep the lease away", async () => {
    const store = fakeStore([
      row("dead", "signed", [{ hash: "c", state: "dead", channel: "C1", maxLedger: 150 }]),
    ]);
    const net = network();
    net.down = true;
    await holderFor(store, new ChannelPool(["C1"]), net).holdOpen();
    expect(net.reads).toBe(0);
  });

  it("rejects when the ledger can't be read and an attempt is open", async () => {
    const store = fakeStore([
      row("k", "pending", [{ hash: "a", state: "sent", channel: "C1", maxLedger: 150 }]),
    ]);
    const net = network();
    net.down = true;
    const pool = new ChannelPool(["C1"]);
    await expect(holderFor(store, pool, net).holdOpen()).rejects.toThrow("rpc down");
    expect(pool.held).toBe(0);
  });

  it("skips a channel the pool retired, and holds the others", async () => {
    const store = fakeStore([
      row("k", "pending", [
        { hash: "a", state: "sent", channel: "C1", maxLedger: 150 },
        { hash: "b", state: "sent", channel: "C2", maxLedger: 150 },
      ]),
    ]);
    // C2 is still configured, but the pool retired it (its account went missing).
    const pool = new ChannelPool(["C1"]);
    const lines: string[] = [];
    const holder = holderFor(store, pool, network(), lines);
    await holder.holdOpen();
    expect(pool.held).toBe(1);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "channel_hold_skipped",
        channel: "C2",
        transactions: ["b"],
      }),
    );
    holder.close();
  });
});
