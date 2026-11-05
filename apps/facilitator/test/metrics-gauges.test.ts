import { Keypair, rpc } from "@stellar/stellar-sdk";
import type { GaugeName } from "@stellar-x402/metrics-catalog";
import { SettlementSubmitter } from "@stellar-x402/signer-pool";
import { FakeRpc } from "@stellar-x402/signer-pool/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { jsonLogger, rpcEndpointName } from "../src/logger.js";
import { PRIMARY_PROBE_INTERVAL_MS, compose } from "../src/main.js";
import {
  memoryMetrics,
  scoped,
  type GaugeRead,
  type MetricsWriter,
  type ProcessMetrics,
} from "../src/metrics.js";
import type { SettlementStore } from "../src/ports/index.js";
import { createReconciler } from "../src/settlement/reconcile.js";
import { createRecords } from "../src/settlement/records.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";
import { holdLease, settlement } from "./port-contracts.js";

// The gauges that read state the facilitator already keeps (0027 AD-5): the pool's stats, the
// shared RPC client's active endpoint and the reconciler's oldest open record.

const db = testDatabase();
beforeEach(db.empty);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const network = "stellar:testnet";
const URLS = ["https://rpc-a.example", "https://rpc-b.example"];
const channel = Keypair.random().publicKey();

/** A root that records each registration, as the EMF writer would sample it. */
function recordingMetrics() {
  const gauges: { name: GaugeName; read: GaugeRead }[] = [];
  const root: MetricsWriter = {
    increment() {},
    registerGauge(name, read) {
      gauges.push({ name, read });
    },
  };
  const metrics: ProcessMetrics = { ...root, for: (scope) => scoped(root, scope.network) };
  const read = (name: GaugeName) => {
    const found = gauges.filter((g) => g.name === name);
    expect(found, name).toHaveLength(1);
    return found[0]!.read();
  };
  return { metrics, gauges, read };
}

/**
 * `main()`'s graph on one `FakeRpc` for both URLs, with the gauges recorded and the warnings and
 * errors logged in `lines`.
 */
function composed(env: Record<string, string> = {}) {
  const config = parseConfig({
    ...signerEnv(Keypair.random().publicKey()),
    DATABASE_URL: db.urlFor(db.schema),
    CLIENT_IP: "socket",
    CHANNELS: channel,
    RPC_URLS: URLS.join(","),
    ...env,
  });
  const fake = new FakeRpc({ [channel]: 1_000n });
  const recorded = recordingMetrics();
  const lines: Record<string, unknown>[] = [];
  const built = compose(config, {
    logger: jsonLogger("warn", (line) => lines.push(JSON.parse(line))),
    stores: db.stores(),
    rpc: fake,
    seams: { makeScheme: () => ({ verify: async () => ({ isValid: true }) }) },
    sleep: async () => {},
    metrics: recorded.metrics,
  });
  return { ...built, ...recorded, fake, lines };
}

describe("gauge registration", () => {
  test("registers each gauge once, on the network child", () => {
    const { gauges, read } = composed();
    for (const name of [
      "pool_queued",
      "pool_quarantined",
      "rpc_on_fallback",
      "settlement_oldest_open_seconds",
      "rpc_stalled_seconds",
      "balance_reading_age_seconds",
    ] as const) {
      expect(
        gauges.filter((g) => g.name === name),
        name,
      ).toHaveLength(1);
      expect(read(name).labels).toMatchObject({ network });
    }
    // No sweep has listed the records yet.
    expect(read("settlement_oldest_open_seconds").value).toBe(0);
  });
});

