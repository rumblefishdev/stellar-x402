import { Keypair, StrKey, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import type { SorobanRpc, SubmitterEvent } from "@stellar-x402/signer-pool";
import { FakeRpc } from "@stellar-x402/signer-pool/testing";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type Env } from "../src/config.js";
import { jsonLogger, rpcEndpointName } from "../src/logger.js";
import {
  buildChecks,
  buildRpc,
  buildSettlement,
  compose,
  start,
  type UpstreamSeams,
} from "../src/main.js";
import { memoryMetrics } from "../src/metrics.js";
import type { LeaseFence, SettlementStore } from "../src/ports/index.js";
import { feeSettings } from "../src/settlement/fees.js";
import { SETTLE_REASONS, keyOf } from "../src/settlement/settle.js";
import { testDatabase } from "./database.js";
import { transferPayload } from "./payment.js";
import { holdLease, settlement } from "./port-contracts.js";

/**
 * `main()`'s `/settle` wiring with the real pool on `FakeRpc`: `/settle`'s checks, the pool's fee
 * settings and the settle budget. Upstream verify is a stub; its wiring has its own tests.
 */

const facilitator = Keypair.random();
const channel = Keypair.random().publicKey();
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const MAX_FEE = 250_000;
const BID = 1_000;

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {},
};

/** `FakeRpc` whose simulation emits the payment's transfer, for the balance-change check. */
class PaymentRpc extends FakeRpc {
  /** Delay before an account read answers, to hold a settlement before it signs. */
  accountDelayMs = 0;
  /** Account reads begun: a test waits for one before acting on a held settlement. */
  accountReads = 0;

  override async getLedgerEntries(
    ...keys: Parameters<FakeRpc["getLedgerEntries"]>
  ): Promise<rpc.Api.GetLedgerEntriesResponse> {
    this.accountReads++;
    if (this.accountDelayMs) await new Promise((r) => setTimeout(r, this.accountDelayMs));
    return super.getLedgerEntries(...keys);
  }

  override async simulateTransaction(
    ...args: Parameters<FakeRpc["simulateTransaction"]>
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    const sim = await super.simulateTransaction(...args);
    const topics = [
      xdr.ScVal.scvSymbol("transfer"),
      nativeToScVal(payer, { type: "address" }),
      nativeToScVal(payTo, { type: "address" }),
    ];
    const event = new xdr.DiagnosticEvent({
      inSuccessfulContractCall: true,
      event: new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: StrKey.decodeContract(
          asset,
        ) as unknown as xdr.ContractEvent["contractId"] extends () => infer T ? T : never,
        type: xdr.ContractEventType.contract(),
        body: new xdr.ContractEventBody(
          0,
          new xdr.ContractEventV0({ topics, data: nativeToScVal(1000n, { type: "i128" }) }),
        ),
      }),
    });
    return { ...sim, events: [event] } as rpc.Api.SimulateTransactionResponse;
  }
}

/** A `transfer` from the payer, with its one auth entry valid to `expiration`. */
function payload(
  expiration: number,
  extensions?: Record<string, unknown>,
  nonce?: string,
): PaymentPayload {
  return transferPayload({ payer, payTo, requirements }, expiration, extensions, nonce);
}

/**
 * `rpc` gives the shared client's endpoints: each RPC URL is `fake` unless it returns another
 * client for that URL; `rpcTimeoutMs` is how long a call may take on one.
 */
const db = testDatabase();
beforeEach(db.empty);
/** The lease `/settle` sends under, taken again for every test (0071). */
let fence: LeaseFence | undefined;
beforeEach(async () => {
  fence = await holdLease(db.stores().settlements);
});

