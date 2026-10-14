import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SchemeNetworkClient } from "@x402/core/types";
import { fork } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countDaily, refundDaily, spentOn } from "../src/daily.js";
import { createServer } from "../src/index.js";
import {
  fakeScheme,
  NO_TRUSTLINE,
  slowScheme,
  startFakeSeller,
  USDC,
  type FakeSeller,
} from "./fake-seller.js";

/** Two buyers' public addresses; the daily log keys their spending apart. */
const BUYER = "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_BUYER = "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let seller: FakeSeller;
let dir: string;
/** The state directory holding the day files. */
let state: string;
let clients: Client[];
let logs: string[];
let clock: Date;

/**
 * One server process of the buyer, with the shared daily log.
 * The seller asks 10,000 a call: the daily budget of 25,000 fits two calls.
 */
async function startProcess({
  scheme = fakeScheme(),
  daily = 25_000n,
  payer = BUYER,
  timeoutMs = 5_000,
}: { scheme?: SchemeNetworkClient; daily?: bigint; payer?: string; timeoutMs?: number } = {}) {
  const server = createServer({
    discoveryUrl: "http://unused",
    timeoutMs,
    maxResponseBytes: 1_000,
    allowInsecureLocal: true,
    log: (message) => logs.push(message),
    payment: {
      schemes: [{ network: "stellar:testnet", client: scheme }],
      payer,
      assets: { [USDC]: { maxPerCall: 20_000n, daily } },
      dailyDir: state,
      now: () => clock,
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  await client.listTools();
  clients.push(client);
  return async () => {
    const result = await client.callTool({
      name: "call_paid_http",
      arguments: { url: `${seller.url}/forecast`, method: "GET" },
    });
    const [first] = result.content as { text: string }[];
    const answer = JSON.parse(first!.text) as { error?: { code: string; message: string } };
    return answer.error?.code ?? "paid";
  };
}

beforeEach(async () => {
  seller = await startFakeSeller();
  dir = await mkdtemp(join(tmpdir(), "daily-budget-"));
  state = join(dir, "state");
  clients = [];
  logs = [];
  clock = new Date("2026-10-13T23:59:00Z");
});

/** The day file's lines, parsed; every one of them must be a whole record. */
async function lines(
  day = "2026-10-13",
): Promise<{ payer: string; asset: string; amount: string }[]> {
  const text = await readFile(join(state, `spent-${day}.jsonl`), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { payer: string; asset: string; amount: string });
}

/** What the day file sums to for one payer and asset. */
async function spent(day = "2026-10-13", payer = BUYER, asset = USDC): Promise<bigint> {
  return (await lines(day))
    .filter((line) => line.payer === payer && line.asset === asset)
    .reduce((total, line) => total + BigInt(line.amount), 0n);
}

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await seller.close();
  await rm(dir, { recursive: true, force: true });
});

describe("daily budget", () => {
  it("is shared by two processes and survives a restart", async () => {
    const first = await startProcess();
    expect(await first()).toBe("paid");
    const second = await startProcess();
    expect(await second()).toBe("paid");
    expect(await second()).toBe("over_budget");
    // A restarted process reads the same log.
    expect(await (await startProcess())()).toBe("over_budget");
    expect(seller.payments).toHaveLength(2);
    expect(await lines()).toEqual([
      { payer: BUYER, asset: USDC, amount: "10000" },
      { payer: BUYER, asset: USDC, amount: "10000" },
    ]);
  });

  it("keeps a separate daily limit for each wallet sharing the directory", async () => {
    const first = await startProcess();
    expect(await first()).toBe("paid");
    expect(await first()).toBe("paid");
    expect(await first()).toBe("over_budget");
    const other = await startProcess({ payer: OTHER_BUYER });
    expect(await other()).toBe("paid");
    expect(await spent()).toBe(20_000n);
    expect(await spent("2026-10-13", OTHER_BUYER)).toBe(10_000n);
  });

  it("says the daily budget is the one exceeded", async () => {
    const call = await startProcess({ daily: 5_000n });
    expect(await call()).toBe("over_budget");
    expect(logs.join()).toContain("daily budget");
    expect(seller.payments).toHaveLength(0);
  });

  it("starts again at a new UTC day, in a new file", async () => {
    const call = await startProcess();
    expect(await call()).toBe("paid");
    expect(await call()).toBe("paid");
    expect(await call()).toBe("over_budget");
    clock = new Date("2026-10-14T00:00:00Z");
    expect(await call()).toBe("paid");
    expect(await spent("2026-10-14")).toBe(10_000n);
    expect(await spent("2026-10-13")).toBe(20_000n);
  });

  it("gives the amount back when signing fails", async () => {
    const call = await startProcess({ scheme: fakeScheme(1) });
    expect(await call()).toBe("insufficient_funds");
    expect(await lines()).toEqual([
      { payer: BUYER, asset: USDC, amount: "10000" },
      { payer: BUYER, asset: USDC, amount: "-10000" },
    ]);
    expect(await call()).toBe("paid");
    expect(await call()).toBe("paid");
  });

  it("gives the amount back when signing runs past the call's deadline", async () => {
    const call = await startProcess({ scheme: slowScheme(1_000), timeoutMs: 300 });
    expect(await call()).toBe("upstream_error");
    expect(seller.payments).toHaveLength(0);
    expect(await spent()).toBe(0n);
  });

  it("gives the amount back when the deadline passes before the payment is sent", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const call = await startProcess({
      scheme: {
        scheme: "exact",
        // Signed just as the deadline passes: the paid request is the first to see it gone.
        createPaymentPayload(x402Version, requirements) {
          const signed = Promise.resolve({ x402Version, payload: { amount: requirements.amount } });
          deadline.abort();
          return signed;
        },
      },
    });
    try {
      expect(await call()).toBe("upstream_error");
    } finally {
      vi.restoreAllMocks();
    }
    expect(seller.payments).toHaveLength(0);
    expect(await spent()).toBe(0n);
  });

  it.each([
    ["allows a day spent exactly to the limit", 20_000n, ["paid", "paid", "over_budget"]],
    ["refuses one atomic unit over it", 19_999n, ["paid", "over_budget"]],
  ])("%s", async (_, daily, expected) => {
    const call = await startProcess({ daily });
    const results: string[] = [];
    while (results.length < expected.length) results.push(await call());
    expect(results).toEqual(expected);
  });

  it("logs a refund it cannot write, and the amount stays counted", async () => {
    const file = join(state, "spent-2026-10-13.jsonl");
    const failing: SchemeNetworkClient = {
      scheme: "exact",
      async createPaymentPayload() {
        // The amount is counted by now; a day file that cannot be written stops the refund.
        await chmod(file, 0o400);
        throw new Error(NO_TRUSTLINE);
      },
    };
    const call = await startProcess({ scheme: failing });
    try {
      expect(await call()).toBe("insufficient_funds");
    } finally {
      await chmod(file, 0o600);
    }
    expect(logs.join()).toContain("could not give back 10000 to the daily budget");
    expect(await spent()).toBe(10_000n);
  });

  it.each([
    ["is not JSON", "{\n"],
    [
      "holds an amount that is not a number",
      `${JSON.stringify({ payer: BUYER, asset: USDC, amount: "1.5" })}\n`,
    ],
    [
      "has a malformed line in the middle",
      `${JSON.stringify({ payer: BUYER, asset: USDC, amount: "1" })}\n{"payer":\n` +
        `${JSON.stringify({ payer: BUYER, asset: USDC, amount: "1" })}\n`,
    ],
  ])("refuses to pay, and logs why, when the day file %s", async (_, content) => {
    const call = await startProcess();
    await mkdir(state);
    await writeFile(join(state, "spent-2026-10-13.jsonl"), content);
    expect(await call()).toBe("payment_failed");
    expect(logs.join()).toContain("daily budget record cannot be read");
    expect(seller.payments).toHaveLength(0);
  });

  it("never lets calls of one process paying at once exceed the budget", async () => {
    const calls = await Promise.all([1, 2, 3, 4, 5, 6].map(() => startProcess()));
    const results = await Promise.all(calls.map((call) => call()));
    expect(results.filter((result) => result === "paid")).toHaveLength(2);
    expect(results.filter((result) => result === "over_budget")).toHaveLength(4);
    expect(seller.payments).toHaveLength(2);
  });
});

