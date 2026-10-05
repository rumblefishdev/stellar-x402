import { Address, FeeBumpTransaction, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  FeeLimitError,
  SettlementSubmitter,
  SimulationError,
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

function setup(opts: Partial<SubmitterOptions> = {}, n = 3) {
  const fake = new FakeRpc(
    Object.fromEntries([
      [facilitator.publicKey(), 500n],
      ...channels.map((c, i) => [c, BigInt(1000 * (i + 1))]),
    ]),
  );
  const submitter = new SettlementSubmitter({
    rpc: fake,
    networkPassphrase: PASSPHRASE,
    signer: keypairSigner(facilitator),
    channels: channels.slice(0, n),
    now: () => fake.closeTime * 1000,
    sleep: async () => {},
    ...opts,
  });
  return { fake, submitter };
}

describe("SettlementSubmitter", () => {
  it("sends the delegated-bump shape and advances the channel sequence on success", async () => {
    const { fake, submitter } = setup({}, 1);
    const res = await submitter.submit(call());
    expect(res).toMatchObject({ status: "success", channel: channels[0], feeCharged: 41000n });

    const sent = fake.sent[0];
    expect(sent).toBeInstanceOf(FeeBumpTransaction);
    const bump = sent as FeeBumpTransaction;
    expect(bump.feeSource).toBe(facilitator.publicKey());
    expect(bump.signatures).toHaveLength(1);
    const inner = bump.innerTransaction;
    expect(inner.source).toBe(channels[0]);
    expect(inner.sequence).toBe("1001");
    expect(inner.operations[0]?.source).toBe(facilitator.publicKey());
    // One facilitator signature covers the channel and the operation source.
    expect(inner.signatures).toHaveLength(1);
    expect(fake.sequences.get(channels[0]!)).toBe(1001n);

    await submitter.submit(call());
    expect((fake.sent[1] as FeeBumpTransaction).innerTransaction.sequence).toBe("1002");
    expect(fake.calls.getAccount).toBe(1); // the sequence is tracked locally after the first read
  });

  it("keeps one transaction in flight per channel and queues the rest", async () => {
    const { fake, submitter } = setup({}, 2);
    const results = await Promise.all(Array.from({ length: 5 }, () => submitter.submit(call())));
    expect(results.every((r) => r.status === "success")).toBe(true);
    // Each channel's sequences are contiguous: no gaps, no reuse.
    for (const c of channels.slice(0, 2)) {
      const seqs = fake.sent
        .map((t) => (t as FeeBumpTransaction).innerTransaction)
        .filter((t) => t.source === c)
        .map((t) => BigInt(t.sequence));
      const start = seqs[0]!;
      expect(seqs).toEqual(seqs.map((_, i) => start + BigInt(i)));
    }
    expect(submitter.pool.busy).toBe(0);
  });

  it("re-reads the sequence after txBadSeq and leaves it alone after other rejections", async () => {
    const { fake, submitter } = setup({}, 1);
    await submitter.submit(call());
    fake.sequences.set(channels[0]!, 5000n); // someone else used the channel

    const bad = await submitter.submit(call());
    expect(bad).toMatchObject({ status: "rejected", errorCode: "txBadSeq" });
    const ok = await submitter.submit(call());
    expect(ok.status).toBe("success");
    expect((fake.sent.at(-1) as FeeBumpTransaction).innerTransaction.sequence).toBe("5001");

    fake.sendScript.push("ERROR_INSUFFICIENT_FEE");
    const reads = fake.calls.getAccount;
    const fee = await submitter.submit(call());
    expect(fee).toMatchObject({ status: "rejected", errorCode: "txInsufficientFee" });
    const after = await submitter.submit(call());
    expect(after.status).toBe("success");
    expect(fake.calls.getAccount).toBe(reads); // not re-read: the sequence was not consumed
    expect((fake.sent.at(-1) as FeeBumpTransaction).innerTransaction.sequence).toBe("5002");
  });

  it("resends the same envelope after TRY_AGAIN_LATER", async () => {
    const { fake, submitter } = setup({}, 1);
    fake.sendScript.push("TRY_AGAIN_LATER", "TRY_AGAIN_LATER");
    const res = await submitter.submit(call());
    expect(res.status).toBe("success");
    expect(fake.calls.sendTransaction).toBe(3);
    expect(new Set(fake.sent.map((t) => t.hash().toString("hex"))).size).toBe(1);
  });

  it("does not re-read the sequence when status checks fail while pending", async () => {
    const { fake, submitter } = setup({}, 1);
    fake.statusScript.push("THROW", "THROW", "THROW");
    const res = await submitter.submit(call());
    expect(res.status).toBe("success");
    expect(fake.calls.getAccount).toBe(1);
    const next = await submitter.submit(call());
    expect(next.status).toBe("success");
  });

  it("reports failed on-chain transactions and advances the sequence", async () => {
    const { fake, submitter } = setup({}, 1);
    fake.failOnChain = true;
    const res = await submitter.submit(call());
    expect(res).toMatchObject({ status: "failed", errorCode: "txFailed" });
    fake.failOnChain = false;
    await submitter.submit(call());
    expect((fake.sent.at(-1) as FeeBumpTransaction).innerTransaction.sequence).toBe("1002");
  });

  it("expires a transaction that never lands and reuses its sequence number", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 20 }, 1);
    fake.stalled = true;
    const sent: string[] = [];
    const res = await submitter.submit(call(), { onSent: (h) => sent.push(h) });
    expect(res.status).toBe("expired");
    expect(sent).toEqual([res.hash]);
    expect(fake.sequences.get(channels[0]!)).toBe(1000n);

    fake.stalled = false;
    const next = await submitter.submit(call());
    expect(next.status).toBe("success");
    expect((fake.sent.at(-1) as FeeBumpTransaction).innerTransaction.sequence).toBe("1001");
  });

  it("refuses failed simulations, restores and fees above the limit without sending", async () => {
    const { fake, submitter } = setup({ maxFeeStroops: 50_000 }, 1);
    fake.simulation = "error";
    await expect(submitter.submit(call())).rejects.toBeInstanceOf(SimulationError);
    fake.simulation = "restore";
    await expect(submitter.submit(call())).rejects.toBeInstanceOf(SimulationError);
    fake.simulation = "ok";
    fake.resourceFee = 60_000;
    await expect(submitter.submit(call())).rejects.toBeInstanceOf(FeeLimitError);
    await expect(
      submitter.submit(call(), {
        checkSimulation: () => {
          throw new Error("unexpected balance change");
        },
      }),
    ).rejects.toThrow("unexpected balance change");
    expect(fake.calls.sendTransaction ?? 0).toBe(0);
    expect(submitter.pool.busy).toBe(0);

    fake.resourceFee = 40_000;
    const ok = await submitter.submit(call());
    expect(ok.status).toBe("success");
    expect((fake.sent[0] as FeeBumpTransaction).innerTransaction.sequence).toBe("1001");
  });

  it("rejects a pool that contains the facilitator itself", () => {
    expect(
      () =>
        new SettlementSubmitter({
          rpc: new FakeRpc({}),
          networkPassphrase: PASSPHRASE,
          signer: keypairSigner(facilitator),
          channels: [facilitator.publicKey()],
        }),
    ).toThrow("cannot also be a channel");
  });
});
