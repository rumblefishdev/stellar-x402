import { Address, FeeBumpTransaction, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  FallbackRpc,
  RpcTimeoutError,
  SettlementSubmitter,
  SimulationCheckError,
  checkFacilitatorBalance,
  keypairSigner,
  type SorobanRpc,
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
  return { fake, submitter, events };
}

const innerSeq = (fake: FakeRpc) =>
  (fake.sent.at(-1) as FeeBumpTransaction).innerTransaction.sequence;

describe("uncertain sends", () => {
  it("resends after a thrown send and reports success", async () => {
    const { fake, submitter } = setup();
    fake.sendScript.push("THROW");
    const sent: string[] = [];
    const res = await submitter.submit(call(), { onSent: (h) => sent.push(h) });
    expect(res.status).toBe("success");
    expect(sent).toEqual([res.hash]);
    expect(fake.calls.sendTransaction).toBe(2);
  });

  it("settles by hash when a lost reply's transaction already landed (resend gets txBadSeq)", async () => {
    const { fake, submitter } = setup();
    fake.sendScript.push("ACCEPT_THEN_THROW");
    const res = await submitter.submit(call());
    // The resend saw txBadSeq because the first attempt was applied; that is not a rejection.
    expect(res).toMatchObject({ status: "success", feeCharged: 41000n });
    expect(fake.sequences.get(channels[0]!)).toBe(1001n);
    await submitter.submit(call());
    expect(innerSeq(fake)).toBe("1002");
  });

  it("expires when every send fails, then re-reads the sequence", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 20 });
    fake.sendScript.push(...Array<"THROW">(10).fill("THROW"));
    const res = await submitter.submit(call());
    expect(res.status).toBe("expired");
    const reads = fake.calls.getAccount!;
    fake.sendScript = [];
    const next = await submitter.submit(call());
    expect(next.status).toBe("success");
    expect(fake.calls.getAccount).toBe(reads + 1);
  });

  it("still rejects a plain txBadSeq when no send was uncertain", async () => {
    const { fake, submitter } = setup();
    fake.sequences.set(channels[0]!, 7000n);
    await submitter.submit(call()); // primes the cache, lands at 7001
    fake.sequences.set(channels[0]!, 9000n);
    const res = await submitter.submit(call());
    expect(res).toMatchObject({ status: "rejected", errorCode: "txBadSeq" });
  });
});

describe("sequence reads", () => {
  /** Makes the first `n` getAccount calls throw, as the public RPC did under load. */
  const failReads = (fake: FakeRpc, n: number) => {
    const getAccount = fake.getAccount.bind(fake);
    Object.assign(fake, {
      getAccount: async (address: string) => {
        if (n-- > 0) throw new Error(`Account not found: ${address}`);
        return getAccount(address);
      },
    });
  };

  it("retries a failed sequence read on the next ledger", async () => {
    const { fake, submitter, events } = setup();
    failReads(fake, 2);
    const res = await submitter.submit(call());
    expect(res.status).toBe("success");
    expect(innerSeq(fake)).toBe("1001");
    expect(events.filter((e) => e.type === "read-retry")).toHaveLength(2);
    expect(submitter.stats().readRetries).toBe(2);
  });

  it("refuses without sending once the time bound passes", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 20 });
    failReads(fake, Infinity);
    await expect(submitter.submit(call())).rejects.toThrow("Account not found");
    expect(fake.calls.sendTransaction ?? 0).toBe(0);
    expect(submitter.stats()).toMatchObject({ readRetries: 4, refused: { other: 1 }, busy: 0 });
  });
});

