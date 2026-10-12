import { Address, FeeBumpTransaction, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  LedgerBoundError,
  SettlementSubmitter,
  SignedHookError,
  keypairSigner,
  type SubmitterOptions,
  type TransactionSigner,
} from "../src/index.js";
import { FakeRpc, channels, facilitator } from "./fake-rpc.js";

// The two library changes the T1 facilitator needs (task 0016): an awaited `onSigned`, so the
// hash is stored before anything is sent (AD-16), and `maxLedger`, so no transaction outlives
// the client's authorization (AD-22).

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
  const inner = keypairSigner(facilitator);
  const signer = {
    address: inner.address,
    signs: 0,
    signTransaction(xdr: string, o: { networkPassphrase: string }) {
      this.signs++;
      return inner.signTransaction(xdr, o);
    },
  } satisfies TransactionSigner & { signs: number };
  const submitter = new SettlementSubmitter({
    rpc: fake,
    networkPassphrase: PASSPHRASE,
    signer,
    channels: channels.slice(0, n),
    now: () => fake.closeTime * 1000,
    sleep: async () => {},
    ...opts,
  });
  return { fake, submitter, signer };
}

const inner = (fake: FakeRpc, i = -1) => (fake.sent.at(i) as FeeBumpTransaction).innerTransaction;

describe("onSigned", () => {
  it("is awaited before the first send", async () => {
    const { fake, submitter } = setup();
    const log: string[] = [];
    const res = await submitter.submit(call(), {
      onSigned: async (hash) => {
        await new Promise((r) => setTimeout(r, 5));
        log.push(`stored ${hash} after ${fake.calls.sendTransaction ?? 0} sends`);
      },
    });
    expect(res.status).toBe("success");
    expect(log).toEqual([`stored ${res.hash} after 0 sends`]);
  });

  it("sends nothing and frees the channel when it rejects", async () => {
    const { fake, submitter } = setup();
    const failure = new Error("store down");
    const error = await submitter
      .submit(call(), { onSigned: () => Promise.reject(failure) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignedHookError);
    expect((error as SignedHookError).cause).toBe(failure);
    expect(fake.calls.sendTransaction).toBeUndefined();
    expect(submitter.stats()).toMatchObject({ busy: 0, refused: { "on-signed": 1 } });

    // The channel is back in the pool with its sequence untouched.
    const res = await submitter.submit(call());
    expect(res.status).toBe("success");
    expect(inner(fake).sequence).toBe("1001");
  });

  it("treats a hook that throws synchronously the same way", async () => {
    const { fake, submitter } = setup();
    await expect(
      submitter.submit(call(), {
        onSigned: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toBeInstanceOf(SignedHookError);
    expect(fake.sent).toHaveLength(0);
  });

  it("is awaited again for the rebuild after a txBadSeq, and a rejection stops the rebuild", async () => {
    const { fake, submitter } = setup();
    await submitter.submit(call()); // primes the cached sequence: lands at 1001
    fake.sequences.set(channels[0]!, 9000n);

    const hashes: string[] = [];
    const res = await submitter.submit(call(), { onSigned: (h) => void hashes.push(h) });
    expect(res.status).toBe("success");
    expect(hashes).toHaveLength(2);
    expect(hashes[1]).toBe(res.hash);
    expect(hashes[0]).not.toBe(hashes[1]);

    fake.sequences.set(channels[0]!, 12_000n);
    const before = fake.sent.length;
    let calls = 0;
    await expect(
      submitter.submit(call(), {
        onSigned: async () => {
          if (++calls === 2) throw new Error("store down");
        },
      }),
    ).rejects.toBeInstanceOf(SignedHookError);
    expect(fake.sent.length - before).toBe(1); // the first envelope only, rejected as txBadSeq
  });
});

describe("maxLedger", () => {
  it("bounds the transaction to the last ledger it may land in", async () => {
    const { fake, submitter } = setup();
    const maxLedger = fake.ledger + 10;
    const res = await submitter.submit(call(), { maxLedger });
    expect(res.status).toBe("success");
    // A ledger bound's maxLedger is exclusive.
    expect(inner(fake).ledgerBounds).toEqual({ minLedger: 0, maxLedger: maxLedger + 1 });
    expect(Number(inner(fake).timeBounds?.maxTime)).toBeGreaterThan(0);
  });

  it("leaves the ledger bound off when the caller sets none", async () => {
    const { fake, submitter } = setup();
    await submitter.submit(call());
    expect(inner(fake).ledgerBounds).toBeUndefined();
  });

  it("refuses before signing a call that can't land by maxLedger", async () => {
    const { fake, submitter, signer } = setup();
    // The simulation sees ledger 100, so the earliest the call can land is 101.
    await expect(submitter.submit(call(), { maxLedger: fake.ledger })).rejects.toBeInstanceOf(
      LedgerBoundError,
    );
    expect(signer.signs).toBe(0);
    expect(fake.sent).toHaveLength(0);
    expect(submitter.stats()).toMatchObject({ busy: 0, refused: { "ledger-bound": 1 } });

    const res = await submitter.submit(call(), { maxLedger: fake.ledger + 1 });
    expect(res.status).toBe("success");
  });

  it("reports expired once the ledger bound passes, before the time bound", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 600 });
    fake.stalled = true;
    const start = fake.ledger;
    const res = await submitter.submit(call(), { maxLedger: start + 3 });
    expect(res.status).toBe("expired");
    // 600 s is 120 ledgers at 5 s; the ledger bound ended the wait after a few.
    expect(fake.ledger - start).toBeLessThan(10);

    // The sequence was not used, so the channel is reused at the same number.
    fake.stalled = false;
    const next = await submitter.submit(call());
    expect(next.status).toBe("success");
    expect(inner(fake).sequence).toBe("1001");
  });

  it("rebuilds a pipelined envelope that would land past its bound, then refuses it", async () => {
    const events: string[] = [];
    const { fake, submitter } = setup({
      onEvent: (e) => {
        if (e.type === "prepared-ahead") events.push(`prepared-ahead used=${e.used}`);
      },
    });
    // One channel: the second call is prepared while the first is pending, which the fake
    // includes in ledger 101 (the prepared envelope is simulated there). Its last ledger is 102,
    // already closed when the first is final, so the prepared envelope can't be sent.
    const first = submitter.submit(call());
    const second = submitter
      .submit(call(), { maxLedger: fake.ledger + 2 })
      .catch((e: unknown) => e);
    expect((await first).status).toBe("success");
    expect(await second).toBeInstanceOf(LedgerBoundError);
    expect(events).toEqual(["prepared-ahead used=false"]);
    expect(fake.sent).toHaveLength(1);
  });
});
