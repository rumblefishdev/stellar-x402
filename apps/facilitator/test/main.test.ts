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
import { memoryStores } from "../src/adapters/memory.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { supportedResponse } from "../src/http/supported.js";
import { jsonLogger, rpcEndpointName } from "../src/logger.js";
import { main, start, type Started } from "../src/main.js";

const secret = Keypair.random().secret();
const env = {
  FACILITATOR_SECRET: secret,
  CHANNELS: Keypair.random().publicKey(),
  BODY_LIMIT_BYTES: "1024",
};

describe("facilitator boot", () => {
  const lines: string[] = [];
  let app: Started;
  let url: string;

  beforeAll(async () => {
    // Port 0 picks a free port; the schema itself requires 1–65535.
    const config = { ...parseConfig(env), port: 0 };
    const logger = jsonLogger("debug", (line) => lines.push(line));
    const verify = async () => ({ isValid: true });
    const settle = async () => ({
      response: { success: false, transaction: "", network: config.network },
    });
    app = await start({
      config,
      logger,
      stores: memoryStores(),
      verify,
      settle,
      extensionResponses: () => undefined,
      supported: supportedResponse(config.network, Keypair.fromSecret(secret).publicKey()),
    });
    url = `http://127.0.0.1:${app.port}`;
  });
  afterAll(() => app.close());

  it("answers the stub route, with no CORS headers", async () => {
    const response = await fetch(`${url}/discovery/resources`, {
      headers: { origin: "https://other.example" },
    });
    expect(response.status).toBe(501);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${url}/unknown`)).status).toBe(404);
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

  it("refuses stellar:pubnet even with a durable store, before serving anything", async () => {
    // `/settle` spends there: not without spend budgets, rate limits and the channel lease.
    const pubnet = {
      ...env,
      NETWORK: "stellar:pubnet",
      RPC_URLS: "https://rpc.example",
      STORE: "postgres",
      DATABASE_URL: "postgres://db.internal/x402",
    };
    const error = await main(pubnet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      "NETWORK stellar:pubnet is refused until spend budgets (0024), rate limits (0023) and the channel lease (0025) land",
    ]);
  });
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
    const url = "https://acct.example/K/";
    const app = await main({ ...env, RPC_URLS: url, PORT: "47134", LOG_LEVEL: "error" });
    try {
      app.logger.error("http_error", { error: new Error(`request to ${url}rpc failed`) });
      console.error(`request to ${url}rpc failed`);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line).toContain(rpcEndpointName(url, 0));
        expect(line).not.toContain("acct.example");
      }
    } finally {
      write.mockRestore();
      console.error = original;
      await app.close();
    }
  });

  it("serves /supported for its own key, never a channel", async () => {
    const app = await main({ ...env, PORT: "47136", LOG_LEVEL: "error" });
    try {
      const response = await fetch("http://127.0.0.1:47136/supported", {
        headers: { origin: "https://other.example" },
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const body = await response.text();
      const facilitator = Keypair.fromSecret(secret).publicKey();
      expect(JSON.parse(body)).toEqual(supportedResponse("stellar:testnet", facilitator));
      expect(body).not.toContain(env.CHANNELS);
    } finally {
      await app.close();
    }
  });

  it("answers /verify with the real verifier, then exits 0 on SIGTERM", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...env, PORT: "47129" },
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
      if (answer || !output.includes('"listening"')) return;
      answer = fetch("http://127.0.0.1:47129/verify", {
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
    // second request the second URL answers a failed simulation: a verdict, so a failover.
    let request = 0;
    const rpc = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (request < 2 || !req.url?.includes("0TH3R")) return void res.writeHead(503).end();
        const { id } = JSON.parse(body) as { id: number };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { latestLedger: 1, error: "boom" } }));
      });
    }).listen(0, "127.0.0.1");
    await once(rpc, "listening");
    const base = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...env, PORT: "47130", RPC_URLS: `${base}/apikey-S3CR3T,${base}/apikey-0TH3R` },
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
    const post = () =>
      fetch("http://127.0.0.1:47130/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((response) => response.status);
    let statuses: Promise<number[]> | undefined;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (statuses || !stdout.includes('"listening"')) return;
      statuses = (async () => {
        const first = await post();
        request = 2;
        return [first, await post()];
      })().finally(() => child.kill("SIGTERM"));
    });
    await once(child, "exit");
    rpc.close();

    expect(await statuses).toEqual([500, 200]);
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const event of ["console_error", "rpc_exhausted", "http_error", "rpc_failover"]) {
      expect(events.map((e) => e.event)).toContain(event);
    }
    for (const key of ["S3CR3T", "0TH3R"]) expect(stdout + stderr).not.toContain(key);
  }, 20_000);
});