function setup(
  env: Partial<Env> = {},
  seams?: UpstreamSeams,
  rpc: { endpoint?: (url: string) => SorobanRpc | undefined; timeoutMs?: number } = {},
) {
  const config = parseConfig({
    FACILITATOR_SECRET: facilitator.secret(),
    DATABASE_URL: db.urlFor(db.schema),
    CLIENT_IP: "socket",
    CHANNELS: channel,
    MAX_FEE_STROOPS: String(MAX_FEE),
    INCLUSION_FEE_STROOPS: String(BID),
    ...env,
  });
  const fake = new PaymentRpc({ [channel]: 1_000n });
  fake.feeStats = {
    sorobanInclusionFee: { p90: String(BID) },
  } as unknown as NonNullable<FakeRpc["feeStats"]>;
  const upstreamLogger = { warn: vi.fn(), info: vi.fn() };
  // The shared client, as `main()` builds it (AD-3).
  const shared = buildRpc(
    config,
    upstreamLogger,
    (url) => rpc.endpoint?.(url) ?? fake,
    rpc.timeoutMs,
  );
  const fees = feeSettings(config.fees, shared);
  const checks = buildChecks(
    config,
    shared,
    fees,
    upstreamLogger,
    seams ?? { makeScheme: () => ({ verify: async () => ({ isValid: true, payer }) }) },
  );
  const store = db.stores().settlements;
  const lines: string[] = [];
  const { settle, submitter, drain } = buildSettlement(config, {
    rpc: shared,
    fees,
    checks,
    store,
    hooks: {
      beforeSubmit: async () => ({ allow: true }),
      onFinal: async () => {},
      onSuccess: async () => {},
    },
    logger: jsonLogger("warn", (line) => lines.push(line)),
    metrics: memoryMetrics(),
    sleep: async () => {},
    lease: () => fence,
  });
  /** The pool's `onEvent`, as it reports a submission it answered `pending` ending. */
  const emit = (event: SubmitterEvent) =>
    (submitter as unknown as { emit(event: SubmitterEvent): void }).emit(event);
  return { settle, fake, upstreamLogger, store, lines, emit, drain };
}

describe("main()'s /settle wiring, with a hung RPC_URLS[0]", () => {
  const RPC_URLS = "https://rpc-a.example,https://rpc-b.example";
  const rpc = (i: number) => rpcEndpointName(RPC_URLS.split(",")[i]!, i);
  /** `RPC_URLS[0]` accepts the call and never answers; `RPC_URLS[1]` answers. */
  const hungFirst = (timeoutMs: number): UpstreamSeams => ({
    makeScheme: (_signer, options) => ({
      verify: () =>
        options.rpcConfig?.url === "https://rpc-a.example"
          ? new Promise(() => {})
          : Promise.resolve({ isValid: true, payer }),
    }),
    timeoutMs,
  });

  it("settles through RPC_URLS[1] once RPC_URLS[0]'s own timeout ends, and logs the switch", async () => {
    const { settle, fake, upstreamLogger } = setup({ RPC_URLS }, hungFirst(50));
    const { response } = await settle(payload(fake.ledger + 30), requirements);
    expect(response).toMatchObject({ success: true, payer });
    expect(fake.sent).toHaveLength(1);
    expect(upstreamLogger.warn).toHaveBeenCalledWith(
      "rpc_failover",
      expect.objectContaining({ from: rpc(0), to: rpc(1), reason: "timeout" }),
    );
  });

  it("answers the retryable timeout and sends nothing when the budget ends before the failover", async () => {
    // RPC_URLS[0]'s 2 s outlasts the 1 s budget, as 41 s of fee-stats failover outlasts 30 s.
    const { settle, fake } = setup({ RPC_URLS, SETTLE_BUDGET_MS: "1000" }, hungFirst(2_000));
    const started = Date.now();
    const { response } = await settle(payload(fake.ledger + 30), requirements);
    expect(response).toMatchObject({ success: false, errorReason: SETTLE_REASONS.timeout });
    expect(fake.sent).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(1_800);
  });
});

describe("main()'s /settle wiring, under a stale lease token (0071)", () => {
  it("stores nothing and sends nothing through the real pool", async () => {
    const { settle, fake, store } = setup();
    // Another process took the lease since this one's keeper read it.
    const current = fence!;
    fence = { name: current.name, token: "00000000-0000-4000-8000-000000000071" };
    const pay = payload(fake.ledger + 30);
    const { response } = await settle(pay, requirements);
    expect(response).toMatchObject({ success: false, errorReason: SETTLE_REASONS.leaseLost });
    expect(fake.sent).toHaveLength(0);
    const record = await store.get(keyOf(pay, "stellar:testnet")!);
    expect(record).toMatchObject({ state: "rejected", hashes: [] });
  });
});

