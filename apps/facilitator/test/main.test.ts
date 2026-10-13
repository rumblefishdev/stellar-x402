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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryStores } from "../src/adapters/memory.js";
import { parseConfig } from "../src/config.js";
import { jsonLogger } from "../src/logger.js";
import { start, type Started } from "../src/main.js";

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
    });
    url = `http://127.0.0.1:${app.port}`;
  });
  afterAll(() => app.close());

  it("answers the stub routes, with no CORS headers", async () => {
    const routes = [
      ["GET", "/supported"],
      ["GET", "/discovery/resources"],
    ] as const;
    for (const [method, path] of routes) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { origin: "https://other.example" },
      });
      expect(response.status, path).toBe(501);
      expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
    }
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
});

describe("main()", () => {
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
  it("never writes the RPC URL's key to stderr when upstream's RPC call fails", async () => {
    // Every RPC call answers 503, so upstream's simulation fails and it prints the AxiosError.
    const rpc = createServer((_req, res) => res.writeHead(503).end()).listen(0, "127.0.0.1");
    await once(rpc, "listening");
    const rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}/apikey-S3CR3T`;
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...env, PORT: "47130", RPC_URLS: rpcUrl },
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
    let status: Promise<number> | undefined;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (status || !stdout.includes('"listening"')) return;
      status = fetch("http://127.0.0.1:47130/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then((response) => response.status)
        .finally(() => child.kill("SIGTERM"));
    });
    await once(child, "exit");
    rpc.close();

    expect(await status).toBe(500);
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({ level: "error", event: "console_error" }),
    );
    expect(stdout + stderr).not.toContain("S3CR3T");
  }, 20_000);
});
