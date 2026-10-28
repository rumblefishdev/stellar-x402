import { Address, FeeBumpTransaction, Keypair, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  LedgerBoundError,
  SettlementSubmitter,
  SignedHookError,
  SourceAccountAuthError,
  attemptsOf,
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

/** An auth entry for a `drain` call with `credentials`. */
const authEntry = (credentials: xdr.SorobanCredentials) =>
  new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(
            StrKey.encodeContract(Buffer.alloc(32, 9)),
          ).toScAddress(),
          functionName: "drain",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });

/** Address credentials for a random account; `v2` for CAP-71's `AddressV2`. */
const addressCredentials = (v2 = false) => {
  const credentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(Keypair.random().publicKey()).toScAddress(),
    nonce: xdr.Int64.fromString("1"),
    signatureExpirationLedger: 1_000,
    signature: xdr.ScVal.scvVoid(),
  });
  return v2
    ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials)
    : xdr.SorobanCredentials.sorobanCredentialsAddress(credentials);
};

describe("source-account auth", () => {
  it("refuses a call whose auth would authorize as the facilitator, before taking a channel", async () => {
    const { fake, submitter, signer } = setup();
    const entry = authEntry(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
    await expect(submitter.submit({ ...call(), auth: [entry] })).rejects.toBeInstanceOf(
      SourceAccountAuthError,
    );
    expect(signer.signs).toBe(0);
    expect(fake.sent).toHaveLength(0);
    expect(submitter.stats()).toMatchObject({ busy: 0, refused: { check: 1 } });
  });

  it("refuses a source-account entry behind address entries", async () => {
    const { fake, submitter } = setup();
    const auth = [
      authEntry(addressCredentials()),
      authEntry(addressCredentials(true)),
      authEntry(xdr.SorobanCredentials.sorobanCredentialsSourceAccount()),
    ];
    await expect(submitter.submit({ ...call(), auth })).rejects.toBeInstanceOf(
      SourceAccountAuthError,
    );
    expect(fake.sent).toHaveLength(0);
  });

  it("submits Address and AddressV2 entries", async () => {
    const { fake, submitter } = setup();
    const auth = [authEntry(addressCredentials()), authEntry(addressCredentials(true))];
    await expect(submitter.submit({ ...call(), auth })).resolves.toMatchObject({
      status: "success",
    });
    expect(fake.sent).toHaveLength(1);
  });
});

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

  it("is given the envelope's bounds, so a stored hash can be resolved after a crash", async () => {
    const { fake, submitter } = setup();
    const maxLedger = fake.ledger + 10;
    const given: unknown[] = [];
    await submitter.submit(call(), { maxLedger, onSigned: (_, bounds) => void given.push(bounds) });
    // A ledger-bounded envelope has no time bound (0073 decision 1).
    expect(given).toEqual([{ maxLedger }]);

    // Without a ledger bound only the time bound is given.
    given.length = 0;
    await submitter.submit(call(), { onSigned: (_, bounds) => void given.push(bounds) });
    expect(given).toEqual([{ maxTime: Number(inner(fake).timeBounds?.maxTime) }]);
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

    expect(res.attempts).toEqual([
      { hash: hashes[0], sent: "yes" }, // refused with txBadSeq
      { hash: hashes[1], sent: "yes" },
    ]);

    fake.sequences.set(channels[0]!, 12_000n);
    const before = fake.sent.length;
    const stored: string[] = [];
    const error = await submitter
      .submit(call(), {
        onSigned: async (h) => {
          stored.push(h);
          if (stored.length === 2) throw new Error("store down");
        },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignedHookError);
    expect(fake.sent.length - before).toBe(1); // the first envelope only, rejected as txBadSeq
    // The rejection says one envelope reached the network and the rebuild's did not.
    expect(attemptsOf(error)).toEqual([
      { hash: stored[0], sent: "yes" },
      { hash: stored[1], sent: "no" },
    ]);
  });

  it("gives up on a hook that never settles at the time bound, and sends nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { fake, submitter } = setup({ timeoutSeconds: 30, onSignedTimeoutMs: 60_000 });
      const error = submitter
        .submit(call(), { onSigned: () => new Promise<void>(() => {}) })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await error).toBeInstanceOf(SignedHookError);
      expect((await error) as SignedHookError).toHaveProperty(
        "message",
        expect.stringMatching(/time bound/),
      );
      expect(attemptsOf(await error)).toEqual([{ hash: expect.any(String), sent: "no" }]);
      expect(fake.sent).toHaveLength(0);
      expect(submitter.stats()).toMatchObject({ busy: 0, refused: { "on-signed": 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a hook that never settles at the ledger bound, long before the time bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { fake, submitter } = setup({ timeoutSeconds: 600, onSignedTimeoutMs: 60_000 });
      const maxLedger = fake.ledger + 3;
      const error = submitter
        .submit(call(), { maxLedger, onSigned: () => new Promise<void>(() => {}) })
        .catch((e: unknown) => e);
      // One poll interval in, the wait follows the ledger clock to the bound.
      await vi.advanceTimersByTimeAsync(1000);
      const e = await error;
      expect(e).toBeInstanceOf(SignedHookError);
      expect((e as SignedHookError).message).toMatch(/ledger bound/);
      expect(fake.ledger).toBe(maxLedger);
      expect(fake.sent).toHaveLength(0);
      expect(submitter.stats()).toMatchObject({ busy: 0, refused: { "on-signed": 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a hook that never settles after onSignedTimeoutMs, 5 s by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { fake, submitter } = setup({ timeoutSeconds: 600 });
      const error = submitter
        .submit(call(), { onSigned: () => new Promise<void>(() => {}) })
        .catch((e: unknown) => e);
      let done = false;
      void error.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await error).toBeInstanceOf(SignedHookError);
      expect((await error) as SignedHookError).toHaveProperty(
        "message",
        expect.stringMatching(/5000 ms/),
      );
      expect(fake.sent).toHaveLength(0);
      expect(submitter.stats()).toMatchObject({ busy: 0, refused: { "on-signed": 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an onSignedTimeoutMs that is not above 0", () => {
    for (const onSignedTimeoutMs of [0, -1, Number.NaN])
      expect(() => setup({ onSignedTimeoutMs })).toThrow(/onSignedTimeoutMs/);
  });

  it("reports expired, sending nothing, when the time bound passes while it runs", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 60 });
    const res = await submitter.submit(call(), {
      onSigned: () => void (fake.closeTime += 120),
    });
    expect(res.status).toBe("expired");
    expect(fake.sent).toHaveLength(0);
  });

  it("rejects a pipelined call's send and hands the channel on at the right sequence", async () => {
    const events: string[] = [];
    const { fake, submitter } = setup({
      onEvent: (e) => {
        if (e.type === "prepared-ahead") events.push(`prepared-ahead used=${e.used}`);
      },
    });
    // One channel: the second call is prepared ahead while the first is pending, then its hook
    // rejects. The third must get the channel only after that, at the sequence after the first.
    const first = submitter.submit(call());
    const second = submitter
      .submit(call(), { onSigned: () => Promise.reject(new Error("store down")) })
      .catch((e: unknown) => e);
    const third = submitter.submit(call());
    expect((await first).status).toBe("success");
    expect(await second).toBeInstanceOf(SignedHookError);
    expect((await third).status).toBe("success");
    expect(events).toEqual(["prepared-ahead used=true"]);
    expect(fake.sent.map((t) => (t as FeeBumpTransaction).innerTransaction.sequence)).toEqual([
      "1001",
      "1002",
    ]);
    expect(submitter.stats()).toMatchObject({ busy: 0, queued: 0, refused: { "on-signed": 1 } });
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
    // No time bound may end it before its authorization expires (0073 decision 1).
    expect(Number(inner(fake).timeBounds?.maxTime)).toBe(0);
  });

  it(
    "confirms a ledger-bounded envelope past 60 s and calls it expired only after its ledger bound (0073)",
    { timeout: 5_000 },
    async () => {
      // 5 s ledgers: 30 ledgers is 150 s, well past the 60 s a time bound would allow.
      const { fake, submitter } = setup();
      fake.stalled = true;
      const start = { time: fake.closeTime };
      const maxLedger = fake.ledger + 30;
      const res = await submitter.submit(call(), { maxLedger });
      expect(res.status).toBe("expired");
      expect(fake.ledger).toBeGreaterThanOrEqual(maxLedger);
      expect(fake.closeTime - start.time).toBeGreaterThan(60);
      // The channel is back once it can no longer land.
      expect(submitter.stats()).toMatchObject({ busy: 0 });
    },
  );

  it("answers success for a ledger-bounded envelope that lands after 60 s (0073)", async () => {
    const { fake, submitter } = setup();
    fake.stalled = true;
    const start = fake.closeTime;
    const close = fake.getLatestLedger.bind(fake);
    Object.assign(fake, {
      getLatestLedger: async () => {
        if (fake.closeTime - start >= 120) fake.stalled = false; // lands at about 2 minutes
        return close();
      },
    });
    const res = await submitter.submit(call(), { maxLedger: fake.ledger + 60 });
    expect(res.status).toBe("success");
    expect(fake.closeTime - start).toBeGreaterThan(60);
  });

  it("answers pending at about ledgers left × 6 s plus grace, counted from the simulation's ledger (0073)", async () => {
    // A real network's ledger sequence, and a clock that never polled: counting from it would
    // put the answer months ahead. No ledger closes, as time passes, so nothing confirms.
    const { fake, submitter } = setup();
    fake.ledger = 5_434_800;
    fake.stalled = true;
    const start = fake.closeTime;
    const close = fake.getLatestLedger.bind(fake);
    fake.getLatestLedger = async () => {
      fake.closeTime += fake.ledgerSeconds;
      return { sequence: fake.ledger } as rpc.Api.GetLatestLedgerResponse;
    };
    const res = await submitter.submit(call(), { maxLedger: fake.ledger + 60 });
    expect(res.status).toBe("pending");
    const waited = fake.closeTime - start;
    // Ledgers close again, so the confirmation that runs on can end (expired).
    fake.getLatestLedger = close;
    expect(waited).toBeGreaterThanOrEqual(60 * 6 + 30);
    expect(waited).toBeLessThan(60 * 6 + 30 + 30);
  }, 5_000);

  it("ends a resend's wait for a ledger-bounded envelope when the RPC stops answering (0073)", async () => {
    // TRY_AGAIN_LATER, then no ledger read ever answers: the wait for the next ledger has no
    // time bound to end it, so it ends at about when the ledger bound would pass.
    const { fake, submitter } = setup();
    fake.sendScript.push("TRY_AGAIN_LATER");
    const start = fake.closeTime;
    const close = fake.getLatestLedger.bind(fake);
    fake.getLatestLedger = async () => {
      fake.closeTime += fake.ledgerSeconds;
      throw new Error("rpc down");
    };
    const res = await submitter.submit(call(), { maxLedger: fake.ledger + 20 });
    const waited = fake.closeTime - start;
    // The RPC answers again, so the confirmation that runs on can end.
    fake.getLatestLedger = close;
    expect(res.status).toBe("pending");
    expect(waited).toBeLessThan(20 * 6 + 30 + 30);
  }, 5_000);

  it("keeps the time bound for a call without a ledger bound", async () => {
    const { fake, submitter } = setup();
    await submitter.submit(call());
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
    // 101 is its last ledger: one spare ledger is kept, so that is refused too.
    await expect(submitter.submit(call(), { maxLedger: fake.ledger + 1 })).rejects.toBeInstanceOf(
      LedgerBoundError,
    );
    expect(signer.signs).toBe(0);
    expect(fake.sent).toHaveLength(0);
    expect(submitter.stats()).toMatchObject({ busy: 0, refused: { "ledger-bound": 2 } });

    const res = await submitter.submit(call(), { maxLedger: fake.ledger + 2 });
    expect(res.status).toBe("success");
  });

  it("reports expired once the ledger bound passes, before the time bound", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 600 });
    fake.stalled = true;
    const start = fake.ledger;
    const res = await submitter.submit(call(), { maxLedger: start + 3 });
    expect(res.status).toBe("expired");
    // 600 s is 120 ledgers at 5 s; the ledger bound ended the wait as soon as it closed.
    expect(fake.ledger).toBe(start + 3);

    // The sequence was not used, so the channel is reused at the same number.
    fake.stalled = false;
    const next = await submitter.submit(call());
    expect(next.status).toBe("success");
    expect(inner(fake).sequence).toBe("1001");
  });

  it("waits for a transaction that lands in exactly maxLedger", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 600 });
    const maxLedger = fake.ledger + 3;
    // The network includes nothing before maxLedger, and closes maxLedger only once the
    // submitter has seen the transaction still missing in the ledger before it.
    let missingBefore = false;
    const getTransaction = fake.getTransaction.bind(fake);
    fake.getTransaction = async (hash) => {
      const res = await getTransaction(hash);
      if (res.latestLedger === maxLedger - 1) missingBefore = true;
      return res;
    };
    const close = fake.getLatestLedger.bind(fake);
    fake.getLatestLedger = async () => {
      if (fake.ledger === maxLedger - 1 && !missingBefore)
        return {
          id: String(fake.ledger),
          sequence: fake.ledger,
          protocolVersion: "29",
          closeTime: String(fake.closeTime),
        } as rpc.Api.GetLatestLedgerResponse;
      fake.stalled = fake.ledger + 1 < maxLedger;
      return close();
    };
    const res = await submitter.submit(call(), { maxLedger });
    expect(missingBefore).toBe(true);
    expect(res).toMatchObject({ status: "success", ledger: maxLedger });
  });

  it("stops resending once the ledger bound closes", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 600 });
    const maxLedger = fake.ledger + 3;
    fake.sendScript = Array(20).fill("TRY_AGAIN_LATER");
    const sentAt: number[] = [];
    const send = fake.sendTransaction.bind(fake);
    fake.sendTransaction = (tx) => {
      sentAt.push(fake.ledger);
      return send(tx);
    };
    const res = await submitter.submit(call(), { maxLedger });
    expect(res.status).toBe("expired");
    expect(res.errorCode).toBeUndefined(); // ended by the submitter, not by a txTooLate
    expect(res.attempts).toEqual([{ hash: res.hash, sent: "no" }]); // never taken
    // Retried on new ledgers, and never once the clock reached the bound.
    expect(sentAt.length).toBeGreaterThan(1);
    expect(sentAt.every((l) => l < maxLedger)).toBe(true);
  });

  it("marks an attempt whose sends all threw as unknown", async () => {
    const { fake, submitter } = setup({ timeoutSeconds: 600 });
    fake.sendScript = Array(20).fill("THROW");
    const res = await submitter.submit(call(), { maxLedger: fake.ledger + 3 });
    expect(res.status).toBe("expired"); // confirmed by hash: it never landed
    expect(res.attempts).toEqual([{ hash: res.hash, sent: "unknown" }]);
  });

  it("refuses a pipelined envelope with no spare ledger left, without simulating again", async () => {
    const events: string[] = [];
    const { fake, submitter } = setup({
      onEvent: (e) => {
        if (e.type === "prepared-ahead") events.push(`prepared-ahead used=${e.used}`);
      },
    });
    // One channel: the second call is prepared while the first is pending, which the fake
    // includes in ledger 101 (the prepared envelope is simulated there). Its last ledger is 105,
    // and the clock is at 104 when it is checked: no spare ledger, so it isn't sent.
    const first = submitter.submit(call());
    const second = submitter
      .submit(call(), { maxLedger: fake.ledger + 5 })
      .catch((e: unknown) => e);
    expect((await first).status).toBe("success");
    expect(await second).toBeInstanceOf(LedgerBoundError);
    expect(attemptsOf(await second)).toEqual([]); // signed ahead, but never sent
    expect(events).toEqual(["prepared-ahead used=false"]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.calls.simulateTransaction).toBe(2); // the first call and the one prepared ahead
  });

  it("reports expired, not rejected, when the ledger bound passes between signing and sending", async () => {
    const { fake, submitter } = setup();
    // The simulation sees 100, so 102 leaves a spare ledger; the hook lets three ledgers close
    // behind the clock's back.
    const res = await submitter.submit(call(), {
      maxLedger: fake.ledger + 2,
      onSigned: async () => {
        for (let i = 0; i < 3; i++) await fake.getLatestLedger();
      },
    });
    expect(res).toMatchObject({ status: "expired", errorCode: "txTooLate" });
    expect(fake.sent).toHaveLength(1); // the network refused it with txTooLate

    // Nothing was applied, so the channel is reused at the same sequence.
    const next = await submitter.submit(call());
    expect(next.status).toBe("success");
    expect(inner(fake).sequence).toBe("1001");
  });

  it.each([Number.NaN, 1.5, 0, -1, 2 ** 32 - 1])("throws for maxLedger %s", async (maxLedger) => {
    const { fake, submitter } = setup();
    await expect(submitter.submit(call(), { maxLedger })).rejects.toBeInstanceOf(RangeError);
    expect(fake.calls.simulateTransaction).toBeUndefined();
    expect(submitter.stats()).toMatchObject({ busy: 0 });
  });
});
