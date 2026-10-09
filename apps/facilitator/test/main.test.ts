import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryStores } from "../src/adapters/memory.js";
import { parseConfig } from "../src/config.js";
import { jsonLogger } from "../src/logger.js";
import { start, type Started } from "../src/main.js";
import { memoryMetrics } from "../src/metrics.js";
import { noopHooks } from "../src/settlement/hooks.js";

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
    app = await start({
      config,
      logger,
      stores: memoryStores(),
      hooks: noopHooks,
      metrics: memoryMetrics(),
    });
    url = `http://127.0.0.1:${app.port}`;
  });
  afterAll(() => app.close());

  it("answers the stub routes, with no CORS headers", async () => {
    const routes = [
      ["POST", "/verify"],
      ["POST", "/settle"],
      ["GET", "/supported"],
      ["GET", "/discovery/resources"],
    ] as const;
    for (const [method, path] of routes) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json", origin: "https://other.example" },
        body: method === "POST" ? "{}" : undefined,
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

describe("process signals", () => {
  it("closes the server and exits 0 on SIGTERM", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...env, PORT: "47129" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"listening"')) child.kill("SIGTERM");
    });
    const [code, signal] = await once(child, "exit");
    // Without a handler the process dies by the signal: code null, signal "SIGTERM".
    expect([code, signal], output).toEqual([0, null]);
  }, 20_000);
});
