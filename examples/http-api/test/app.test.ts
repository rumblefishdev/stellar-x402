import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { type DiscoveryExtension, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const PAY_TO = "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF";
const BUYER = "GCPXX7YPXXKAFT2356FXZV3WUNMD35WYSCBTO5V62XV5YIIVSH64N66K";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TRANSACTION = "a".repeat(64);

let facilitator: Server;
let seller: Server;
let sellerUrl: string;
/** The paths the seller called on the facilitator, reset before each test. */
let facilitatorCalls: string[] = [];
/** The `Authorization` header of each call, by path. */
let authorizations: Record<string, string | undefined> = {};
/** What the fake facilitator answers about the listing with each settlement. */
let catalogAnswer: unknown;
/** The seller's log lines. */
let logs: string[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function json(res: ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Signs nothing: the fake facilitator accepts any payload, so the shape is all that matters. */
async function paymentFor(path: string): Promise<string> {
  const terms = await fetch(`${sellerUrl}${path}`);
  const [accepted] = decodePaymentRequiredHeader(terms.headers.get("payment-required")!).accepts;
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: accepted!,
    payload: { transaction: "signed-by-the-buyer" },
  });
}

beforeAll(async () => {
  // Answers `/supported` like the x402.org facilitator does for Stellar testnet, accepts every
  // payment at `/verify` and settles it at `/settle`.
  facilitator = createServer((req, res) => {
    facilitatorCalls.push(req.url!);
    authorizations[req.url!] = req.headers.authorization;
    if (req.url === "/supported") {
      const kinds = [
        {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          extra: { areFeesSponsored: true },
        },
      ];
      return json(res, { kinds, extensions: [], signers: {} });
    }
    if (req.url === "/verify") return json(res, { isValid: true, payer: BUYER });
    if (req.url === "/settle") {
      // As this project's facilitator: its answer about the listing rides in a header.
      const extensions: Record<string, string> = catalogAnswer
        ? { "EXTENSION-RESPONSES": Buffer.from(JSON.stringify(catalogAnswer)).toString("base64") }
        : {};
      return json(
        res,
        { success: true, payer: BUYER, transaction: TRANSACTION, network: "stellar:testnet" },
        extensions,
      );
    }
    res.writeHead(404).end();
  });
  const facilitatorUrl = await listen(facilitator);
  seller = createServer(
    createApp({
      payTo: PAY_TO,
      facilitatorUrl,
      apiKey: "sx4_seller_key",
      log: (line) => logs.push(line),
    }),
  );
  sellerUrl = await listen(seller);
});

beforeEach(() => {
  facilitatorCalls = [];
  authorizations = {};
  catalogAnswer = undefined;
  logs = [];
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
    const bazaar = required.extensions?.bazaar as DiscoveryExtension;
    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
    expect(bazaar).toMatchObject({
      info: {
        input: { type: "http", method: "GET", queryParams: { city: "Warsaw" } },
        output: { example: { city: "Warsaw", tempC: 14 } },
      },
    });
  });

  it("answers a paid request and settles it", async () => {
    const response = await fetch(`${sellerUrl}/weather?city=Warsaw`, {
      headers: { "payment-signature": await paymentFor("/weather?city=Warsaw") },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ city: "Warsaw", tempC: 14 });
    const settlement = decodePaymentResponseHeader(response.headers.get("payment-response")!);
    expect(settlement).toMatchObject({ success: true, transaction: TRANSACTION });
    expect(facilitatorCalls).toContain("/settle");
  });

  it("sends the API key on /verify and /settle only", async () => {
    await fetch(`${sellerUrl}/weather?city=Warsaw`, {
      headers: { "payment-signature": await paymentFor("/weather?city=Warsaw") },
    });
    expect(authorizations["/verify"]).toBe("Bearer sx4_seller_key");
    expect(authorizations["/settle"]).toBe("Bearer sx4_seller_key");
  });

  it.each([
    [{ bazaar: { status: "processing" } }, ["Bazaar: the listing was taken for cataloging"]],
    [
      { bazaar: { status: "rejected", rejectedReason: "schema_too_complex" } },
      ["Bazaar: the listing was refused (schema_too_complex)"],
    ],
    [undefined, []],
  ])("logs the catalog's answer %j after a settlement", async (answer, lines) => {
    catalogAnswer = answer;
    const response = await fetch(`${sellerUrl}/weather?city=Warsaw`, {
      headers: { "payment-signature": await paymentFor("/weather?city=Warsaw") },
    });
    expect(response.status).toBe(200);
    expect(logs).toEqual(lines);
  });

  it("refuses a paid request without a city and does not settle it", async () => {
    const response = await fetch(`${sellerUrl}/weather`, {
      headers: { "payment-signature": await paymentFor("/weather") },
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
