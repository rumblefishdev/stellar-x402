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
  /** What the seller's facilitator answers to a signed retry. */
  settle: "success" | "rejected" | "missing";
  body: string;
  /** Payment payloads received, in order. */
  payments: unknown[];
  close(): Promise<void>;
}

export async function startFakeSeller(): Promise<FakeSeller> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/free") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"free":true}');
      return;
    }
    if (url.pathname === "/slow") {
      setTimeout(() => res.writeHead(200).end("{}"), 1_000);
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "https://elsewhere.example.com/" }).end();
      return;
    }
    const signature = req.headers["payment-signature"];
    if (typeof signature !== "string") {
      const required: PaymentRequired = {
        x402Version: 2,
        resource: {
          url: `${seller.url}${url.pathname}`,
          description: "Forecast",
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "exact",
            network: seller.network as PaymentRequired["accepts"][number]["network"],
            amount: seller.price,
            asset: seller.asset,
            payTo: "GSELLERA",
            maxTimeoutSeconds: 60,
            extra: { areFeesSponsored: true },
          },
        ],
      };
      res.writeHead(402, { "payment-required": encodePaymentRequiredHeader(required) }).end("{}");
      return;
    }
    seller.payments.push(decodePaymentSignatureHeader(signature));
    if (seller.settle === "missing") {
      res.writeHead(200, { "content-type": "application/json" }).end(seller.body);
      return;
    }
    const success = seller.settle === "success";
    const settled = encodePaymentResponseHeader({
      success,
      transaction: success ? "a".repeat(64) : "",
      network: seller.network as PaymentRequired["accepts"][number]["network"],
      payer: "GBUYER",
      errorReason: success ? undefined : "insufficient_funds",
    });
    res
      .writeHead(success ? 200 : 402, {
        "content-type": "application/json",
        "payment-response": settled,
      })
      .end(success ? seller.body : "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const seller: FakeSeller = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    price: "10000",
    asset: USDC,
    network: "stellar:testnet",
    settle: "success",
    body: '{"tempC":14}',
    payments: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return seller;
}

/** Stands in for `ExactStellarScheme`: "signs" without a key or an RPC; the first `failures` calls fail. */
export function fakeScheme(failures = 0): SchemeNetworkClient {
  let calls = 0;
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version, requirements) {
      calls += 1;
      if (calls <= failures) throw new Error("simulation failed: the payer has no USDC trustline");
      return { x402Version, payload: { fake: true, amount: requirements.amount } };
    },
  };
}
