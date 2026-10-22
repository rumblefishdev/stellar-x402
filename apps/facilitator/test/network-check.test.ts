import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Networks } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpcEndpointName } from "../src/logger.js";
import { checkRpcNetworks } from "../src/settlement/network-check.js";
import { rpcStub } from "./rpc-stub.js";

describe("checkRpcNetworks", () => {
  let testnet: Awaited<ReturnType<typeof rpcStub>>;
  let pubnet: Awaited<ReturnType<typeof rpcStub>>;
  beforeAll(async () => {
    testnet = await rpcStub({});
    pubnet = await rpcStub({}, Networks.PUBLIC);
  });
  afterAll(async () => {
    await testnet.close();
    await pubnet.close();
  });

  it("passes when every entry serves the network", async () => {
    await expect(
      checkRpcNetworks([testnet.url, testnet.url], Networks.TESTNET),
    ).resolves.toBeUndefined();
  });

  it("names the entry that serves another network, and only that one", async () => {
    const error = await checkRpcNetworks([testnet.url, pubnet.url], Networks.TESTNET).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain(
      `${rpcEndpointName(pubnet.url, 1)}: serves "${Networks.PUBLIC}"`,
    );
    expect((error as Error).message).not.toContain(rpcEndpointName(testnet.url, 0));
  });

  it("names a JSON-RPC error answer by its code and message", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "method not found" },
        }),
      );
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const error = await checkRpcNetworks([url], Networks.TESTNET).catch((e: unknown) => e);
      expect((error as Error).message).toContain(
        `${rpcEndpointName(url, 0)}: {"code":-32601,"message":"method not found"}`,
      );
    } finally {
      server.close();
    }
  });
});
