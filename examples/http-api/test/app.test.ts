import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const PAY_TO = "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/**
 * Answers `/supported` like the x402.org facilitator does for Stellar testnet, accepts every
 * payment at `/verify`, and records which paths were called.
 */
let facilitator: Server;
const facilitatorCalls: string[] = [];
let seller: Server;
let sellerUrl: string;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

beforeAll(async () => {
  facilitator = createServer((req, res) => {
    facilitatorCalls.push(req.url!);
    if (req.url === "/verify") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ isValid: true, payer: PAY_TO }));
    }
    if (req.url !== "/supported") return void res.writeHead(404).end();
    const kinds = [
      {
        x402Version: 2,
        scheme: "exact",
        network: "stellar:testnet",
        extra: { areFeesSponsored: true },
      },
    ];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ kinds, extensions: [], signers: {} }));
  });
  const facilitatorUrl = await listen(facilitator);
  seller = createServer(createApp({ payTo: PAY_TO, facilitatorUrl }));
  sellerUrl = await listen(seller);
});

afterAll(() => {
  seller.close();
  facilitator.close();
});

describe("GET /weather", () => {
  it("asks 0.001 testnet USDC and describes the call for the Bazaar", async () => {
    const response = await fetch(`${sellerUrl}/weather?city=Warsaw`);
    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: "exact",
        network: "stellar:testnet",
        amount: "10000",
        asset: USDC,
        payTo: PAY_TO,
        extra: expect.objectContaining({ areFeesSponsored: true }),
      }),
    ]);
    expect(required.extensions?.bazaar).toMatchObject({
      info: {
        input: { type: "http", method: "GET", queryParams: { city: "Warsaw" } },
        output: { example: { city: "Warsaw", tempC: 14 } },
      },
    });
  });

  it("refuses a paid request without a city and does not settle it", async () => {
    const terms = await fetch(`${sellerUrl}/weather`);
    const [accepted] = decodePaymentRequiredHeader(terms.headers.get("payment-required")!).accepts;
    const signature = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: accepted!,
      payload: { transaction: "signed-by-the-buyer" },
    });

    const response = await fetch(`${sellerUrl}/weather`, {
      headers: { "payment-signature": signature },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "city is required" });
    expect(facilitatorCalls).toContain("/verify");
    expect(facilitatorCalls).not.toContain("/settle");
  });

  it("serves nothing else", async () => {
    expect((await fetch(`${sellerUrl}/other`)).status).toBe(404);
  });
});
