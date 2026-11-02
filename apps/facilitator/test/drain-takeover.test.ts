import { Keypair, StrKey, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar-x402/signer-pool";
import { FakeRpc } from "@stellar-x402/signer-pool/testing";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { jsonLogger } from "../src/logger.js";
import { compose, start } from "../src/main.js";
import { LEASE_SKEW_MARGIN_MS } from "../src/ports/index.js";
import { SETTLE_REASONS, keyOf } from "../src/settlement/settle.js";
import { testDatabase } from "./database.js";
import { transferPayload } from "./payment.js";

/**
 * A deploy with a 5-minute envelope (0073 decision 4): the old process's drain ends at its
 * deadline with a sent transaction still open, and the next process, once it holds the lease,
 * ends the record through reconciliation. A file of its own: its schema sees no late writes from
 * other files' settlements, which share one payer and nonce.
 */

const facilitator = Keypair.random();
const channel = Keypair.random().publicKey();
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 300,
  extra: {},
};

/** `FakeRpc` whose simulation emits the payment's transfer, for the balance-change check. */
class PaymentRpc extends FakeRpc {
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

/**
 * One network for two processes. Process 1 reaches it through `rpc`, which hangs every call once
 * `die()` runs, as a process SIGKILLed after its stop grace; process 2 uses `fake` itself. Until
 * `thaw()` no ledger closes: the 5 minutes of a real network would otherwise pass in the many
 * ledger reads of a few hundred milliseconds.
 */
function sharedNetwork() {
  const fake = new PaymentRpc({ [channel]: 1_000n });
  fake.feeStats = {
    sorobanInclusionFee: { p90: "1000" },
  } as unknown as NonNullable<FakeRpc["feeStats"]>;
  const read = fake.getLatestLedger.bind(fake);
  let frozen = true;
  fake.getLatestLedger = async () => {
    await new Promise((r) => setTimeout(r, 20));
    if (!frozen) return read();
    return {
      id: String(fake.ledger),
      sequence: fake.ledger,
      protocolVersion: "29",
      closeTime: String(fake.closeTime),
    } as rpc.Api.GetLatestLedgerResponse;
  };
  let dead = false;
  const viaProcess1 = new Proxy(fake, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        dead ? new Promise(() => {}) : (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as SorobanRpc;
  return {
    fake,
    viaProcess1,
    die: () => (dead = true),
    /** Closes ledgers again, one per read, as `FakeRpc` does. */
    thaw: () => (frozen = false),
  };
}

const db = testDatabase();
beforeEach(db.empty);

/** The graph `main()` serves, on `rpc`; it takes the lease when `lease` is set. */
async function composed(rpc: SorobanRpc, lease: boolean) {
  const config = parseConfig({
    FACILITATOR_SECRET: facilitator.secret(),
    DATABASE_URL: db.urlFor(db.schema),
    CLIENT_IP: "socket",
    CHANNELS: channel,
    SETTLE_BUDGET_MS: "1000",
    LEASE_TTL_MS: "1000",
    PORT: "0",
  });
  const { deps } = compose(config, {
    logger: jsonLogger("error", () => {}),
    stores: db.stores(),
    rpc,
    seams: { makeScheme: () => ({ verify: async () => ({ isValid: true, payer }) }) },
    sleep: async () => {},
  });
  if (lease) await deps.lease!.runOnce();
  return deps;
}

describe("a deploy with a 5-minute envelope (0073)", () => {
  it.each([
    ["never lands", "expired"],
    ["lands after the old process died, before its lease expires", "success"],
  ] as const)(
    "lets the next process end a record the drain left open when its transaction %s",
    async (_, outcome) => {
      const network = sharedNetwork();
      const { fake } = network;
      fake.stalled = true;
      const first = await composed(network.viaProcess1, true);
      const app = await start(first, { shutdownDeadlineMs: 300 });
      // About 5 minutes of ledgers: the pool may wait on it past the 180 s stop grace.
      const pay = transferPayload({ payer, payTo, requirements }, fake.ledger + 60);
      const key = keyOf(pay, "stellar:testnet")!;
      expect((await first.settle(pay, requirements)).response).toMatchObject({
        errorReason: SETTLE_REASONS.pending,
      });
      const release = vi.spyOn(first.lease!, "release");
      await app.close();
      // The drain ran out first: the record is open and the lease is left to its TTL.
      expect(release).not.toHaveBeenCalled();
      expect(["signed", "pending"]).toContain((await first.stores.settlements.get(key))?.state);
      network.die();

      const [attempt] = await first.stores.settlements.attempts(key);
      // The stored bounds carry no time bound, only the auth entry's expiry.
      expect(attempt).not.toHaveProperty("maxTime");
      const maxLedger = attempt!.maxLedger!;
      network.thaw();
      if (outcome === "success") fake.stalled = false;
      // The ledger after the bound closes (or the one it lands in).
      while (fake.ledger <= maxLedger) await fake.getLatestLedger();

      const second = await composed(fake, false);
      try {
        // The first process's lease still stands; it ends after its TTL and the skew margin.
        await second.lease!.runOnce();
        expect(second.lease!.held()).toBe(false);
        await new Promise((r) => setTimeout(r, 1_000 + LEASE_SKEW_MARGIN_MS + 200));
        await second.lease!.runOnce();
        expect(second.lease!.held()).toBe(true);
        second.reconciliation!.start();
        await second.reconciliation!.reconciled;
        expect((await second.stores.settlements.get(key))?.state).toBe(outcome);
      } finally {
        // Process 1 ended with `app.close()`; its calls on the dead network hang without timers.
        await second.reconciliation!.close();
        await second.drain?.();
        await second.lease!.close();
      }
    },
    20_000,
  );
});
