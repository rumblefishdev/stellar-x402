import {
  Keypair,
  StrKey,
  nativeToScVal,
  xdr,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar-x402/signer-pool";
import { FakeRpc } from "@stellar-x402/signer-pool/testing";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { jsonLogger } from "../src/logger.js";
import { compose } from "../src/main.js";
import { start } from "../src/start.js";
import { LEASE_SKEW_MARGIN_MS } from "../src/ports/index.js";
import { SETTLE_REASONS } from "../src/settlement/reasons.js";
import { keyOf } from "../src/settlement/settle.js";
import { testDatabase } from "./database.js";
import { transferPayload, usedNonces } from "./payment.js";
import { fakeOpenBao, signerEnv } from "./fake-openbao.js";

/**
 * 0090: a deploy whose drain ends with a sent transaction still open on a channel. The next
 * process, once it holds the lease, sends on the other channel and keeps off that one until
 * reconciliation answers for the transaction (`open-channels.test.ts` covers the release). A file
 * of its own, as `drain-takeover.test.ts`: its schema sees no late writes from other files.
 */

const facilitator = Keypair.random();
const openbao = await fakeOpenBao(facilitator);
afterAll(openbao.close);
const [first, second] = [Keypair.random().publicKey(), Keypair.random().publicKey()];
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
/** The payer of the payment being made; each process pays from its own, so neither waits on the other. */
let payer = Keypair.random().publicKey();
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
    return {
      ...sim,
      events: [event],
      transactionData: usedNonces(args[0] as Transaction),
    } as rpc.Api.SimulateTransactionResponse;
  }
}

/** One stalled, frozen network, so no transaction lands; process 1's calls hang once `die()` runs. */
function sharedNetwork() {
  const fake = new PaymentRpc({ [first]: 1_000n, [second]: 2_000n, [facilitator.publicKey()]: 1n });
  fake.balances.set(facilitator.publicKey(), 10_000_000_000n);
  fake.feeStats = {
    sorobanInclusionFee: { p90: "1000" },
  } as unknown as NonNullable<FakeRpc["feeStats"]>;
  fake.stalled = true;
  // Until `thaw()` no ledger closes: the ledgers of a payment's bound would otherwise pass in a
  // few reads.
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
  return { fake, viaProcess1, die: () => (dead = true), thaw: () => (frozen = false) };
}

const db = testDatabase();
beforeEach(db.empty);

/** The graph `main()` serves, on `rpc`, with both channels, `first` listed first. */
function composed(rpc: SorobanRpc, lines: string[] = []) {
  const config = parseConfig({
    ...signerEnv(facilitator.publicKey(), openbao.socketPath),
    DATABASE_URL: db.urlFor(db.schema),
    CLIENT_IP: "socket",
    SEARCH_MODEL_URL: "http://127.0.0.1:9",
    CHANNELS: `${first},${second}`,
    SETTLE_BUDGET_MS: "1000",
    LEASE_TTL_MS: "1000",
    PORT: "0",
  });
  return compose(config, {
    logger: jsonLogger("info", (line) => lines.push(line)),
    stores: db.stores(),
    rpc,
    seams: { makeScheme: () => ({ verify: async () => ({ isValid: true, payer }) }) },
    sleep: async () => {},
  }).deps;
}

const pay = (fake: FakeRpc, nonce: string) =>
  transferPayload({ payer, payTo, requirements }, fake.ledger + 60, undefined, nonce);

describe("a deploy that leaves a transaction open on a channel (0090)", () => {
  it("keeps the next process off that channel; it sends on the other one", async () => {
    const network = sharedNetwork();
    const { fake } = network;
    const old = composed(network.viaProcess1);
    await old.lease!.runOnce();
    const app = await start(old, { shutdownDeadlineMs: 300 });
    const p1 = pay(fake, "11");
    const k1 = keyOf(p1, "stellar:testnet")!;
    expect((await old.settle(p1, requirements)).response).toMatchObject({
      errorReason: SETTLE_REASONS.pending,
    });
    await app.close();
    network.die();
    const [left] = await old.stores.settlements.attempts(k1);
    expect(left).toMatchObject({ channel: first });
    expect(["stored", "sent", "unknown"]).toContain(left!.state);

    const lines: string[] = [];
    const next = composed(fake, lines);
    payer = Keypair.random().publicKey();
    try {
      // A balance reading first, as `start()` takes one before the lease.
      await next.floor!.start();
      await new Promise((r) => setTimeout(r, 1_000 + LEASE_SKEW_MARGIN_MS + 200));
      await next.lease!.runOnce();
      expect(next.lease!.held()).toBe(true);
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "channel_held",
          channel: first,
          transactions: [left!.hash],
        }),
      );

      const p2 = pay(fake, "12");
      const k2 = keyOf(p2, "stellar:testnet")!;
      await next.settle(p2, requirements);
      const [sent] = await next.stores.settlements.attempts(k2);
      // Without the hold, `first` is the pool's first free channel.
      expect(sent).toMatchObject({ channel: second });
    } finally {
      // Let process 2's transaction land, so its drain doesn't wait out the bound.
      fake.stalled = false;
      network.thaw();
      next.floor!.stop();
      await next.drain?.();
      await next.lease!.close();
    }
  }, 20_000);
});