describe("events and stats", () => {
  it("emits sent, retry, final and refused events and folds them into stats", async () => {
    const { fake, submitter, events } = setup({ maxFeeStroops: 50_000 }, 2);
    fake.sendScript.push("TRY_AGAIN_LATER");
    await Promise.all([submitter.submit(call()), submitter.submit(call())]);
    fake.failOnChain = true;
    await submitter.submit(call());
    fake.failOnChain = false;
    fake.resourceFee = 60_000;
    await expect(submitter.submit(call())).rejects.toThrow();
    fake.resourceFee = 40_000;
    await expect(
      submitter.submit(call(), {
        checkSimulation: () => {
          throw new Error("bad balance change");
        },
      }),
    ).rejects.toBeInstanceOf(SimulationCheckError);

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "sent")).toHaveLength(3);
    expect(types.filter((t) => t === "send-retry")).toHaveLength(1);
    expect(types.filter((t) => t === "final")).toHaveLength(3);

    const stats = submitter.stats();
    expect(stats).toMatchObject({
      channels: 2,
      busy: 0,
      queued: 0,
      byStatus: { success: 2, failed: 1, rejected: 0, expired: 0 },
      refused: { "fee-limit": 1, check: 1, simulation: 0, other: 0 },
      errorCodes: { txFailed: 1 },
      sendRetries: 1,
      feesChargedStroops: 123000n,
    });
    expect(Object.values(stats.landingsByLedger).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("keeps settling when a listener throws", async () => {
    const { submitter } = setup({
      onEvent: () => {
        throw new Error("listener bug");
      },
    });
    expect((await submitter.submit(call())).status).toBe("success");
  });
});

/** An endpoint whose every method fails, hangs or answers, as configured. */
function endpoint(behaviour: "ok" | "fail" | "hang", calls: string[] = []): SorobanRpc {
  const answer = (name: string, value: unknown) => () => {
    calls.push(name);
    if (behaviour === "fail") return Promise.reject(new Error(`${name} failed`));
    if (behaviour === "hang") return new Promise(() => {});
    return Promise.resolve(value);
  };
  return {
    getAccount: answer("getAccount", "acct"),
    getAccountEntry: answer("getAccountEntry", "entry"),
    simulateTransaction: answer("simulateTransaction", "sim"),
    sendTransaction: answer("sendTransaction", "sent"),
    getTransaction: answer("getTransaction", "tx"),
    getLatestLedger: answer("getLatestLedger", { sequence: 1 }),
    getFeeStats: answer("getFeeStats", "fees"),
  } as unknown as SorobanRpc;
}

describe("FallbackRpc", () => {
  it("moves to the next endpoint on failure and stays there", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const switches: string[] = [];
    const rpc = new FallbackRpc(
      [
        { name: "a", rpc: endpoint("fail", a) },
        { name: "b", rpc: endpoint("ok", b) },
      ],
      { onSwitch: (from, to) => switches.push(`${from}->${to}`) },
    );
    expect(await rpc.getLatestLedger()).toEqual({ sequence: 1 });
    expect(rpc.active).toBe("b");
    await rpc.getTransaction("h");
    expect(a).toEqual(["getLatestLedger"]);
    expect(b).toEqual(["getLatestLedger", "getTransaction"]);
    expect(switches).toEqual(["a->b"]);
  });

  it("treats a timeout as a failure", async () => {
    const rpc = new FallbackRpc(
      [
        { name: "slow", rpc: endpoint("hang") },
        { name: "fast", rpc: endpoint("ok") },
      ],
      { timeoutMs: 10 },
    );
    expect(await rpc.getFeeStats()).toBe("fees");
    expect(rpc.active).toBe("fast");
  });

  it("throws the first error and keeps the active endpoint when all fail", async () => {
    const rpc = new FallbackRpc([
      { name: "a", rpc: endpoint("fail") },
      { name: "b", rpc: endpoint("fail") },
    ]);
    await expect(rpc.getAccount("G")).rejects.toThrow("getAccount failed");
    expect(rpc.active).toBe("a");
  });

  it("never retries sendTransaction itself, but moves on for the next call", async () => {
    const b: string[] = [];
    const rpc = new FallbackRpc([
      { name: "a", rpc: endpoint("fail") },
      { name: "b", rpc: endpoint("ok", b) },
    ]);
    await expect(
      rpc.sendTransaction(undefined as unknown as Parameters<SorobanRpc["sendTransaction"]>[0]),
    ).rejects.toThrow("sendTransaction failed");
    expect(b).toEqual([]);
    expect(rpc.active).toBe("b");
  });

  it("reports timeouts as RpcTimeoutError", async () => {
    const rpc = new FallbackRpc([{ name: "slow", rpc: endpoint("hang") }], { timeoutMs: 5 });
    await expect(rpc.getLatestLedger()).rejects.toBeInstanceOf(RpcTimeoutError);
  });
});

describe("checkFacilitatorBalance", () => {
  function entry(
    balance: bigint,
    subEntries: number,
    ext?: { selling: bigint; sponsoring?: number; sponsored?: number },
  ) {
    return {
      balance: () => xdr.Int64.fromString(balance.toString()),
      numSubEntries: () => subEntries,
      ext: () =>
        ext
          ? {
              switch: () => 1,
              v1: () => ({
                liabilities: () => ({
                  selling: () => xdr.Int64.fromString(ext.selling.toString()),
                }),
                ext: () =>
                  ext.sponsoring !== undefined
                    ? {
                        switch: () => 2,
                        v2: () => ({
                          numSponsoring: () => ext.sponsoring,
                          numSponsored: () => ext.sponsored ?? 0,
                        }),
                      }
                    : { switch: () => 0 },
              }),
            }
          : { switch: () => 0 },
    } as unknown as xdr.AccountEntry;
  }
  const addr = Keypair.random().publicKey();

  it("subtracts the reserve and estimates settlements left", async () => {
    const r = await checkFacilitatorBalance(
      { getAccountEntry: async () => entry(2_000_000_000n, 0) },
      addr,
    );
    expect(r.reserveStroops).toBe(10_000_000n);
    expect(r.spendableStroops).toBe(1_990_000_000n);
    expect(r.settlementsLeft).toBe(44_222);
    expect(r.low).toBe(false);
  });

  it("counts sub-entries, sponsorships and selling liabilities, and flags a low balance", async () => {
    const r = await checkFacilitatorBalance(
      {
        getAccountEntry: async () =>
          entry(600_000_000n, 2, { selling: 100_000_000n, sponsoring: 3, sponsored: 1 }),
      },
      addr,
      { minSpendableStroops: 500_000_000n },
    );
    expect(r.reserveStroops).toBe(30_000_000n); // (2 + 2 + 3 - 1) x 0.5 XLM
    expect(r.spendableStroops).toBe(470_000_000n);
    expect(r.low).toBe(true);
  });
});
