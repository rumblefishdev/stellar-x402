import { Account, Keypair, StrKey, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import { FakeRpc } from "@stellar-x402/signer-pool/testing";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { MemorySettlementStore } from "../src/adapters/memory.js";
import { parseConfig, type Env } from "../src/config.js";
import { jsonLogger } from "../src/logger.js";
import { buildChecks, buildSettlement, compose } from "../src/main.js";
import { memoryMetrics } from "../src/metrics.js";
import { feeSettings } from "../src/settlement/fees.js";
import { SETTLE_REASONS } from "../src/settlement/settle.js";
import { transferPayload } from "./payment.js";

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
  /** Delay before `getAccount` answers, to hold a settlement before it signs. */
  accountDelayMs = 0;

  override async getAccount(address: string): Promise<Account> {
    if (this.accountDelayMs) await new Promise((r) => setTimeout(r, this.accountDelayMs));
    return super.getAccount(address);
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
function payload(expiration: number, extensions?: Record<string, unknown>): PaymentPayload {
  return transferPayload({ payer, payTo, requirements }, expiration, extensions);
}

function setup(env: Partial<Env> = {}) {
  const config = parseConfig({
    FACILITATOR_SECRET: facilitator.secret(),
    CHANNELS: channel,
    MAX_FEE_STROOPS: String(MAX_FEE),
    INCLUSION_FEE_STROOPS: String(BID),
    ...env,
  });
  const fake = new PaymentRpc({ [channel]: 1_000n });
  const fees = feeSettings(config.fees, fake);
  const checks = buildChecks(
    config,
    fake,
    fees,
    { warn() {}, info() {} },
    { makeScheme: () => ({ verify: async () => ({ isValid: true, payer }) }) },
  );
  const { settle } = buildSettlement(config, {
    rpc: fake,
    fees,
    checks,
    store: new MemorySettlementStore(),
    hooks: {
      beforeSubmit: async () => ({ allow: true }),
      onFinal: async () => {},
      onSuccess: async () => {},
    },
    logger: jsonLogger("error", () => {}),
    metrics: memoryMetrics(),
    sleep: async () => {},
  });
  return { settle, fake };
}

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
  function composed() {
    const config = parseConfig({
      FACILITATOR_SECRET: facilitator.secret(),
      CHANNELS: channel,
      MAX_FEE_STROOPS: String(MAX_FEE),
    });
    const fake = new PaymentRpc({ [channel]: 1_000n });
    fake.feeStats = {
      sorobanInclusionFee: { p90: String(BID) },
    } as unknown as NonNullable<FakeRpc["feeStats"]>;
    const { deps, cataloger, metrics } = compose(config, {
      logger: jsonLogger("error", () => {}),
      rpc: fake,
      seams: { makeScheme: () => ({ verify: async () => ({ isValid: true, payer }) }) },
      sleep: async () => {},
    });
    return { deps, cataloger, metrics, fake };
  }
  const bazaar = { info: { input: { type: "http", method: "GET" } }, routeTemplate: "/users/:id" };

  it("gives a success the cataloger's header, and catalogs it after the response", async () => {
    const { deps, cataloger, fake } = composed();
    const settled = await deps.settle(payload(fake.ledger + 30, { bazaar }), requirements);
    expect(settled.response).toMatchObject({ success: true });
    expect(deps.extensionResponses(settled.record!)).toEqual({ bazaar: { status: "processing" } });
    settled.afterResponse!();
    await cataloger.drain();
    const { items } = await deps.stores.catalog.list({ limit: 10, offset: 0 });
    expect(items).toHaveLength(1);
  });

  it("reads the fee-stats bid once for /verify, /settle and the pool (AD-10)", async () => {
    const { deps, fake } = composed();
    const p = payload(fake.ledger + 30);
    expect(await deps.verify(p, requirements)).toMatchObject({ isValid: true });
    expect((await deps.settle(p, requirements)).response).toMatchObject({ success: true });
    // One provider, read again only after 30 s: a second fee configuration would read it again.
    expect(fake.calls.getFeeStats).toBe(1);
  });
});
