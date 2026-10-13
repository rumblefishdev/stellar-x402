import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SchemeNetworkClient } from "@x402/core/types";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";

/**
 * A seller that answers 402 the way `@x402/express` does, and settles every signed retry itself:
 * the facilitator's verdict is whatever `settle` says.
 */

export const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export interface FakeSeller {
  url: string;
  price: string;
  asset: string;
  network: string;
  /** How long the seller asks our signed payment to stay valid. */
  maxTimeoutSeconds: number;
  /** Offers listed before the main one, in other assets or at other prices. */
  otherOffers: { asset: string; amount: string }[];
  /**
   * What the seller answers to a signed retry: settled; refused by its facilitator; no settlement
   * header; 402 again without a settlement; a settlement without a transaction; no answer in time.
   */
  settle:
    | "success"
    | "rejected"
    | "missing"
    | "refused"
    | "no-transaction"
    | "slow"
    | "error"
    | "garbled";
  /** How long the seller waits before each answer of a priced resource, unpaid and paid alike. */
  delayMs: number;
  /** Status of a settled answer. */
  paidStatus: number;
  /** The resource description in the 402 answer. */
  description: string;
  /** The `error` field of the 402 answer. */
  termsError?: string;
  /** `extensions.bazaar.schema` of the 402 answer. */
  inputSchema?: unknown;
  contentType: string;
  body: string;
  /** Payment payloads received, in order. */
  payments: unknown[];
  /** Request bodies received, in order. */
  bodies: string[];
  close(): Promise<void>;
}

export async function startFakeSeller(): Promise<FakeSeller> {
  const server: Server = createServer(async (req, res) => {
    let received = "";
    for await (const chunk of req) received += String(chunk);
    seller.bodies.push(received);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/free") {
      res.writeHead(200, { "content-type": seller.contentType }).end(seller.body);
      return;
    }
    if (url.pathname === "/slow") {
      setTimeout(() => res.writeHead(200).end("{}"), 1_000);
      return;
    }
    if (url.pathname === "/stall") {
      // Headers, then part of the body, then nothing.
      res.writeHead(200, { "content-type": "text/plain" }).write("part");
      return;
    }
    if (url.pathname === "/empty-terms") {
      res.writeHead(402, { "payment-required": Buffer.from("{}").toString("base64") }).end();
      return;
    }
    if (url.pathname === "/missing") {
      res.writeHead(404).end();
      return;
    }
    if (url.pathname === "/broken") {
      res.writeHead(500).end();
      return;
    }
    if (url.pathname === "/no-terms") {
      res.writeHead(402).end("{}");
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "https://elsewhere.example.com/" }).end();
      return;
    }
    const signature = req.headers["payment-signature"];
    // A payment counts as received as soon as it arrives, even if the answer comes too late.
    if (typeof signature === "string")
      seller.payments.push(decodePaymentSignatureHeader(signature));
    await new Promise((done) => setTimeout(done, seller.delayMs));
    if (typeof signature !== "string") {
      const required: PaymentRequired = {
        x402Version: 2,
        resource: {
          url: `${seller.url}${url.pathname}`,
          description: seller.description,
          mimeType: seller.contentType,
        },
        error: seller.termsError,
        accepts: [...seller.otherOffers, { asset: seller.asset, amount: seller.price }].map(
          ({ asset, amount }) => ({
            scheme: "exact",
            network: seller.network as PaymentRequired["accepts"][number]["network"],
            amount,
            asset,
            payTo: "GSELLERA",
            maxTimeoutSeconds: seller.maxTimeoutSeconds,
            extra: { areFeesSponsored: true },
          }),
        ),
        extensions: {
          bazaar: {
            info: {
              input: { type: "http", method: "GET", queryParams: { city: "Warsaw" } },
              output: { type: "json", example: { tempC: 14 } },
            },
            schema: seller.inputSchema,
          },
        },
      };
      res.writeHead(402, { "payment-required": encodePaymentRequiredHeader(required) }).end("{}");
      return;
    }
    if (seller.settle === "slow") return;
    if (seller.settle === "missing") {
      res.writeHead(200, { "content-type": seller.contentType }).end(seller.body);
      return;
    }
    if (seller.settle === "garbled") {
      res.writeHead(200, { "payment-response": "not base64 json" }).end(seller.body);
      return;
    }
    if (seller.settle === "error") {
      res.writeHead(502).end();
      return;
    }
    if (seller.settle === "refused") {
      res.writeHead(402).end("{}");
      return;
    }
    const success = seller.settle !== "rejected";
    const settled = encodePaymentResponseHeader({
      success,
      transaction: seller.settle === "success" ? "a".repeat(64) : "",
      network: seller.network as PaymentRequired["accepts"][number]["network"],
      payer: "GBUYER",
      errorReason: success ? undefined : "insufficient_funds",
    });
    res
      .writeHead(success ? seller.paidStatus : 402, {
        "content-type": seller.contentType,
        "payment-response": settled,
      })
      .end(success && seller.paidStatus !== 204 ? seller.body : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const seller: FakeSeller = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    price: "10000",
    asset: USDC,
    network: "stellar:testnet",
    maxTimeoutSeconds: 60,
    otherOffers: [],
    settle: "success",
    delayMs: 0,
    paidStatus: 200,
    description: "Forecast",
    contentType: "application/json",
    body: '{"tempC":14}',
    payments: [],
    bodies: [],
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // A request left unanswered would otherwise keep the server open.
        server.closeAllConnections();
      }),
  };
  return seller;
}

/** What `ExactStellarScheme` throws for a payer without a USDC trustline, as measured on testnet. */
export const NO_TRUSTLINE =
  "Stellar simulation failed with error message: HostError: Error(Contract, #13) " +
  '"trustline entry is missing for account"';

/**
 * Stands in for `ExactStellarScheme`: "signs" without a key or an RPC; the first `failures` calls
 * throw `error`.
 */
export function fakeScheme(failures = 0, error = NO_TRUSTLINE): SchemeNetworkClient {
  let calls = 0;
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version, requirements) {
      calls += 1;
      if (calls <= failures) throw new Error(error);
      return { x402Version, payload: { fake: true, amount: requirements.amount } };
    },
  };
}