describe("rpc_stalled_seconds and balance_reading_age_seconds", () => {
  test("read the tracker and the floor at the read, with no RPC call", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { read, fake, rpcStall } = composed();
    const calls = { ...fake.calls };
    expect(read("rpc_stalled_seconds").value).toBe(0);
    expect(read("balance_reading_age_seconds").value).toBe(0);
    // Neither has read yet: both ages count from their start, here their creation.
    vi.setSystemTime(Date.now() + 90_000);
    expect(read("rpc_stalled_seconds").value).toBe(90);
    expect(read("balance_reading_age_seconds").value).toBe(90);
    expect(fake.calls).toEqual(calls);
    rpcStall.stop();
  });

  test("startup warns when maxStaleMs is not 300000", () => {
    // The default interval gives the 300 s the `balance-stale` alarm assumes.
    const quiet = composed();
    expect(quiet.lines.map((l) => l.event)).not.toContain("balance_stale_threshold_mismatch");

    const { lines } = composed({ SPEND_BALANCE_INTERVAL_MS: "60000" });
    expect(lines.filter((l) => l.event === "balance_stale_threshold_mismatch")).toEqual([
      expect.objectContaining({
        level: "warn",
        network,
        maxStaleMs: 600_000,
        alarmThresholdMs: 300_000,
      }),
    ]);
  });
});

describe("pool gauges", () => {
  test("pool gauges read stats without side effects", () => {
    const original = SettlementSubmitter.prototype.stats;
    const stats = vi.spyOn(SettlementSubmitter.prototype, "stats");
    const { read, fake } = composed();
    const calls = { ...fake.calls };

    expect(read("pool_queued")).toEqual({
      value: 0,
      labels: { channels: 1, busy: 0, network },
    });
    expect(read("pool_quarantined")).toEqual({ value: 0, labels: { network } });
    expect(stats).toHaveBeenCalledTimes(2);

    // Read at the time of the read, from the submitter's snapshot.
    stats.mockImplementation(function (this: SettlementSubmitter) {
      return { ...original.call(this), busy: 1, queued: 3, quarantined: 2 };
    });
    expect(read("pool_queued")).toEqual({
      value: 3,
      labels: { channels: 1, busy: 1, network },
    });
    expect(read("pool_quarantined")).toEqual({ value: 2, labels: { network } });

    // Reading touched nothing: no RPC call, and the real snapshot is as it was.
    const [submitter] = stats.mock.contexts as SettlementSubmitter[];
    stats.mockRestore();
    const snapshot = submitter!.stats();
    for (let i = 0; i < 5; i++) {
      read("pool_queued");
      read("pool_quarantined");
    }
    expect(submitter!.stats()).toEqual(snapshot);
    expect(fake.calls).toEqual(calls);
  });
});

describe("rpc_on_fallback", () => {
  test("rpc_on_fallback is 1 after a failover and 0 after failback, label is the active endpoint name", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { read, rpc: shared, fake } = composed();
    const name = (i: number) => rpcEndpointName(URLS[i]!, i);

    expect(read("rpc_on_fallback")).toEqual({ value: 0, labels: { rpc: name(0), network } });

    const { index, token } = shared.begin();
    shared.markFailed(index, token, new Error("down"), "test");
    expect(read("rpc_on_fallback")).toEqual({ value: 1, labels: { rpc: name(1), network } });

    // A probe is due, but reading the gauge never starts one.
    vi.setSystemTime(Date.now() + PRIMARY_PROBE_INTERVAL_MS + 1);
    const ledgers = fake.calls.getLatestLedger ?? 0;
    read("rpc_on_fallback");
    await Promise.resolve();
    expect(fake.calls.getLatestLedger ?? 0).toBe(ledgers);
    expect(read("rpc_on_fallback").value).toBe(1);

    // A call starts the probe, which finds the first endpoint caught up.
    shared.begin();
    await vi.waitFor(() => expect(shared.active).toBe(name(0)));
    const back = read("rpc_on_fallback");
    expect(back).toEqual({ value: 0, labels: { rpc: name(0), network } });
    // The label is the endpoint's name, never its URL (ADR 0011).
    expect(JSON.stringify(back.labels)).not.toContain("https://");
  });
});

