import { describe, expect, it } from "vitest";
import {
  FallbackRpc,
  RpcTimeoutError,
  RpcUnavailableError,
  type FallbackRpcOptions,
  type SorobanRpc,
} from "../src/index.js";

// FallbackRpc's reads of chain state (getLatestLedger, getLedgerEntries, getFeeStats) are hedged:
// a slow active endpoint gets company from every other endpoint after `hedgeDelayMs`, and the
// first answer wins. The calls of a transaction's lifecycle (simulate, send, getTransaction) stay
// on one endpoint at a time.

const HEDGE = 20;
const TIMEOUT = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One call an endpoint received, held until the test answers or fails it. */
interface Asked {
  method: string;
  at: number;
  answer(value: unknown): void;
  fail(error: unknown): void;
}

/**
 * An endpoint that holds every call until the test answers it. While `reply` is set, it answers
 * each call at once with `reply(method)` (or fails with what `reply` throws).
 */
function heldEndpoint() {
  const asked: Asked[] = [];
  const state = { reply: undefined as ((method: string) => unknown) | undefined };
  const method = (name: string) => () =>
    new Promise((resolve, reject) => {
      asked.push({ method: name, at: Date.now(), answer: resolve, fail: reject });
      if (!state.reply) return;
      try {
        resolve(state.reply(name));
      } catch (error) {
        reject(error);
      }
    });
  const rpc = {
    getLatestLedger: method("getLatestLedger"),
    getLedgerEntries: method("getLedgerEntries"),
    getFeeStats: method("getFeeStats"),
    simulateTransaction: method("simulateTransaction"),
    getTransaction: method("getTransaction"),
    sendTransaction: method("sendTransaction"),
  } as unknown as SorobanRpc;
  /** The n-th call this endpoint received (1-based), waiting up to 1 s for it to arrive. */
  async function call(n = 1): Promise<Asked> {
    const deadline = Date.now() + 1_000;
    while (asked.length < n) {
      if (Date.now() > deadline) throw new Error(`call ${n} never arrived`);
      await sleep(1);
    }
    return asked[n - 1]!;
  }
  return { rpc, asked, state, call };
}

/** The answer of a read at `ledger`, in the shape of each method. */
function atLedger(ledger: number) {
  return (method: string) => {
    if (method === "getLatestLedger") return { sequence: ledger };
    if (method === "getLedgerEntries") return { entries: [], latestLedger: ledger };
    return { latestLedger: ledger };
  };
}

/** Endpoints a, b, c (the first `count` of them) behind one FallbackRpc. */
function setup(count: 1 | 2 | 3, opts: FallbackRpcOptions = {}) {
  const a = heldEndpoint();
  const b = heldEndpoint();
  const c = heldEndpoint();
  const switches: string[] = [];
  const errors: unknown[] = [];
  const endpoints = [
    { name: "a", rpc: a.rpc },
    { name: "b", rpc: b.rpc },
    { name: "c", rpc: c.rpc },
  ].slice(0, count);
  const options = {
    hedgeDelayMs: HEDGE,
    timeoutMs: TIMEOUT,
    onSwitch: (from: string, to: string, error: unknown, by: string) => {
      switches.push(`${from}->${to} by ${by}`);
      errors.push(error);
    },
    ...opts,
  } as FallbackRpcOptions;
  const rpc = new FallbackRpc(endpoints, options);
  return { rpc, a, b, c, switches, errors };
}

type Tx = Parameters<SorobanRpc["sendTransaction"]>[0];
const noTx = undefined as unknown as Tx;

