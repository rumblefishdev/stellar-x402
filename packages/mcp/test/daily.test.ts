import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SchemeNetworkClient } from "@x402/core/types";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

/** Two buyers' public addresses; the daily database keys their spending apart. */
const BUYER = "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_BUYER = "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let seller: FakeSeller;
let dir: string;
/** The state directory holding `spent.sqlite`. */
let state: string;
let clients: Client[];
let logs: string[];
let clock: Date;

/**
 * One server process of the buyer, with the shared daily database.
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

/** The database's rows, read through a connection of the test's own, in the order written. */
function rows(sql = "SELECT day, payer, asset, amount FROM spent ORDER BY rowid"): unknown[] {
  const db = new DatabaseSync(join(state, "spent.sqlite"));
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** What a day sums to for one payer and asset. */
function spent(day = "2026-10-13", payer = BUYER, asset = USDC): bigint {
  return spentOn(state, day, payer).get(asset) ?? 0n;
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
    // A restarted process reads the same database.
    expect(await (await startProcess())()).toBe("over_budget");
    expect(seller.payments).toHaveLength(2);
    expect(spent()).toBe(20_000n);
  });

  it("keeps a separate daily limit for each wallet sharing the directory", async () => {
    const first = await startProcess();
    expect(await first()).toBe("paid");
    expect(await first()).toBe("paid");
    expect(await first()).toBe("over_budget");
    const other = await startProcess({ payer: OTHER_BUYER });
    expect(await other()).toBe("paid");
    expect(spent()).toBe(20_000n);
    expect(spent("2026-10-13", OTHER_BUYER)).toBe(10_000n);
  });

  it("says the daily budget is the one exceeded", async () => {
    const call = await startProcess({ daily: 5_000n });
    expect(await call()).toBe("over_budget");
    expect(logs.join()).toContain("daily budget");
    expect(seller.payments).toHaveLength(0);
  });

  it("starts again at a new UTC day", async () => {
    const call = await startProcess();
    expect(await call()).toBe("paid");
    expect(await call()).toBe("paid");
    expect(await call()).toBe("over_budget");
    clock = new Date("2026-10-14T00:00:00Z");
    expect(await call()).toBe("paid");
    expect(spent("2026-10-14")).toBe(10_000n);
    expect(spent("2026-10-13")).toBe(20_000n);
  });

  it("gives the amount back when signing fails", async () => {
    const call = await startProcess({ scheme: fakeScheme(1) });
    expect(await call()).toBe("insufficient_funds");
    expect(rows("SELECT amount FROM spent ORDER BY rowid")).toEqual([
      { amount: 10000 },
      { amount: -10000 },
    ]);
    expect(await call()).toBe("paid");
    expect(await call()).toBe("paid");
  });

  it("gives the amount back to the day it was counted on, after midnight too", async () => {
    const call = await startProcess({
      scheme: {
        scheme: "exact",
        async createPaymentPayload() {
          // Counted at 23:59 on the 13th; signing fails once the clock has passed midnight.
          clock = new Date("2026-10-14T00:00:01Z");
          throw new Error(NO_TRUSTLINE);
        },
      },
    });
    expect(await call()).toBe("insufficient_funds");
    expect(spent("2026-10-13")).toBe(0n);
    expect(rows("SELECT DISTINCT day FROM spent")).toEqual([{ day: "2026-10-13" }]);
  });

  it("gives the amount back when signing runs past the call's deadline", async () => {
    const call = await startProcess({ scheme: slowScheme(1_000), timeoutMs: 300 });
    expect(await call()).toBe("upstream_error");
    expect(seller.payments).toHaveLength(0);
    expect(spent()).toBe(0n);
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
    expect(spent()).toBe(0n);
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
    /** Fails every refund row from here on, through a connection of the test's own. */
    const failRefunds = (sql: string) => {
      const db = new DatabaseSync(join(state, "spent.sqlite"));
      db.exec(sql);
      db.close();
    };
    const failing: SchemeNetworkClient = {
      scheme: "exact",
      async createPaymentPayload() {
        // The amount is counted by now; from here on the refund's insert fails.
        failRefunds(
          "CREATE TRIGGER no_refund BEFORE INSERT ON spent WHEN NEW.amount < 0 BEGIN SELECT RAISE(ABORT, 'disk full'); END",
        );
        throw new Error(NO_TRUSTLINE);
      },
    };
    const call = await startProcess({ scheme: failing });
    try {
      expect(await call()).toBe("insufficient_funds");
    } finally {
      failRefunds("DROP TRIGGER IF EXISTS no_refund");
    }
    expect(logs.join()).toContain("could not give back 10000 to the daily budget");
    expect(spent()).toBe(10_000n);
  });

  it("refuses to pay, and logs why, when the database file is corrupted", async () => {
    const call = await startProcess();
    await mkdir(state);
    await writeFile(join(state, "spent.sqlite"), "not a database, just bytes ".repeat(200));
    expect(await call()).toBe("payment_failed");
    expect(logs.join()).toContain("daily budget database cannot be read or written");
    expect(seller.payments).toHaveLength(0);
  });

  it("refuses to pay when counting fails after the offer was chosen, and pays on the next call", async () => {
    const call = await startProcess();
    expect(await call()).toBe("paid");
    // Reading today's spending still works, so the offer passes; only the insert of the count fails.
    const db = new DatabaseSync(join(state, "spent.sqlite"));
    db.exec(
      "CREATE TRIGGER no_insert BEFORE INSERT ON spent BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    expect(await call()).toBe("payment_failed");
    expect(logs.join()).toContain("disk full");
    expect(seller.payments).toHaveLength(1);
    // The failed transaction was rolled back, so the next payment is counted.
    db.exec("DROP TRIGGER no_insert");
    db.close();
    expect(await call()).toBe("paid");
    expect(spent()).toBe(20_000n);
  });

  it("refuses to pay when another server holds the database for over 5 seconds", async () => {
    const call = await startProcess({ timeoutMs: 20_000 });
    expect(await call()).toBe("paid");
    const holder = new DatabaseSync(join(state, "spent.sqlite"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect(await call()).toBe("payment_failed");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(logs.join()).toContain("database is locked");
    expect(seller.payments).toHaveLength(1);
    expect(await call()).toBe("paid");
  }, 20_000);

  it("keeps one budget for running and new servers after the database is deleted", async () => {
    const running = await startProcess();
    expect(await running()).toBe("paid");
    // A reset: the files are deleted while a server still runs.
    await rm(state, { recursive: true });
    const started = await startProcess();
    expect(await running()).toBe("paid");
    expect(await started()).toBe("paid");
    expect(await running()).toBe("over_budget");
    expect(await started()).toBe("over_budget");
    expect(spent()).toBe(20_000n);
  });
});

describe("daily database", () => {
  const day = "2026-10-13";
  const entry = { day, payer: BUYER, asset: USDC };

  it("counts exactly up to the limit, and refuses one atomic unit more", () => {
    expect(countDaily(state, entry, 10n, 10n)).toBe(true);
    expect(countDaily(state, entry, 1n, 10n)).toBe(false);
    expect(spentOn(state, day, BUYER)).toEqual(new Map([[USDC, 10n]]));
  });

  it("gives an amount back with a negative row in the day it was counted on", () => {
    expect(countDaily(state, entry, 4n, 10n)).toBe(true);
    refundDaily(state, entry, 4n);
    expect(spentOn(state, day, BUYER)).toEqual(new Map([[USDC, 0n]]));
    expect(countDaily(state, entry, 10n, 10n)).toBe(true);
  });

  it("lets exactly the limit through when 20 processes count at once", async () => {
    const script = fileURLToPath(new URL("./count-daily-process.ts", import.meta.url));
    // Each process tries five times: 100 attempts against a limit of 50.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => {
        const child = fork(script, [state, day, BUYER, USDC], {
          execArgv: ["--import", "tsx"],
          silent: true,
        });
        let counted = "";
        child.stdout!.on("data", (chunk: Buffer) => (counted += chunk.toString()));
        return new Promise<{ code: number | null; counted: number }>((resolve) =>
          child.on("exit", (code) => resolve({ code, counted: Number(counted) })),
        );
      }),
    );
    expect(results.map((result) => result.code)).toEqual(Array(20).fill(0));
    expect(results.reduce((total, result) => total + result.counted, 0)).toBe(50);
    expect(spent(day)).toBe(50n);
  }, 30_000);
});
