import { Address, FeeBumpTransaction, StrKey, Transaction, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  SettlementSubmitter,
  SimulationCheckError,
  keypairSigner,
  type SubmitterEvent,
  type SubmitterOptions,
} from "../src/index.js";
import { FakeRpc, channels, facilitator } from "./fake-rpc.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

const call = () => ({
  func: xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(StrKey.encodeContract(Buffer.alloc(32, 7))).toScAddress(),
      functionName: "settle_upto",
      args: [],
    }),
  ),
  auth: [],
});

function setup(opts: Partial<SubmitterOptions> = {}, n = 1) {
  const fake = new FakeRpc(
    Object.fromEntries([
      [facilitator.publicKey(), 500n],
      ...channels.map((c, i) => [c, BigInt(1000 * (i + 1))]),
    ]),
  );
  // For each simulation: was it built ahead, i.e. for a sequence the account has not reached?
  const ahead: boolean[] = [];
  const simulate = fake.simulateTransaction.bind(fake);
  const closeLedger = fake.getLatestLedger.bind(fake);
  Object.assign(fake, {
    // Close ledgers a macrotask later, so the next holder's preparation (all microtasks against
    // the fake) runs while the previous transaction is still pending.
    getLatestLedger: async () => {
      await new Promise((r) => setTimeout(r, 0));
      return closeLedger();
    },
    simulateTransaction: async (tx: Transaction) => {
      ahead.push(BigInt(tx.sequence) > fake.sequences.get(tx.source)! + 1n);
      return simulate();
    },
  });
  const events: SubmitterEvent[] = [];
  const submitter = new SettlementSubmitter({
    rpc: fake,
    networkPassphrase: PASSPHRASE,
    signer: keypairSigner(facilitator),
    channels: channels.slice(0, n),
    now: () => fake.closeTime * 1000,
    sleep: async () => {},
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { fake, submitter, events, ahead };
}

const innerSeqs = (fake: FakeRpc) =>
  fake.sent.map((t) => (t as FeeBumpTransaction).innerTransaction.sequence);

describe("pipelining", () => {
  it("prepares the next queued call while the channel's transaction is pending", async () => {
    const { fake, submitter, ahead } = setup();
    const results = await Promise.all(Array.from({ length: 3 }, () => submitter.submit(call())));
    expect(results.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(innerSeqs(fake)).toEqual(["1001", "1002", "1003"]);
    expect(ahead).toEqual([false, true, true]);
    expect(submitter.stats()).toMatchObject({
      preparedAhead: { used: 2, rebuilt: 0 },
      sendRetries: 0,
      errorCodes: {},
      busy: 0,
    });
  });

  it("rebuilds the prepared envelope when the pending transaction expires", async () => {
    const { fake, submitter, ahead } = setup({
      timeoutSeconds: 20,
      onEvent: (e) => {
        if (e.type === "final" && e.result.status === "expired") fake.stalled = false;
      },
    });
    fake.stalled = true;
    const [first, second] = await Promise.all([submitter.submit(call()), submitter.submit(call())]);
    expect(first?.status).toBe("expired");
    expect(second?.status).toBe("success");
    // The prepared 1002 was never sent; the rebuild reused the expired 1001.
    expect(innerSeqs(fake)).toEqual(["1001", "1001"]);
    expect(ahead).toEqual([false, true, false]);
    expect(submitter.stats().preparedAhead).toEqual({ used: 0, rebuilt: 1 });
  });

  it("keeps the channel until the pending transaction is final when the next call is refused", async () => {
    const { fake, submitter } = setup();
    const refuse = {
      checkSimulation: () => {
        throw new Error("unexpected balance change");
      },
    };
    const [a, b, c] = await Promise.allSettled([
      submitter.submit(call()),
      submitter.submit(call(), refuse),
      submitter.submit(call()),
    ]);
    expect(a).toMatchObject({ status: "fulfilled", value: { status: "success" } });
    expect(b.status === "rejected" && b.reason).toBeInstanceOf(SimulationCheckError);
    expect(c).toMatchObject({ status: "fulfilled", value: { status: "success" } });
    // Released early, the third call would have reused 1001 and hit TRY_AGAIN_LATER / txBadSeq.
    expect(innerSeqs(fake)).toEqual(["1001", "1002"]);
    expect(submitter.stats()).toMatchObject({ sendRetries: 0, errorCodes: {}, busy: 0 });
  });

  it("can be turned off", async () => {
    const { fake, submitter, events, ahead } = setup({ pipeline: false });
    await Promise.all(Array.from({ length: 3 }, () => submitter.submit(call())));
    expect(innerSeqs(fake)).toEqual(["1001", "1002", "1003"]);
    expect(ahead).toEqual([false, false, false]);
    expect(events.some((e) => e.type === "prepared-ahead")).toBe(false);
  });
});
