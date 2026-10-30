import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/postgres-schema.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger, rpcEndpointName } from "../src/logger.js";
import { main, start, type Started } from "../src/main.js";
import { memoryMetrics } from "../src/metrics.js";
import { testDatabase } from "./database.js";
import { hardened, ledgerEntries, rpcStub } from "./rpc-stub.js";

const db = testDatabase();
const secret = Keypair.random().secret();
const facilitator = Keypair.fromSecret(secret).publicKey();
const env = {
  DATABASE_URL: db.urlFor(db.schema),
  FACILITATOR_SECRET: secret,
  CLIENT_IP: "socket",
  CHANNELS: Keypair.random().publicKey(),
  BODY_LIMIT_BYTES: "1024",
};
/** A channel whose master key still signs: the startup check refuses it. */
const masterActive = Keypair.random().publicKey();

// `main()` checks every channel at startup, on the RPC it builds from `RPC_URLS`.
let rpc: Awaited<ReturnType<typeof rpcStub>>;
beforeAll(async () => {
  rpc = await rpcStub({
    [env.CHANNELS]: hardened(facilitator),
    [masterActive]: { signers: [facilitator], masterWeight: 1 },
  });
});
afterAll(() => rpc.close());

describe("facilitator boot", () => {
  const lines: string[] = [];
  let app: Started;
  let url: string;

  beforeAll(async () => {
    const config = parseConfig({ ...env, PORT: "0" });
    const logger = jsonLogger("debug", (line) => lines.push(line));
    const verify = async () => ({ isValid: true });
    const settle = async () => ({
      response: { success: false, transaction: "", network: config.network },
    });
    app = await start({
      config,
      logger,
      metrics: memoryMetrics(),
      stores: db.stores(),
      verify,
      settle,
      extensionResponses: () => undefined,
      supported: supportedResponse(config.network, facilitator),
    });
    url = `http://127.0.0.1:${app.port}`;
  });
  afterAll(() => app.close());

  it("answers an unknown route with a 404, with no CORS headers", async () => {
    const response = await fetch(`${url}/unknown`, {
      headers: { origin: "https://other.example" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a client's bad body with a 4xx and doesn't log it as an error", async () => {
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${url}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    const cases = [
      [413, "payload_too_large", JSON.stringify({ pad: "x".repeat(2_000) }), {}],
      [400, "bad_request", "{", {}],
      [415, "unsupported_media_type", "{}", { "content-type": "application/json; charset=latin1" }],
      [415, "unsupported_media_type", "{}", { "content-encoding": "x-foo" }],
    ] as const;
    for (const [status, error, body, headers] of cases) {
      const response = await post(body, headers);
      expect([response.status, await response.json()]).toEqual([status, { error }]);
    }
    expect(lines.join("")).not.toContain("http_error");
  });

  it("logs one JSON event per line and never the secret", () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ level: "info", event: "listening", network: "stellar:testnet" }),
    );
    expect(lines.join("")).not.toContain(secret);
  });
});

describe("startup with a bad config", () => {
  it("exits with 1 and names each bad value without printing it", () => {
    const bad = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { FACILITATOR_SECRET: bad },
      encoding: "utf8",
    });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output).toContain("FACILITATOR_SECRET must be a Stellar secret key");
    expect(output).toContain("CHANNELS is required");
    expect(output).not.toContain(bad);
  }, 20_000);

  it("fails pnpm migrate with 1 and never prints the URL", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/migrate.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { DATABASE_URL: "mysql://u:secret@db/x" },
      encoding: "utf8",
    });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output).toContain("DATABASE_URL must be a postgres:// URL");
    expect(output).not.toContain("secret");
  }, 20_000);

  it("refuses stellar:pubnet before serving anything", async () => {
    // `/settle` spends there: not without spend budgets, rate limits and the channel lease.
    const pubnet = {
      ...env,
      NETWORK: "stellar:pubnet",
      RPC_URLS: "https://rpc.example",
    };
    const error = await main(pubnet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      "NETWORK stellar:pubnet is refused until spend budgets (0024) and task 0090 land",
    ]);
  });
});