describe("FallbackRpc hedged reads", () => {
  it("asks every other endpoint at once when the active has not answered within hedgeDelayMs", async () => {
    const { rpc, a, b, c } = setup(3);
    const started = Date.now();
    const read = rpc.getLatestLedger();
    const [toB, toC] = await Promise.all([b.call(), c.call()]);
    // Both were asked while neither had answered: together, not one after the other's failure.
    expect(toB.at - started).toBeGreaterThanOrEqual(HEDGE - 2);
    expect(toC.at - started).toBeLessThan(TIMEOUT / 2);
    expect(Math.abs(toB.at - toC.at)).toBeLessThan(HEDGE);
    (await a.call()).answer({ sequence: 100 });
    expect(await read).toEqual({ sequence: 100 });
  });

  it("asks the others at once, without waiting for hedgeDelayMs, when the active fails first", async () => {
    const { rpc, a, b } = setup(2, { hedgeDelayMs: 1_000, timeoutMs: 2_000 });
    const started = Date.now();
    const read = rpc.getLatestLedger();
    (await a.call()).fail(new Error("a down"));
    const toB = await b.call();
    expect(toB.at - started).toBeLessThan(500);
    toB.answer({ sequence: 100 });
    expect(await read).toEqual({ sequence: 100 });
  });

  it("asks nobody else when the active answers within hedgeDelayMs", async () => {
    const { rpc, a, b, c } = setup(3);
    a.state.reply = atLedger(100);
    expect(await rpc.getFeeStats()).toEqual({ latestLedger: 100 });
    await sleep(HEDGE * 3);
    expect(b.asked).toEqual([]);
    expect(c.asked).toEqual([]);
  });

  it("returns the first successful answer, from whichever endpoint gives it", async () => {
    const { rpc, a, b } = setup(2);
    const read = rpc.getLatestLedger();
    await a.call();
    (await b.call()).answer({ sequence: 100 });
    expect(await read).toEqual({ sequence: 100 });
  });

  it("returns the third endpoint's fast answer when the first two hang", async () => {
    const { rpc, c } = setup(3);
    c.state.reply = atLedger(100);
    const started = Date.now();
    expect(await rpc.getLatestLedger()).toEqual({ sequence: 100 });
    // Asked at hedgeDelayMs, not after the first two timed out.
    expect((await c.call()).at - started).toBeLessThan(TIMEOUT / 2);
  });

  it("measures each endpoint's timeout from when that endpoint was asked", async () => {
    const { rpc, b } = setup(2, { hedgeDelayMs: 100, timeoutMs: 200 });
    const read = rpc.getLatestLedger();
    const toB = await b.call();
    // 250 ms after the read began: past a's timeout (200), within b's (100 + 200).
    await sleep(150);
    toB.answer({ sequence: 100 });
    expect(await read).toEqual({ sequence: 100 });
  });

  it("throws RpcUnavailableError with the active's error and keeps the active when every endpoint fails", async () => {
    const { rpc, a, b, c, switches } = setup(3);
    const aError = new Error("a down");
    const read = rpc.getLedgerEntries().catch((e: unknown) => e);
    (await a.call()).fail(aError);
    (await b.call()).fail(new Error("b down"));
    (await c.call()).fail(new Error("c down"));
    const error = await read;
    expect(error).toBeInstanceOf(RpcUnavailableError);
    expect((error as Error).cause).toBe(aError);
    expect(rpc.active).toBe("a");
    expect(switches).toEqual([]);
  });

  it("names the active's timeout as the cause when it timed out and the others threw", async () => {
    const { rpc, b } = setup(2, { timeoutMs: 60 });
    const read = rpc.getFeeStats().catch((e: unknown) => e);
    (await b.call()).fail(new Error("b down"));
    const error = await read;
    expect(error).toBeInstanceOf(RpcUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(RpcTimeoutError);
    expect(rpc.active).toBe("a");
  });

  it("returns an answer with no entries from the active and asks nobody else", async () => {
    const { rpc, a, b } = setup(2);
    a.state.reply = () => ({ entries: [], latestLedger: 100 });
    expect(await rpc.getLedgerEntries()).toEqual({ entries: [], latestLedger: 100 });
    await sleep(HEDGE * 3);
    expect(b.asked).toEqual([]);
    expect(rpc.active).toBe("a");
  });
});

describe("FallbackRpc promotion of a hedged winner", () => {
  it("makes a winner that is not lagging the active endpoint and calls onSwitch once with the method", async () => {
    const { rpc, b, switches } = setup(2);
    b.state.reply = atLedger(100);
    expect(await rpc.getLatestLedger()).toEqual({ sequence: 100 });
    expect(rpc.active).toBe("b");
    expect(switches).toEqual(["a->b by getLatestLedger"]);
  });

  it("returns a winner's answer but does not promote it when it trails the highest ledger seen by more than maxLagLedgers", async () => {
    const { rpc, a, b, switches } = setup(2, { maxLagLedgers: 2 });
    const first = rpc.getLatestLedger();
    (await a.call()).answer({ sequence: 103 });
    await first;
    b.state.reply = atLedger(100);
    expect(await rpc.getLatestLedger()).toEqual({ sequence: 100 });
    expect(rpc.active).toBe("a");
    expect(switches).toEqual([]);
  });

  it("promotes a winner that trails the highest ledger seen by exactly maxLagLedgers", async () => {
    const { rpc, a, b, switches } = setup(2, { maxLagLedgers: 2 });
    const first = rpc.getLatestLedger();
    (await a.call()).answer({ sequence: 103 });
    await first;
    b.state.reply = atLedger(101);
    expect(await rpc.getLatestLedger()).toEqual({ sequence: 101 });
    expect(rpc.active).toBe("b");
    expect(switches).toEqual(["a->b by getLatestLedger"]);
  });

  it("allows a lag of 2 ledgers by default", async () => {
    const { rpc, a, b } = setup(2);
    const first = rpc.getLatestLedger();
    (await a.call()).answer({ sequence: 103 });
    await first;
    b.state.reply = atLedger(100);
    await rpc.getLatestLedger();
    expect(rpc.active).toBe("a");
    b.state.reply = atLedger(101);
    await rpc.getLatestLedger();
    expect(rpc.active).toBe("b");
  });

  it("reads the ledger of getLedgerEntries and getFeeStats answers from latestLedger", async () => {
    const { rpc, a, b, switches } = setup(2);
    const first = rpc.getFeeStats();
    (await a.call()).answer({ latestLedger: 103 });
    await first;
    b.state.reply = atLedger(100);
    expect(await rpc.getLedgerEntries()).toEqual({ entries: [], latestLedger: 100 });
    expect(rpc.active).toBe("a");
    expect(switches).toEqual([]);
  });

  it("counts a winner's answer without a numeric ledger as not lagging", async () => {
    const { rpc, a, b, switches } = setup(2);
    const first = rpc.getLatestLedger();
    (await a.call()).answer({ sequence: 103 });
    await first;
    b.state.reply = () => ({ feeCharged: "no ledger here" });
    expect(await rpc.getFeeStats()).toEqual({ feeCharged: "no ledger here" });
    expect(rpc.active).toBe("b");
    expect(switches).toEqual(["a->b by getFeeStats"]);
  });

  it("does not promote the winner when another switch happened since the call began", async () => {
    const { rpc, a, b, c, switches } = setup(3);
    const { token } = rpc.begin();
    const read = rpc.getLatestLedger();
    await a.call();
    await b.call();
    const toC = await c.call();
    rpc.markFailed(0, token, new Error("timeout"), "verify");
    toC.answer({ sequence: 100 });
    expect(await read).toEqual({ sequence: 100 });
    expect(rpc.active).toBe("b");
    expect(switches).toEqual(["a->b by verify"]);
  });

  it("passes the active's own error to onSwitch when the active failed", async () => {
    const { rpc, a, b, errors } = setup(2);
    const aError = new Error("a down");
    b.state.reply = atLedger(100);
    const read = rpc.getLatestLedger();
    (await a.call()).fail(aError);
    await read;
    expect(errors).toEqual([aError]);
    expect(errors[0]).toBe(aError);
  });

  it("passes an RpcTimeoutError to onSwitch when the active simply had not answered", async () => {
    const { rpc, b, errors } = setup(2);
    b.state.reply = atLedger(100);
    await rpc.getLatestLedger();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RpcTimeoutError);
  });

  it("keeps a promoted endpoint active while it answers in time, with no return to the first", async () => {
    const { rpc, a, b, switches } = setup(2);
    b.state.reply = atLedger(100);
    await rpc.getLatestLedger();
    expect(rpc.active).toBe("b");
    const callsOnA = a.asked.length;
    for (let i = 0; i < 4; i++) {
      await sleep(HEDGE * 2);
      await rpc.getLatestLedger();
      await rpc.getFeeStats();
    }
    await sleep(HEDGE * 3);
    expect(rpc.active).toBe("b");
    expect(a.asked.length).toBe(callsOnA);
    expect(switches).toEqual(["a->b by getLatestLedger"]);
  });

  it("ignores a losing endpoint's late answer after the call returned", async () => {
    const { rpc, a, b, switches } = setup(2);
    b.state.reply = atLedger(100);
    await rpc.getLatestLedger();
    expect(rpc.active).toBe("b");
    (await a.call()).answer({ sequence: 105 });
    await sleep(HEDGE);
    expect(rpc.active).toBe("b");
    expect(switches).toEqual(["a->b by getLatestLedger"]);
  });

  it("ignores a losing endpoint's late failure after the call returned", async () => {
    const { rpc, a, b, switches } = setup(2);
    b.state.reply = atLedger(100);
    await rpc.getLatestLedger();
    (await a.call()).fail(new Error("a down, late"));
    await sleep(HEDGE);
    expect(rpc.active).toBe("b");
    expect(switches).toEqual(["a->b by getLatestLedger"]);
  });
});

