import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PAY_TO = "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF";
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

let facilitator: Server;
let facilitatorUrl: string;
let seller: ChildProcess | undefined;

/** Testnet USDC's asset contract instance, as the RPC holds it. */
const USDC_INSTANCE = xdr.LedgerEntryData.contractData(
  new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: new Address(USDC_TESTNET_ADDRESS).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(
      new xdr.ScContractInstance({
        executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        storage: [
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("METADATA"),
            val: nativeToScVal({
              decimal: 7,
              name: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              symbol: "USDC",
            }),
          }),
        ],
      }),
    ),
  }),
).toXDR("base64");

/**
 * A Stellar RPC's `getLedgerEntries` over a ledger that holds USDC's contract and no account: the
 * seller's `payTo` does not exist there.
 */
function answerRpc(body: string): unknown {
  const { id, params } = JSON.parse(body) as { id: number; params: { keys: string[] } };
  const entries = params.keys
    .filter((key) => xdr.LedgerKey.fromXDR(key, "base64").switch().name === "contractData")
    .map((key) => ({ key, xdr: USDC_INSTANCE, lastModifiedLedgerSeq: 1 }));
  return { jsonrpc: "2.0", id, result: { entries, latestLedger: 1 } };
}

beforeAll(async () => {
  // Answers `/supported` as in app.test.ts: all the seller needs to answer a 402. `/rpc` stands in
  // for the Stellar RPC the start checks `payTo`'s trustline on.
  facilitator = createServer((req, res) => {
    if (req.url === "/rpc") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answerRpc(body)));
      });
      return;
    }
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
        // No RPC answers there: the trustline can't be checked, and the seller starts anyway.
        STELLAR_RPC_URL: `${facilitatorUrl}/no-rpc`,
      },
    });
    const child = seller;
    let warnings = "";
    const port = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        // The same pattern as seller.ts, slash included: stdout can arrive cut mid-number.
        const listening = /Paid weather API on http:\/\/localhost:(\d+)\//.exec(output);
        if (listening) resolve(listening[1]!);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        warnings += chunk.toString();
      });
      child.on("exit", (code) => reject(new Error(`example seller exited ${code}: ${output}`)));
    });

    expect(port).not.toBe("0");
    expect(warnings).toContain("Could not check SELLER_ADDRESS's USDC trustline");
    const response = await fetch(`http://127.0.0.1:${port}/weather?city=Warsaw`);
    expect(response.status).toBe(402);
    // Starting through tsx takes seconds on a busy runner, as the facilitator's start tests allow.
  }, 20_000);

  it("stops before listening when SELLER_ADDRESS can't receive USDC", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: PACKAGE,
      env: {
        PATH: process.env.PATH!,
        SELLER_ADDRESS: PAY_TO,
        PORT: "0",
        FACILITATOR_URL: facilitatorUrl,
        STELLAR_RPC_URL: `${facilitatorUrl}/rpc`,
      },
    });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const [code] = (await once(child, "exit")) as [number];
    expect(code).toBe(1);
    expect(output).toContain(
      `SELLER_ADDRESS ${PAY_TO} can't receive testnet USDC (the account does not exist)`,
    );
    expect(output).not.toContain("Paid weather API on");
  }, 20_000);
});
