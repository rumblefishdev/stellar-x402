import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  SettlementSubmitter,
  ShutdownError,
  attemptsOf,
  keypairSigner,
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

function setup(opts: Partial<SubmitterOptions> = {}) {
  const fake = new FakeRpc(
    Object.fromEntries([
      [facilitator.publicKey(), 500n],
      ...channels.map((c, i) => [c, BigInt(1000 * (i + 1))]),
    ]),
  );
  // Ledgers close a macrotask later, and not at all while `hold()` is on, so a test can act while
  // a transaction is pending without its bounds running out.
  let gate: Promise<void> | undefined;
  let open = () => {};
  const hold = () => (gate = new Promise((resolve) => (open = resolve)));
  const release = () => {
    gate = undefined;
    open();
  };
  const closeLedger = fake.getLatestLedger.bind(fake);
  fake.getLatestLedger = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await gate;
    return closeLedger();
  };
  const submitter = new SettlementSubmitter({
    rpc: fake,
    networkPassphrase: PASSPHRASE,
    signer: keypairSigner(facilitator),
    channels: channels.slice(0, 1),
    now: () => fake.closeTime * 1000,
    sleep: async () => {},
    ...opts,
  });
  return { fake, submitter, hold, release };
}

/** Resolves once `predicate` holds, polling every macrotask. */
async function until(predicate: () => boolean) {
  while (!predicate()) await new Promise((r) => setTimeout(r, 0));
}

describe("SettlementSubmitter.close() (0025)", () => {
  it("refuses a call queued for a channel, lets the sent one run on, and waits for it", async () => {
    const { fake, submitter, hold, release } = setup({ pipeline: false });
    hold();
    const signed: string[] = [];
    const onSigned = async (hash: string) => void signed.push(hash);
    const sent = submitter.submit(call(), { onSigned });
    await until(() => fake.sent.length === 1);
    const queued = submitter.submit(call(), { onSigned });
    await until(() => submitter.pool.queued === 1);

    let closed = false;
    const closing = submitter.close().then(() => (closed = true));
    await expect(queued).rejects.toBeInstanceOf(ShutdownError);
    // The queued call never reached `onSigned`: nothing of it is stored or sent.
    expect(signed).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(false);

    release();
    await expect(sent).resolves.toMatchObject({ status: "success" });
    await closing;
    expect(fake.sent).toHaveLength(1);
    expect(submitter.stats().refused.shutdown).toBe(1);
  });

  it("refuses a call prepared ahead behind the channel's pending transaction", async () => {
    const { fake, submitter, hold, release } = setup();
    hold();
    const onSigned = vi.fn(async () => {});
    // Queued when the first is sent, so the channel is handed to it at once.
    const sent = submitter.submit(call(), { onSigned });
    const ahead = submitter.submit(call(), { onSigned });
    // Prepared against the next sequence, and waiting for the first transaction to land.
    await until(() => fake.sent.length === 1 && fake.calls.simulateTransaction === 2);
    const closing = submitter.close();
    await expect(ahead).rejects.toBeInstanceOf(ShutdownError);
    expect(onSigned).toHaveBeenCalledTimes(1);
    release();
    await expect(sent).resolves.toMatchObject({ status: "success" });
    await closing;
    expect(fake.sent).toHaveLength(1);
  });

  it("stops a sequence read that is being retried", async () => {
    const { fake, submitter } = setup();
    fake.getLedgerEntries = async () => {
      throw new Error("502 Bad Gateway");
    };
    const reading = submitter.submit(call());
    await until(() => submitter.stats().readRetries > 0);
    await submitter.close();
    await expect(reading).rejects.toBeInstanceOf(ShutdownError);
    expect(fake.sent).toHaveLength(0);
  });

  it("sends no txBadSeq rebuild once closing", async () => {
    const { fake, submitter } = setup();
    await submitter.submit(call());
    // Another sender used the channel, so the next envelope gets txBadSeq.
    fake.sequences.set(channels[0]!, 5000n);
    let closing: Promise<void> | undefined;
    const rebuilt = submitter.submit(call(), {
      // The close comes after this envelope was given to `onSigned`, so it is still sent.
      onSigned: async () => void (closing ??= submitter.close()),
    });
    const error = await rebuilt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShutdownError);
    // The first envelope was sent and refused; no rebuild followed it.
    expect(attemptsOf(error)).toEqual([{ hash: expect.any(String), sent: "yes" }]);
    expect(fake.sent).toHaveLength(2);
    await closing;
  });

  it("refuses every submit() after close()", async () => {
    const { fake, submitter } = setup();
    await submitter.close();
    await expect(submitter.submit(call())).rejects.toBeInstanceOf(ShutdownError);
    expect(fake.calls.simulateTransaction).toBeUndefined();
    expect(submitter.stats().refused.shutdown).toBe(1);
  });
});