describe("FallbackRpc with a single endpoint", () => {
  it("waits for its only endpoint past hedgeDelayMs, asking it once", async () => {
    const { rpc, a } = setup(1);
    const read = rpc.getLatestLedger();
    const toA = await a.call();
    await sleep(HEDGE * 3);
    toA.answer({ sequence: 100 });
    expect(await read).toEqual({ sequence: 100 });
    expect(a.asked).toHaveLength(1);
  });

  it("gives up on its only endpoint after timeoutMs with RpcUnavailableError", async () => {
    const { rpc, a } = setup(1, { timeoutMs: 60 });
    const started = Date.now();
    const error = await rpc.getLatestLedger().catch((e: unknown) => e);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(error).toBeInstanceOf(RpcUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(RpcTimeoutError);
    expect(a.asked).toHaveLength(1);
  });
});

describe("FallbackRpc lifecycle reads, never hedged", () => {
  for (const method of ["simulateTransaction", "getTransaction"] as const) {
    it(`${method} asks only the active endpoint even when it is slower than hedgeDelayMs`, async () => {
      const { rpc, a, b } = setup(2);
      const read = rpc[method](noTx as never);
      const toA = await a.call();
      await sleep(HEDGE * 3);
      toA.answer("answer from a");
      expect(await read).toBe("answer from a");
      expect(b.asked).toEqual([]);
      expect(rpc.active).toBe("a");
    });

    it(`${method} tries the next endpoints one after another when the active fails`, async () => {
      const { rpc, a, b, c, switches } = setup(3);
      const read = rpc[method](noTx as never);
      (await a.call()).fail(new Error("a down"));
      const toB = await b.call();
      await sleep(HEDGE * 3);
      expect(c.asked).toEqual([]);
      toB.fail(new Error("b down"));
      (await c.call()).answer("answer from c");
      expect(await read).toBe("answer from c");
      expect(rpc.active).toBe("c");
      // Whether the move is reported as a->c or as a->b then b->c, it ends on c, by this method.
      expect(switches.at(-1)).toMatch(new RegExp(`->c by ${method}$`));
    });
  }

  it("moves getTransaction to the next endpoint only after the active's timeoutMs", async () => {
    const { rpc, b } = setup(2, { timeoutMs: 60 });
    const started = Date.now();
    const read = rpc.getTransaction("hash");
    const toB = await b.call();
    expect(toB.at - started).toBeGreaterThanOrEqual(55);
    toB.answer("answer from b");
    expect(await read).toBe("answer from b");
    expect(rpc.active).toBe("b");
  });
});

describe("FallbackRpc sendTransaction", () => {
  it("never hedges sendTransaction, however slow the active is", async () => {
    const { rpc, a, b } = setup(2);
    const sent = rpc.sendTransaction(noTx);
    const toA = await a.call();
    await sleep(HEDGE * 3);
    toA.answer("sent by a");
    expect(await sent).toBe("sent by a");
    expect(b.asked).toEqual([]);
    expect(rpc.active).toBe("a");
  });

  it("rethrows a failed sendTransaction without retrying, and moves the active endpoint on", async () => {
    const { rpc, a, b } = setup(2);
    const aError = new Error("a down");
    const sent = rpc.sendTransaction(noTx).catch((e: unknown) => e);
    (await a.call()).fail(aError);
    expect(await sent).toBe(aError);
    expect(b.asked).toEqual([]);
    expect(rpc.active).toBe("b");
  });
});

describe("FallbackRpc begin and markFailed", () => {
  it("moves the active endpoint to the next one, wrapping, on a current token", () => {
    const { rpc } = setup(3);
    let { index, token } = rpc.begin();
    expect(index).toBe(0);
    for (const expected of ["b", "c", "a"]) {
      const next = rpc.markFailed(index, token, new Error("timeout"), "verify");
      expect(next).toBeDefined();
      expect(rpc.active).toBe(expected);
      ({ index, token } = rpc.begin());
    }
  });

  it("changes nothing for a stale token or an index calls are not on", () => {
    const { rpc, switches } = setup(2);
    const { token } = rpc.begin();
    expect(rpc.markFailed(1, token, new Error("x"), "verify")).toBeUndefined();
    expect(rpc.markFailed(0, token, new Error("x"), "verify")).toBeDefined();
    expect(rpc.markFailed(0, token, new Error("x"), "verify")).toBeUndefined();
    expect(rpc.active).toBe("b");
    expect(switches).toEqual(["a->b by verify"]);
  });

  it("keeps calls off the first endpoint after markFailed moved them: no probe brings them back", async () => {
    const { rpc, a, b } = setup(2);
    b.state.reply = atLedger(100);
    rpc.markFailed(0, rpc.begin().token, new Error("timeout"), "verify");
    for (let i = 0; i < 4; i++) {
      await sleep(HEDGE * 2);
      await rpc.getLatestLedger();
      await rpc.getTransaction("hash");
    }
    expect(rpc.active).toBe("b");
    expect(a.asked).toEqual([]);
  });
});