describe("main()'s /settle wiring, with RPC_URLS[0] hung for every client (AD-3)", () => {
  const RPC_URLS = "https://rpc-a.example,https://rpc-b.example";
  const HANG_MS = 1_200;
  /** One wait fits, with room for the store's writes; two don't. */
  const BUDGET_MS = 2_000;
  /** Every call to RPC_URLS[0], upstream's and the shared client's, never answers. */
  const hung = new Proxy({} as SorobanRpc, { get: () => () => new Promise(() => {}) });
  const run = (env: Partial<Env>) =>
    setup(
      { RPC_URLS, SETTLE_BUDGET_MS: String(BUDGET_MS), ...env },
      {
        makeScheme: (_signer, options) => ({
          verify: () =>
            options.rpcConfig?.url === "https://rpc-a.example"
              ? new Promise(() => {})
              : Promise.resolve({ isValid: true, payer }),
        }),
        timeoutMs: HANG_MS,
      },
      {
        endpoint: (url) => (url === "https://rpc-a.example" ? hung : undefined),
        timeoutMs: HANG_MS,
      },
    );

  // Two waits for the hung URL (upstream's, then the AD-22 read's) would outlast the budget.
  it.each([
    ["a fixed bid", {}],
    ["the fee-stats bid", { INCLUSION_FEE_STROOPS: undefined }],
  ])("waits for it once, so the first /settle fits the budget, with %s", async (_, env) => {
    const { settle, fake, upstreamLogger } = run(env);
    const started = Date.now();
    const { response } = await settle(payload(fake.ledger + 30), requirements);
    expect(response).toMatchObject({ success: true, payer });
    expect(fake.sent).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
    expect(
      upstreamLogger.warn.mock.calls.filter(([event]) => event === "rpc_failover"),
    ).toHaveLength(1);
  });
});

