import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";

export interface SellerRequest {
  method: string;
  url: string;
  body: string;
}

export interface Seller {
  /** What it was asked, in order. */
  requests: SellerRequest[];
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** The 402 terms for a request to `url`; tests replace it. */
  paymentRequired: (url: string) => PaymentRequired;
  /** The answer to a request: a 402 with `paymentRequired` by default, or `body` as its terms. */
  reply: (request: SellerRequest) => Promise<{ status: number; body?: PaymentRequired }>;
  server: Server;
}

const read = async (req: IncomingMessage) => {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  return body;
};

/** A seller on this machine for the cataloger's check (0063): answers unpaid requests with a 402. */
export async function startSeller(paymentRequired: Seller["paymentRequired"]): Promise<Seller> {
  const seller: Seller = {
    requests: [],
    url: "",
    paymentRequired,
    reply: async () => ({ status: 402 }),
    server: createServer((req, res) => {
      void (async () => {
        const request = { method: req.method!, url: req.url!, body: await read(req) };
        seller.requests.push(request);
        const { status, body } = await seller.reply(request);
        const terms = body ?? seller.paymentRequired(`${seller.url}${req.url}`);
        const headers =
          status === 402 ? { "payment-required": encodePaymentRequiredHeader(terms) } : {};
        res.writeHead(status, headers).end();
      })();
    }),
  };
  seller.server.listen(0, "127.0.0.1");
  await once(seller.server, "listening");
  seller.url = `http://127.0.0.1:${(seller.server.address() as AddressInfo).port}`;
  return seller;
}
