import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SchemeNetworkClient } from "@x402/core/types";
import { fork } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countDaily, refundDaily } from "../src/daily.js";
import { createServer } from "../src/index.js";
import { fakeScheme, NO_TRUSTLINE, startFakeSeller, USDC, type FakeSeller } from "./fake-seller.js";

/** Two buyers' public addresses; the daily record keys their spending apart. */
const BUYER = "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_BUYER = "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let seller: FakeSeller;
let dir: string;
let file: string;
let clients: Client[];
let logs: string[];
let clock: Date;

/**
 * One server process of the buyer, with its own per-process budget and the shared daily record.
 * The seller asks 10,000 a call: the daily budget of 25,000 fits two calls, each process budget five.
 */
async function startProcess({
  scheme = fakeScheme(),
  daily = 25_000n,
  payer = BUYER,
}: { scheme?: SchemeNetworkClient; daily?: bigint; payer?: string } = {}) {
  const server = createServer({
    discoveryUrl: "http://unused",
    timeoutMs: 5_000,
    maxResponseBytes: 1_000,
    allowInsecureLocal: true,
    log: (message) => logs.push(message),
    payment: {
      schemes: [{ network: "stellar:testnet", client: scheme }],
      payer,
      assets: { [USDC]: { maxPerCall: 20_000n, budget: 50_000n, daily } },
      dailyFile: file,
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
  file = join(dir, "state", "spent.json");
  clients = [];
  logs = [];
  clock = new Date("2026-10-13T23:59:00Z");
});

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
    // A restarted process reads the same record.
    expect(await (await startProcess())()).toBe("over_budget");
    expect(seller.payments).toHaveLength(2);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "2026-10-13": { [BUYER]: { [USDC]: "20000" } },
    });
  });

  it("keeps a separate daily limit for each wallet sharing the file", async () => {
    const first = await startProcess();
    expect(await first()).toBe("paid");
    expect(await first()).toBe("paid");
    expect(await first()).toBe("over_budget");
    const other = await startProcess({ payer: OTHER_BUYER });
    expect(await other()).toBe("paid");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "2026-10-13": { [BUYER]: { [USDC]: "20000" }, [OTHER_BUYER]: { [USDC]: "10000" } },
    });
  });

  it("says the daily budget is the one exceeded", async () => {
    const call = await startProcess({ daily: 5_000n });
    expect(await call()).toBe("over_budget");
    expect(logs.join()).toContain("daily budget");
    expect(seller.payments).toHaveLength(0);
  });

  it("starts again at a new UTC day, and drops the old one", async () => {
    const call = await startProcess();
    expect(await call()).toBe("paid");
    expect(await call()).toBe("paid");
    expect(await call()).toBe("over_budget");
    clock = new Date("2026-10-14T00:00:00Z");
    expect(await call()).toBe("paid");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "2026-10-14": { [BUYER]: { [USDC]: "10000" } },
    });
  });

  it("gives the amount back when signing fails", async () => {
    const call = await startProcess({ scheme: fakeScheme(1) });
    expect(await call()).toBe("insufficient_funds");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "2026-10-13": { [BUYER]: { [USDC]: "0" } },
    });
    expect(await call()).toBe("paid");
    expect(await call()).toBe("paid");
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
    const state = join(dir, "state");
    const failing: SchemeNetworkClient = {
      scheme: "exact",
      async createPaymentPayload() {
        // The amount is counted by now; a record that cannot be written stops the refund.
        await chmod(state, 0o500);
        throw new Error(NO_TRUSTLINE);
      },
    };
    const call = await startProcess({ scheme: failing });
    try {
      expect(await call()).toBe("insufficient_funds");
    } finally {
      await chmod(state, 0o700);
    }
    expect(logs.join()).toContain("could not give back 10000 to the daily budget");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "2026-10-13": { [BUYER]: { [USDC]: "10000" } },
    });
  });

  it.each([
    ["is not JSON", "{"],
    [
      "holds an amount that is not a number",
      JSON.stringify({ "2026-10-13": { [BUYER]: { [USDC]: "-1" } } }),
    ],
  ])("refuses to pay, and logs why, when the record %s", async (_, content) => {
    const call = await startProcess();
    await mkdir(join(dir, "state"));
    await writeFile(file, content);
    expect(await call()).toBe("payment_failed");
    expect(logs.join()).toContain("daily budget record cannot be read");
    expect(seller.payments).toHaveLength(0);
  });

  it("never lets processes paying at once exceed the budget", async () => {
    const calls = await Promise.all([1, 2, 3, 4, 5, 6].map(() => startProcess()));
    const results = await Promise.all(calls.map((call) => call()));
    expect(results.filter((result) => result === "paid")).toHaveLength(2);
    expect(results.filter((result) => result === "over_budget")).toHaveLength(4);
    expect(seller.payments).toHaveLength(2);
  });

  it("refuses to start with a daily budget but no record file", () => {
    const config = {
      discoveryUrl: "http://unused",
      timeoutMs: 5_000,
      maxResponseBytes: 1_000,
      log: () => {},
      payment: {
        schemes: [],
        payer: BUYER,
        assets: { [USDC]: { maxPerCall: 1n, budget: 1n, daily: 1n } },
      },
    };
    expect(() => createServer(config)).toThrow("dailyFile");
  });
});

describe("daily record", () => {
  const day = "2026-10-13";
  const entry = { day, payer: BUYER, asset: USDC };
  const log = (message: string) => logs.push(message);

  it("counts exactly up to the limit, and refuses one atomic unit more", async () => {
    expect(await countDaily(file, entry, 10n, 10n, log)).toBe(true);
    expect(await countDaily(file, entry, 1n, 10n, log)).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      [day]: { [BUYER]: { [USDC]: "10" } },
    });
  });

  it("logs a refund larger than what the record holds, and leaves the record as it is", async () => {
    await countDaily(file, entry, 5n, 10n, log);
    await refundDaily(file, entry, 10n, log);
    expect(logs.join()).toContain("cannot give back 10");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      [day]: { [BUYER]: { [USDC]: "5" } },
    });
  });

  it("gives nothing back, silently, to a day already dropped", async () => {
    await countDaily(file, { ...entry, day: "2026-10-14" }, 5n, 10n, log);
    await refundDaily(file, entry, 5n, log);
    expect(logs).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      "2026-10-14": { [BUYER]: { [USDC]: "5" } },
    });
  });

  it("is counted once by each of 20 processes, starting from a stale lock", async () => {
    await mkdir(join(dir, "state"));
    // Left by a process that died ten seconds ago: older than the five a lock may live.
    await writeFile(`${file}.lock`, "");
    const past = new Date(Date.now() - 10_000);
    await utimes(`${file}.lock`, past, past);
    const script = fileURLToPath(new URL("./count-daily-process.ts", import.meta.url));
    const exits = await Promise.all(
      Array.from({ length: 20 }, () => {
        const child = fork(script, [file], { execArgv: ["--import", "tsx"] });
        return new Promise<number | null>((resolve) => child.on("exit", resolve));
      }),
    );
    expect(exits).toEqual(Array(20).fill(0));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      [day]: { GBUYER: { CASSET: "20" } },
    });
  }, 30_000);
});