describe("daily log", () => {
  const day = "2026-10-13";
  const entry = { day, payer: BUYER, asset: USDC };
  const log = (message: string) => logs.push(message);

  it("counts exactly up to the limit, and refuses one atomic unit more", () => {
    expect(countDaily(state, entry, 10n, 10n, log)).toBe(true);
    expect(countDaily(state, entry, 1n, 10n, log)).toBe(false);
    expect(spentOn(state, day, BUYER, log)).toEqual(new Map([[USDC, 10n]]));
  });

  it("ignores, and logs, a last line cut short by a crash, and keeps it apart from the next", async () => {
    await mkdir(state);
    const file = join(state, `spent-${day}.jsonl`);
    await writeFile(
      file,
      `${JSON.stringify({ payer: BUYER, asset: USDC, amount: "3" })}\n{"payer":"GB`,
    );
    expect(spentOn(state, day, BUYER, log)).toEqual(new Map([[USDC, 3n]]));
    expect(logs.join()).toContain("a write cut short by a crash");
    // The next line starts after an empty one, so the cut line is still known as cut.
    expect(countDaily(state, entry, 4n, 10n, log)).toBe(true);
    refundDaily(state, entry, 4n, log);
    expect(spentOn(state, day, BUYER, log)).toEqual(new Map([[USDC, 3n]]));
  });

  it("deletes day files older than seven days when it appends", async () => {
    await mkdir(state);
    await writeFile(join(state, "spent-2026-10-05.jsonl"), "");
    await writeFile(join(state, "spent-2026-10-06.jsonl"), "");
    await writeFile(join(state, "notes.txt"), "");
    countDaily(state, entry, 1n, 10n, log);
    expect((await readdir(state)).sort()).toEqual([
      "notes.txt",
      "spent-2026-10-06.jsonl",
      "spent-2026-10-13.jsonl",
    ]);
  });

  it("is counted once by each of 20 processes appending at once", async () => {
    const script = fileURLToPath(new URL("./count-daily-process.ts", import.meta.url));
    const exits = await Promise.all(
      Array.from({ length: 20 }, () => {
        const child = fork(script, [state], { execArgv: ["--import", "tsx"] });
        return new Promise<number | null>((resolve) => child.on("exit", resolve));
      }),
    );
    expect(exits).toEqual(Array(20).fill(0));
    const appended = await lines();
    expect(appended).toHaveLength(20);
    expect(appended.every((line) => line.payer === "GBUYER" && line.amount === "1")).toBe(true);
    expect(await spent(day, "GBUYER", "CASSET")).toBe(20n);
  }, 30_000);
});
