import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";

/**
 * A local seller for the cases the example seller cannot produce. Its 402 is a copy of the example
 * seller's own, so a real key signs it: the asset and `payTo` are real testnet ones. It never
 * forwards a signed payment to a facilitator, so no money moves.
 */

/** What one path answers: to the unpaid request, and to the request carrying a signed payment. */
export interface Route {
  unpaid?: (res: ServerResponse, terms: PaymentRequired) => void;
  paid?: (res: ServerResponse) => void;
}

export interface FakeSeller {
  url: string;
  /**
   * Requests received, in order: the path, and the offer the buyer signed when the request carried a
   * payment, decoded from its header (the seller's own record, not the buyer's report).
   */
  requests: {
    path: string;
    paid: boolean;
    signed?: { amount: string; asset: string; payTo: string };
  }[];
  close(): Promise<void>;
}

/**
 * The terms with one offer per change, each the copied offer with the named fields changed: the one
 * place where a scenario says what differs from the example seller.
 */
export function withOffers(
  terms: PaymentRequired,
  ...changes: Partial<PaymentRequired["accepts"][number]>[]
): PaymentRequired {
  return { ...terms, accepts: changes.map((change) => ({ ...terms.accepts[0]!, ...change })) };
}

export function answer402(terms: PaymentRequired) {
  return (res: ServerResponse) =>
    res.writeHead(402, { "payment-required": encodePaymentRequiredHeader(terms) }).end("{}");
}

/** A settlement header as an x402 seller sends it after its facilitator settled (or not). */
export function settlement(success: boolean, transaction: string): string {
  return encodePaymentResponseHeader({
    success,
    transaction,
    network: "stellar:testnet",
    payer: "GBUYER",
  } as Parameters<typeof encodePaymentResponseHeader>[0]);
}

/** A transaction hash that looks real; the fake seller never settles, so it is on no ledger. */
export const FAKE_HASH = "ab".repeat(32);

/** Starts a seller answering `routes`; a route's unpaid answer defaults to the copied 402. */
export async function startFakeSeller(
  terms: PaymentRequired,
  routes: Record<string, Route>,
): Promise<FakeSeller> {
  const requests: FakeSeller["requests"] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const header = req.headers["payment-signature"];
    const paid = typeof header === "string";
    const signed = paid ? decodePaymentSignatureHeader(header).accepted : undefined;
    requests.push({
      path,
      paid,
      signed: signed && { amount: signed.amount, asset: signed.asset, payTo: signed.payTo },
    });
    const route = routes[path];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const resourceTerms = {
      ...terms,
      resource: { ...terms.resource, url: `${seller.url}${path}` },
    };
    if (paid) (route.paid ?? ((r) => r.writeHead(200).end("{}")))(res);
    else if (route.unpaid) route.unpaid(res, resourceTerms);
    else answer402(resourceTerms)(res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const seller: FakeSeller = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
  return seller;
}