describe("main()'s /settle wiring, with the real pool", () => {
  it("settles through the pool with the hash it sent", async () => {
    const { settle, fake } = setup();
    const { response } = await settle(payload(fake.ledger + 30), requirements);
    expect(response).toMatchObject({ success: true, payer });
    expect(fake.sent.map((tx) => tx.hash().toString("hex"))).toContain(response.transaction);
  });

  it("rechecks the auth expiry at the pool's floor of 2 ledgers, not MIN_VALIDITY_LEDGERS", async () => {
    // `/verify` would refuse 12 ledgers against a minimum of 20.
    const { settle, fake } = setup({ MIN_VALIDITY_LEDGERS: "20" });
    const { response } = await settle(payload(fake.ledger + 12), requirements);
    expect(response).toMatchObject({ success: true });
  });

  it("gives the pool the configured fee ceiling (AD-10)", async () => {
    const { settle, fake } = setup();
    // Twice the bid plus this is one stroop above the ceiling.
    fake.resourceFee = MAX_FEE - 2 * BID + 1;
    const { response } = await settle(payload(fake.ledger + 30), requirements);
    expect(response).toMatchObject({ success: false, errorReason: SETTLE_REASONS.fee });
    expect(fake.sent).toHaveLength(0);
  });

  it("bounds a call by SETTLE_BUDGET_MS, not SETTLE_TIMEOUT_MS", async () => {
    const { settle, fake } = setup({ SETTLE_TIMEOUT_MS: "1000", SETTLE_BUDGET_MS: "5000" });
    fake.accountDelayMs = 1_500;
    const { response } = await settle(payload(fake.ledger + 30), requirements);
    expect(response).toMatchObject({ success: true });
  });

  it("ends a call at SETTLE_BUDGET_MS when it is shorter than the default", async () => {
    // 1.2 s: neither the 30 s default nor SETTLE_TIMEOUT_MS, so neither can stand in for it.
    const { settle, fake } = setup({ SETTLE_TIMEOUT_MS: "1000", SETTLE_BUDGET_MS: "1200" });
    fake.accountDelayMs = 3_000;
    const started = Date.now();
    const { response } = await settle(payload(fake.ledger + 30), requirements);
    expect(response).toMatchObject({ success: false, errorReason: SETTLE_REASONS.timeout });
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});

describe("main()'s composition (compose)", () => {
  /** The graph `main()` serves; it takes the lease as `start()` does, unless `lease: false`. */
  async function composed(env: Record<string, string> = {}, opts: { lease?: boolean } = {}) {
    const config = parseConfig({
      FACILITATOR_SECRET: facilitator.secret(),
      DATABASE_URL: db.urlFor(db.schema),
      CLIENT_IP: "socket",
      CHANNELS: channel,
      MAX_FEE_STROOPS: String(MAX_FEE),
      ...env,
    });
    const fake = new PaymentRpc({ [channel]: 1_000n });
    fake.feeStats = {
      sorobanInclusionFee: { p90: String(BID) },
    } as unknown as NonNullable<FakeRpc["feeStats"]>;
    const { deps, cataloger, metrics } = compose(config, {
      logger: jsonLogger("error", () => {}),
      stores: db.stores(),
      rpc: fake,
      seams: { makeScheme: () => ({ verify: async () => ({ isValid: true, payer }) }) },
      sleep: async () => {},
    });
    if (opts.lease !== false) await deps.lease!.runOnce();
    return { deps, cataloger, metrics, fake };
  }
  const bazaar = { info: { input: { type: "http", method: "GET" } }, routeTemplate: "/users/:id" };

  it("sends nothing from a process without the lease (0025 decision 22, 0071)", async () => {
    const { deps, fake } = await composed({}, { lease: false });
    const settled = await deps.settle(payload(fake.ledger + 30), requirements);
    expect(settled.response).toMatchObject({ errorReason: SETTLE_REASONS.leaseLost });
    expect(fake.sent).toHaveLength(0);
  });

  it("gives a success the cataloger's header, and catalogs it after the response", async () => {
    const { deps, cataloger, fake } = await composed();
    const settled = await deps.settle(payload(fake.ledger + 30, { bazaar }), requirements);
    expect(settled.response).toMatchObject({ success: true });
    expect(deps.extensionResponses(settled.record!)).toEqual({ bazaar: { status: "processing" } });
    settled.afterResponse!();
    await cataloger.drain();
    const { items } = await deps.stores.catalog.list({ limit: 10, offset: 0 });
    expect(items).toHaveLength(1);
  });

  it.each([
    [{}, { status: "rejected", rejectedReason: "resource_not_public" }, 0],
    [{ CATALOG_LIST_LOCAL: "true" }, { status: "processing" }, 1],
  ] as const)(
    "settles a localhost resource and lists it only with %j (0054)",
    async (env, header, listed) => {
      const { deps, cataloger, fake } = await composed(env);
      const local = {
        ...payload(fake.ledger + 30, { bazaar }),
        resource: { url: "http://localhost:4022/users/42" },
      } as PaymentPayload;
      const settled = await deps.settle(local, requirements);
      expect(settled.response).toMatchObject({ success: true });
      expect(deps.extensionResponses(settled.record!)).toEqual({ bazaar: header });
      settled.afterResponse!();
      await cataloger.drain();
      const { items } = await deps.stores.catalog.list({ limit: 10, offset: 0 });
      expect(items).toHaveLength(listed);
    },
  );

  it("waits on close() for a settlement answered pending until it lands, then releases the lease (0025)", async () => {
    const { deps, fake } = await composed({ SETTLE_BUDGET_MS: "1000", PORT: "0" });
    // A ledger read takes a round trip, as on a real RPC: `FakeRpc` closes a ledger on every
    // read, so without one the pool's wait for the status never yields to the budget's timer.
    const getLatestLedger = fake.getLatestLedger.bind(fake);
    fake.getLatestLedger = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return getLatestLedger();
    };
    // The network includes the transaction, but no status read answers until `land()`.
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const getTransaction = fake.getTransaction.bind(fake);
    fake.getTransaction = async (hash) => {
      await landed;
      return getTransaction(hash);
    };
    const app = await start(deps);
    const pay = payload(fake.ledger + 30);
    const key = keyOf(pay, "stellar:testnet")!;
    // The record's state when the lease is given up: the drain must have finished it by then.
    const releaseLease = deps.lease!.release;
    let stateAtRelease: string | undefined;
    const release = vi.spyOn(deps.lease!, "release").mockImplementation(async () => {
      stateAtRelease = (await deps.stores.settlements.get(key))?.state;
      await releaseLease();
    });
    expect((await deps.settle(pay, requirements)).response).toMatchObject({
      success: false,
      errorReason: SETTLE_REASONS.pending,
    });
    let closed = false;
    const closing = app.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(closed).toBe(false);
    expect(release).not.toHaveBeenCalled();
    land();
    await closing;
    expect(stateAtRelease).toBe("success");
  });

  it("reads the fee-stats bid once for /verify, /settle and the pool (AD-10)", async () => {
    const { deps, fake } = await composed();
    const p = payload(fake.ledger + 30);
    expect(await deps.verify(p, requirements)).toMatchObject({ isValid: true });
    expect((await deps.settle(p, requirements)).response).toMatchObject({ success: true });
    // One provider, read again only after 30 s: a second fee configuration would read it again.
    expect(fake.calls.getFeeStats).toBe(1);
  });
});

describe("main()'s pool events (0019)", () => {
  const HASH = "c".repeat(64);
  const resolvedSuccess: SubmitterEvent = {
    type: "resolved",
    result: {
      status: "success",
      hash: HASH,
      channel,
      ledger: 101,
      feeCharged: 41_000n,
      attempts: [{ hash: HASH, sent: "yes" }],
    },
  };

  async function pendingRecord(store: SettlementStore) {
    const s = settlement("1");
    await store.claim(s);
    await store.addHash(s.key, HASH, await holdLease(store), 0, { maxTime: 1 });
    await store.transition(s.key, "signed", { state: "pending", updatedAt: 0 });
    return s.key;
  }

  it("refuses a call that has signed nothing when the drain starts, and closes its record (0025)", async () => {
    const { settle, fake, store, drain } = setup();
    // Holds the call in its channel's sequence read, before anything is signed.
    fake.accountDelayMs = 200;
    const pay = payload(fake.ledger + 30);
    const settling = settle(pay, requirements);
    await vi.waitFor(() => expect(fake.accountReads).toBeGreaterThan(0));
    await drain();
    expect((await settling).response).toMatchObject({
      success: false,
      errorReason: SETTLE_REASONS.shuttingDown,
      transaction: "",
    });
    expect(fake.sent).toHaveLength(0);
    expect(await store.get(keyOf(pay, "stellar:testnet")!)).toMatchObject({
      state: "rejected",
      errorReason: SETTLE_REASONS.shuttingDown,
      hashes: [],
    });
  });

  it("reads the answer's ledger from the checks' RPC: one ledger left says to wait, not repeat (0073)", async () => {
    // The retry answer asks the same shared client the checks read; at one ledger left the pool
    // can't use the auth entry, so `retryable` is false while the entry may still land.
    const { settle, fake, drain } = setup();
    fake.accountDelayMs = 200;
    const expiration = fake.ledger + 30;
    // A nonce of its own: a call an earlier test left running writes onto nonce 7's record (0084).
    const pay = payload(expiration, undefined, "8");
    const settling = settle(pay, requirements);
    await vi.waitFor(() => expect(fake.accountReads).toBeGreaterThan(0));
    await drain();
    expect((await settling).response).toMatchObject({
      errorReason: SETTLE_REASONS.shuttingDown,
      extra: { retryable: true, expirationLedger: expiration },
    });
    // The next read closes a ledger: it answers `expiration - 1`.
    fake.ledger = expiration - 2;
    expect((await settle(pay, requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.shuttingDown,
      errorMessage: expect.stringContaining(`may still land in ledger ${expiration}`),
      extra: { retryable: false, expirationLedger: expiration },
    });
  });

  it("finishes a pending record when the pool resolves its submission", async () => {
    const { store, emit } = setup();
    const key = await pendingRecord(store);
    emit(resolvedSuccess);
    await vi.waitFor(async () => expect((await store.get(key))?.state).toBe("success"));
    expect(await store.get(key)).toMatchObject({ ledger: 101, channel });
    expect((await store.attempts(key))[0]?.state).toBe("landed");
  });

  it("logs a store that fails to finish it, for the next sweep", async () => {
    const { store, lines, emit } = setup();
    const key = await pendingRecord(store);
    vi.spyOn(store, "transition").mockRejectedValue(new Error("store down"));
    emit(resolvedSuccess);
    await vi.waitFor(() =>
      expect(lines.some((line) => line.includes('"settlement_resolve_failed"'))).toBe(true),
    );
    expect((await store.get(key))?.state).toBe("pending");
  });
});