describe("settlement_oldest_open_seconds", () => {
  const NOW = 1_000_000;
  const BOUNDS = { maxTime: 2_000, maxLedger: 4_010 };

  /** `NOT_FOUND`; by default inside its bound, so the record stays open. */
  const missing = (latestLedger = 1, oldestLedgerCloseTime = 0) =>
    ({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      latestLedger,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime,
    }) as unknown as rpc.Api.GetTransactionResponse;

  /** Past its bound, with the RPC's history starting after the claim: `history_gone`. */
  const historyGone = () => missing(4_013, NOW / 1000 + 1);

  const landed = () =>
    ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 4_000,
      resultXdr: { feeCharged: () => ({ toBigInt: () => 41_000n }) },
    }) as unknown as rpc.Api.GetTransactionResponse;

  function setup() {
    const store = db.stores().settlements;
    const logger = jsonLogger("error", () => {});
    const metrics = memoryMetrics();
    let clock = NOW;
    const now = () => clock;
    const hooks = { onFinal: async () => {}, onSuccess: async () => {} };
    const records = createRecords({ network, store, hooks, logger, metrics, now });
    const answers = new Map<string, rpc.Api.GetTransactionResponse>();
    let held: Promise<void> | undefined;
    const reconciler = createReconciler({
      network,
      store,
      rpc: {
        getTransaction: async (hash: string) => {
          if (held) await held;
          return answers.get(hash) ?? missing();
        },
      },
      records,
      logger,
      metrics,
      budgetMs: 30_000,
      now,
    });
    /** Holds every RPC read until the returned release is called. */
    const hold = () => {
      let release!: () => void;
      held = new Promise((r) => (release = r));
      return () => {
        held = undefined;
        release();
      };
    };
    const advance = (ms: number) => (clock += ms);
    return { store, reconciler, answers, hold, advance };
  }

  /** A record signed with one hash, claimed `ageMs` before `NOW`. */
  async function signed(store: SettlementStore, nonce: string, hash: string, ageMs: number) {
    const s = { ...settlement(nonce), createdAt: NOW - ageMs };
    await store.claim(s);
    await store.addHash(s.key, hash, await holdLease(store), NOW - ageMs, BOUNDS);
    return s.key;
  }

  test("oldest open age grows at read time while the sweep is stuck", async () => {
    const { store, reconciler, answers, hold, advance } = setup();
    const A = "a".repeat(64);
    await signed(store, "1", A, 120_000);
    expect(reconciler.oldestOpenSeconds()).toBe(0);

    await reconciler.sweep();
    expect(reconciler.oldestOpenSeconds()).toBe(120);
    advance(30_000);
    expect(reconciler.oldestOpenSeconds()).toBe(150);

    // A sweep stuck on the RPC: the age keeps rising, read by read.
    const release = hold();
    const stuck = reconciler.sweep();
    advance(60_000);
    await new Promise((r) => setTimeout(r, 20));
    expect(reconciler.oldestOpenSeconds()).toBe(210);
    release();
    await stuck;
    expect(reconciler.oldestOpenSeconds()).toBe(210);

    // A sweep that can't list keeps the latest listing's record, and its age rises.
    vi.spyOn(store, "listNonFinal").mockRejectedValueOnce(new Error("store down"));
    advance(10_000);
    await expect(reconciler.sweep()).rejects.toThrow("store down");
    expect(reconciler.oldestOpenSeconds()).toBe(220);

    // Once the record is final, nothing is open.
    answers.set(A, landed());
    await reconciler.sweep();
    expect(reconciler.oldestOpenSeconds()).toBe(0);
  });

  test("history_gone records are excluded, including via the recheck-skip branch", async () => {
    const { store, reconciler, answers, advance } = setup();
    const A = "a".repeat(64);
    const B = "b".repeat(64);
    answers.set(A, historyGone());
    // The history_gone record is the older one.
    await signed(store, "1", A, 600_000);
    await signed(store, "2", B, 60_000);

    // The sweep that finds A's history gone.
    expect(await reconciler.sweep()).toMatchObject({ open: 2 });
    expect(reconciler.oldestOpenSeconds()).toBe(60);

    // Within the recheck interval A is skipped unread, and still left out.
    advance(10_000);
    expect(await reconciler.sweep()).toMatchObject({ open: 2 });
    expect(reconciler.oldestOpenSeconds()).toBe(70);

    // With B final, only A is open: nothing counts.
    answers.set(B, landed());
    expect(await reconciler.sweep()).toMatchObject({ success: 1, open: 1 });
    expect(reconciler.oldestOpenSeconds()).toBe(0);

    // Checked again after the interval, still gone: still left out.
    advance(5 * 60_000);
    expect(await reconciler.sweep()).toMatchObject({ open: 1 });
    expect(reconciler.oldestOpenSeconds()).toBe(0);
  });
});