describe("the startup channel check", () => {
  /** Runs `src/server.ts` until it exits; its stdout as JSON events, and all its output. */
  async function serve(extra: Record<string, string>) {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...env, PORT: "0", ...extra },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code] = await once(child, "exit");
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { code, events, output: stdout + stderr };
  }

  it("refuses to start on a channel another key can sign for, and names it", async () => {
    const { code, events, output } = await serve({
      CHANNELS: `${env.CHANNELS},${masterActive}`,
      RPC_URLS: rpc.url,
    });
    expect(code, output).toBe(1);
    expect(events.map((event) => event.event)).toEqual(["startup_failed"]);
    expect(output).toContain(`${masterActive}: master-key-active`);
    expect(output).not.toContain(`${env.CHANNELS}:`);
  }, 20_000);

  it("refuses to start when no RPC answers, naming the endpoint, never its host", async () => {
    // A URL can carry its API key in the path, and its host can name a paid provider (ADR 0011).
    const down = createServer((_req, res) => res.writeHead(503).end()).listen(0, "127.0.0.1");
    await once(down, "listening");
    const url = `http://127.0.0.1:${(down.address() as AddressInfo).port}/apikey-S3CR3T`;
    try {
      const { code, events, output } = await serve({ RPC_URLS: url });
      expect(code, output).toBe(1);
      expect(events.map((event) => event.event)).toEqual(["startup_failed"]);
      expect(output).toContain(rpcEndpointName(url, 0));
      expect(output).not.toContain("S3CR3T");
      expect(output).not.toContain("127.0.0.1");
    } finally {
      down.close();
    }
  }, 20_000);

  it("refuses to start when an RPC_URLS entry serves another network, and names it", async () => {
    // An RPC of another network answers every channel read with no entry: the pool would retire
    // live channels as missing once calls fail over to it.
    const pubnet = await rpcStub({}, Networks.PUBLIC);
    try {
      const { code, events, output } = await serve({ RPC_URLS: `${rpc.url},${pubnet.url}` });
      expect(code, output).toBe(1);
      expect(events.map((event) => event.event)).toEqual(["startup_failed"]);
      // Quotes arrive escaped inside the JSON log line.
      expect(output).toContain(`${rpcEndpointName(pubnet.url, 1)}: serves \\"${Networks.PUBLIC}`);
      expect(output).not.toContain(`${rpcEndpointName(rpc.url, 0)}:`);
      expect(output).not.toContain("127.0.0.1");
    } finally {
      await pubnet.close();
    }
  }, 20_000);
});

