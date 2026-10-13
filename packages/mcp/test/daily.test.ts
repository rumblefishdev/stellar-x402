import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SchemeNetworkClient } from "@x402/core/types";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { fakeScheme, startFakeSeller, USDC, type FakeSeller } from "./fake-seller.js";

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
}: { scheme?: SchemeNetworkClient; daily?: bigint } = {}) {
  const server = createServer({
    discoveryUrl: "http://unused",
    timeoutMs: 5_000,
    maxResponseBytes: 1_000,
    allowInsecureLocal: true,
    log: (message) => logs.push(message),
    payment: {
      schemes: [{ network: "stellar:testnet", client: scheme }],
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
      "2026-10-13": { [USDC]: "20000" },
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
      "2026-10-14": { [USDC]: "10000" },
    });
  });

  it("gives the amount back when signing fails", async () => {
    const call = await startProcess({ scheme: fakeScheme(1) });
    expect(await call()).toBe("insufficient_funds");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "2026-10-13": { [USDC]: "0" } });
    expect(await call()).toBe("paid");
    expect(await call()).toBe("paid");
  });

  it.each([
    ["is not JSON", "{"],
    ["holds an amount that is not a number", JSON.stringify({ "2026-10-13": { [USDC]: "-1" } })],
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
        assets: { [USDC]: { maxPerCall: 1n, budget: 1n, daily: 1n } },
      },
    };
    expect(() => createServer(config)).toThrow("dailyFile");
  });
});
