import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PAY_TO = "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF";
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

let facilitator: Server;
let facilitatorUrl: string;
let seller: ChildProcess | undefined;

beforeAll(async () => {
  // Answers `/supported` as in app.test.ts: all the seller needs to answer a 402.
  facilitator = createServer((req, res) => {
    if (req.url !== "/supported") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "stellar:testnet",
            extra: { areFeesSponsored: true },
          },
        ],
        extensions: [],
        signers: {},
      }),
    );
  });
  await new Promise<void>((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
  facilitatorUrl = `http://127.0.0.1:${(facilitator.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (seller && seller.exitCode === null) {
    const exit = once(seller, "exit");
    seller.kill("SIGTERM");
    await exit;
  }
  facilitator.close();
});

describe("src/index.ts", () => {
  // The mcp-local e2e (apps/mcp-local/e2e/src/seller.ts) starts the seller on PORT=0 and reads the
  // port from its start line with this pattern; this test keeps that line usable.
  it("names the port it bound with PORT=0, and answers a 402 there", async () => {
    seller = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: PACKAGE,
      env: {
        PATH: process.env.PATH!,
        SELLER_ADDRESS: PAY_TO,
        PORT: "0",
        FACILITATOR_URL: facilitatorUrl,
      },
    });
    const child = seller;
    const port = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        // The same pattern as seller.ts, slash included: stdout can arrive cut mid-number.
        const listening = /Paid weather API on http:\/\/localhost:(\d+)\//.exec(output);
        if (listening) resolve(listening[1]!);
      });
      child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("exit", (code) => reject(new Error(`example seller exited ${code}: ${output}`)));
    });

    expect(port).not.toBe("0");
    const response = await fetch(`http://127.0.0.1:${port}/weather?city=Warsaw`);
    expect(response.status).toBe(402);

    // In a container it is PID 1, which ignores a SIGTERM it doesn't handle; this one exits 0.
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    expect(await exit).toEqual([0, null]);
    // Starting through tsx takes seconds on a busy runner, as the facilitator's start tests allow.
  }, 20_000);
});