describe("main()", () => {
  it("names an RPC_URLS entry in its logs and console.error lines, never its host", async () => {
    // A URL can carry its API key in the path, and its host can name a paid provider (ADR 0011).
    const original = console.error;
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((line) => {
      lines.push(String(line));
      return true;
    });
    const url = `${rpc.url}/K/`;
    const app = await main({ ...env, RPC_URLS: url, PORT: "0", LOG_LEVEL: "error" });
    try {
      app.logger.error("http_error", { error: new Error(`request to ${url}rpc failed`) });
      console.error(`request to ${url}rpc failed`);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toContain(rpcEndpointName(url, 0));
        expect(line).not.toContain("127.0.0.1");
      }
    } finally {
      write.mockRestore();
      console.error = original;
      await app.close();
    }
  });

  it("reports ready and listed on /health once it holds the lease and a sweep has listed", async () => {
    const app = await main({ ...env, RPC_URLS: rpc.url, PORT: "0", LOG_LEVEL: "error" });
    try {
      await app.reconciled;
      const response = await fetch(`http://127.0.0.1:${app.port}/health`);
      expect([response.status, await response.json()]).toEqual([
        200,
        { ready: true, listed: true },
      ]);
    } finally {
      await app.close();
    }
  });

  it("refuses to start on a schema behind the code, naming what it lacks, and starts on one ahead", async () => {
    const fresh = `${db.schema}_behind`;
    await db.pool.query(`CREATE SCHEMA ${fresh}`);
    const pool = db.poolFor(fresh, 2);
    const freshEnv = { ...env, DATABASE_URL: db.urlFor(fresh), RPC_URLS: rpc.url, PORT: "0" };
    try {
      await migrate(pool, 0, MIGRATIONS.slice(0, 1));
      const error = await main({ ...freshEnv, LOG_LEVEL: "error" }, { write: () => {} }).catch(
        (e: unknown) => e,
      );
      const rest = MIGRATIONS.slice(1).map((migration) => migration.name);
      expect((error as Error).message).toBe(`the schema lacks migrations: ${rest.join(", ")}`);
      // A rollback to an earlier image runs on the newer schema (ADR 0012).
      await migrate(pool);
      await pool.query("INSERT INTO schema_migrations (name, applied_at) VALUES ('9999_next', 0)");
      const app = await main({ ...freshEnv, LOG_LEVEL: "error" });
      await app.close();
    } finally {
      await pool.end();
      await db.pool.query(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`);
    }
  });

  it("serves /supported for the key it checked the channels against", async () => {
    const app = await main({ ...env, RPC_URLS: rpc.url, PORT: "0", LOG_LEVEL: "error" });
    try {
      const response = await fetch(`http://127.0.0.1:${app.port}/supported`, {
        headers: { origin: "https://other.example" },
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const body = await response.text();
      expect(JSON.parse(body)).toEqual(supportedResponse("stellar:testnet", facilitator));
      expect(body).not.toContain(env.CHANNELS);
    } finally {
      await app.close();
    }
  });

  it("prunes the stores with the config's windows", async () => {
    const day = 86_400_000;
    const hour = 3_600_000;
    const app = await main({
      ...env,
      RPC_URLS: rpc.url,
      PORT: "0",
      LOG_LEVEL: "error",
      SPEND_WINDOW_MS: String(5 * day),
      RATE_LIMIT_WINDOW_MS: String(hour),
    });
    try {
      // A budget's window is never longer than SPEND_WINDOW_MS, which 0024 keeps.
      const reserve = (id: string, at: number) =>
        app.stores.spend.reserve({
          id,
          amount: 1n,
          limits: [{ scope: "global", maxStroops: 10n, windowMs: 5 * day }],
          now: at,
        });
      const now = Date.now();
      // A 5-day window keeps 10 days.
      await reserve("old", now - 10 * day - 60_000);
      await reserve("kept", now - 9 * day);
      // An hour's window is kept for an hour after it ends: the one before this hour stays.
      const hit = (key: string, at: number) => app.stores.rateLimits.hit(key, hour, at);
      await hit("old", now - 3 * hour);
      await hit("ended", now - hour);
      await app.pruner.runOnce();
      // Read over 11 days, past the window, to see which reservations are still stored.
      expect(await app.stores.spend.used("global", 11 * day, Date.now())).toBe(1n);
      // A stored window counts on; a pruned one starts again at 1.
      expect((await hit("old", now - 3 * hour)).count).toBe(1);
      expect((await hit("ended", now - hour)).count).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("prunes on its timer until it closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const app = await main({ ...env, RPC_URLS: rpc.url, PORT: "0", LOG_LEVEL: "error" });
      const prune = vi.spyOn(app.stores.spend, "prune");
      try {
        // A tick comes within a minute, ±10%.
        await vi.advanceTimersByTimeAsync(66_000);
        expect(prune).toHaveBeenCalled();
      } finally {
        await app.close();
      }
      prune.mockClear();
      await vi.advanceTimersByTimeAsync(10 * 66_000);
      expect(prune).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers /verify with the real verifier, then exits 0 on SIGTERM", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...env, PORT: "0", RPC_URLS: rpc.url },
    });
    // A pubnet payment: the real verifier rejects it before any RPC call; a stub wouldn't.
    const requirements = {
      scheme: "exact",
      network: "stellar:pubnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "1000",
      payTo: Keypair.random().publicKey(),
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const body = {
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
      paymentRequirements: requirements,
    };
    let output = "";
    let answer: Promise<unknown> | undefined;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const port = listeningPort(output);
      if (answer || port === undefined) return;
      answer = fetch(`http://127.0.0.1:${port}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (response) => [response.status, await response.json()])
        .finally(() => child.kill("SIGTERM"));
    });
    const [code, signal] = await once(child, "exit");
    expect(await answer).toEqual([
      200,
      {
        isValid: false,
        invalidReason: "invalid_network",
        invalidMessage: "this facilitator serves stellar:testnet",
      },
    ]);
    // Without a handler the process dies by the signal: code null, signal "SIGTERM".
    expect([code, signal], output).toEqual([0, null]);
  }, 20_000);
});

describe("upstream's console.error in main()", () => {
  it("never writes an RPC URL's key to a log line or stderr when upstream's RPC calls fail", async () => {
    // Both URLs answer 503, so upstream's simulation fails and it prints the AxiosError. On the
    // second request the second URL answers a failed simulation: a verdict, from `RPC_URLS[1]`.
    // Upstream's 503 is `unexpected_verify_error`, which moves no client (0045 decision 22).
    let request = 0;
    const rpc = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body) as {
          id: number;
          method: string;
          params: { keys: string[] };
        };
        res.setHeader("content-type", "application/json");
        // The startup checks: both URLs serve testnet, and the channel is set up as AD-12 requires.
        if (method === "getNetwork") {
          return void res.end(
            JSON.stringify({ jsonrpc: "2.0", id, result: { passphrase: Networks.TESTNET } }),
          );
        }
        if (method === "getLedgerEntries") {
          const accounts = { [env.CHANNELS]: hardened(facilitator) };
          return void res.end(
            JSON.stringify({ jsonrpc: "2.0", id, result: ledgerEntries(params.keys, accounts) }),
          );
        }
        if (request < 2 || !req.url?.includes("0TH3R")) return void res.writeHead(503).end();
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { latestLedger: 1, error: "boom" } }));
      });
    }).listen(0, "127.0.0.1");
    await once(rpc, "listening");
    const base = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...env, PORT: "0", RPC_URLS: `${base}/apikey-S3CR3T,${base}/apikey-0TH3R` },
    });
    // A transfer that passes upstream's checks up to the simulation.
    const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
    const payer = Keypair.random().publicKey();
    const payTo = Keypair.random().publicKey();
    const transaction = new TransactionBuilder(new Account(payer, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: asset,
          function: "transfer",
          args: [
            nativeToScVal(payer, { type: "address" }),
            nativeToScVal(payTo, { type: "address" }),
            nativeToScVal(1000n, { type: "i128" }),
          ],
        }),
      )
      .setTimeout(60)
      .build();
    const requirements = {
      scheme: "exact",
      network: "stellar:testnet",
      asset,
      amount: "1000",
      payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const body = {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction: transaction.toXDR() },
      },
      paymentRequirements: requirements,
    };

    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const post = (port: number) =>
      fetch(`http://127.0.0.1:${port}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((response) => response.status);
    let statuses: Promise<number[]> | undefined;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const port = listeningPort(stdout);
      if (statuses || port === undefined) return;
      statuses = (async () => {
        const first = await post(port);
        request = 2;
        return [first, await post(port)];
      })().finally(() => child.kill("SIGTERM"));
    });
    await once(child, "exit");

    expect(await statuses).toEqual([500, 200]);
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const event of ["console_error", "rpc_exhausted", "http_error", "verified"]) {
      expect(events.map((e) => e.event)).toContain(event);
    }
    for (const key of ["S3CR3T", "0TH3R"]) expect(stdout + stderr).not.toContain(key);
  }, 20_000);
});

/** The port in the server's `listening` log line, once that line has arrived whole. */
function listeningPort(stdout: string): number | undefined {
  const line = stdout
    .split("\n")
    .slice(0, -1)
    .find((text) => text.includes('"event":"listening"'));
  return line === undefined ? undefined : JSON.parse(line).port;
}
