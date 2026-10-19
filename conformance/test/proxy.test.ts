import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// The proxy is started the way the x402 e2e suite starts it: `bash run.sh` in its folder, PORT set.
const folder = fileURLToPath(new URL("../external-proxy", import.meta.url));

interface Seen {
  method?: string;
  url?: string;
  contentType?: string;
  body: string;
}

/** A facilitator stand-in that records each request and answers what `answer` says. */
let seen: Seen[] = [];
const valid = { status: 200, contentType: "application/json", body: '{"isValid":true}' };
let answer = valid;
let facilitator: Server;
let facilitatorUrl: string;

beforeAll(async () => {
  facilitator = createServer(async (req, res) => {
    const body = await text(req);
    seen.push({ method: req.method, url: req.url, contentType: req.headers["content-type"], body });
    res.writeHead(answer.status, answer.contentType ? { "content-type": answer.contentType } : {});
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
  facilitatorUrl = `http://127.0.0.1:${(facilitator.address() as AddressInfo).port}`;
});

afterAll(() => facilitator.close());

/** A port free on `host`; the proxy listens on `localhost`, which may be IPv6 only. */
async function freePort(host = "localhost") {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const started: ChildProcess[] = [];

afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  seen = [];
  answer = valid;
});

/** Starts the proxy and resolves once it printed the line the suite waits for. */
async function startProxy(target = facilitatorUrl) {
  const port = await freePort();
  const child = spawn("bash", ["run.sh"], {
    cwd: folder,
    env: { ...process.env, PORT: String(port), GATE_FACILITATOR_URL: target },
  });
  started.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("Facilitator listening")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`proxy exited with ${code}: ${stderr}`)));
  });
  return { child, url: `http://localhost:${port}` };
}

function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
}

describe("external proxy", () => {
  // An address of this machine other than loopback, as another host on the network would use.
  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((address) => address && !address.internal && address.family === "IPv4")?.address;

  it.skipIf(!lanAddress)("is not reachable from the network, only from this machine", async () => {
    const proxy = await startProxy();
    const port = new URL(proxy.url).port;
    await expect(fetch(`http://${lanAddress}:${port}/health`)).rejects.toThrow();
    expect((await fetch(`${proxy.url}/health`)).status).toBe(200);
  });

  it("answers /health itself with a JSON body", async () => {
    const proxy = await startProxy();
    const res = await fetch(`${proxy.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(seen).toEqual([]);
  });

  it("forwards /verify with its body and returns the facilitator's answer", async () => {
    const proxy = await startProxy();
    const body = JSON.stringify({ x402Version: 2, paymentPayload: {}, paymentRequirements: {} });
    const res = await fetch(`${proxy.url}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"isValid":true}');
    expect(seen).toEqual([
      { method: "POST", url: "/verify", contentType: "application/json", body },
    ]);
  });

  it("passes a facilitator error through unchanged", async () => {
    answer = { status: 500, contentType: "application/json", body: '{"error":"internal_error"}' };
    const proxy = await startProxy();
    const res = await fetch(`${proxy.url}/settle`, { method: "POST", body: "{}" });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual(["POST /settle"]);
  });

  it("passes a non-JSON answer through with its content type, like a load balancer's error page", async () => {
    answer = { status: 503, contentType: "text/html", body: "<h1>busy</h1>" };
    const proxy = await startProxy();
    const res = await fetch(`${proxy.url}/supported`);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<h1>busy</h1>");
  });

  it("labels an answer without a content type as nothing", async () => {
    answer = { status: 200, contentType: "", body: "ok" };
    const proxy = await startProxy();
    const res = await fetch(`${proxy.url}/supported`);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("ok");
  });

  it("forwards GET /supported", async () => {
    answer = { status: 200, contentType: "application/json", body: '{"kinds":[]}' };
    const proxy = await startProxy();
    const res = await fetch(`${proxy.url}/supported`);
    expect(await res.text()).toBe('{"kinds":[]}');
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /supported"]);
  });

  it("forwards nothing else", async () => {
    const proxy = await startProxy();
    for (const [method, path] of [
      ["GET", "/discovery/resources"],
      ["GET", "/verify"],
      ["POST", "/supported"],
      ["GET", "/settle?x=1"],
    ] as const) {
      const res = await fetch(`${proxy.url}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it("answers 502 when the facilitator cannot be reached", async () => {
    const proxy = await startProxy(`http://127.0.0.1:${await freePort("127.0.0.1")}`);
    const res = await fetch(`${proxy.url}/supported`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "facilitator_unreachable" });
  });

  it("exits 0 after answering /close", async () => {
    const proxy = await startProxy();
    const exit = exited(proxy.child);
    const res = await fetch(`${proxy.url}/close`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await exit).toEqual({ code: 0, signal: null });
  });

  it("stops on SIGTERM to the process the suite started, freeing its port", async () => {
    const proxy = await startProxy();
    const exit = exited(proxy.child);
    proxy.child.kill("SIGTERM");
    await exit;
    await expect(fetch(`${proxy.url}/health`)).rejects.toThrow();
  });

  it("refuses to start without a target", async () => {
    const child = spawn("bash", ["run.sh"], {
      cwd: folder,
      env: { ...process.env, PORT: String(await freePort()), GATE_FACILITATOR_URL: "" },
    });
    started.push(child);
    expect(await exited(child)).toEqual({ code: 1, signal: null });
  });
});
