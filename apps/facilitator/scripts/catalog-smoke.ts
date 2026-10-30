/**
 * Testnet run of cataloging from the seller's own 402 (0063): real `exact` payments settled by a
 * facilitator built by `main()`, a seller that answers 402 and settles through it, a buyer that
 * pays with upstream's client, and an outsider that calls `/settle` itself.
 *
 * 1. The buyer pays: the header says `processing`, then the facilitator asks the seller with one
 *    unpaid request (the listing's example query) and lists what the seller's 402 says.
 * 2. The buyer pays again: its copy matches the listing, so the seller is not asked.
 * 3. An outsider settles 1 stroop to the seller's `payTo` with a copy saying "Pwned": in the same
 *    minute it is over the per-key budget; a minute later the seller is asked and the listing
 *    keeps the seller's text and price.
 * 4. The seller raises its price; the buyer's next copy differs, and the check replaces the offer.
 *
 * Env: DATABASE_URL (default: the compose database, schema `catalog_smoke`, recreated).
 * Fresh friendbot-funded keys; the facilitator pays the fees.
 *
 *   cd apps/facilitator && npx tsx scripts/catalog-smoke.ts
 *
 * The facilitator's log lines go to stderr, so stdout carries only the result.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Account, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { buildCreateChannelsTx, readAccountEntry } from "@stellar-x402/signer-pool";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import pg from "pg";
import { Agent, fetch } from "undici";
import { migrate } from "../src/adapters/postgres-schema.js";
import { main } from "../src/main.js";

const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RPC_URL = "https://soroban-testnet.stellar.org";
const network = "stellar:testnet";
const server = new rpc.Server(RPC_URL);
const http = new Agent({ headersTimeout: 120_000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SCHEMA = "catalog_smoke";
const base = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:15432/postgres";
const databaseUrl = (() => {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${SCHEMA}`);
  return url.toString();
})();
const admin = new pg.Pool({ connectionString: base, max: 1 });
await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
await migrate(db);

async function funded(): Promise<Keypair> {
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`, {
    dispatcher: http,
  });
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

const [facilitator, buyer, outsider, seller] = await Promise.all([
  funded(),
  funded(),
  funded(),
  funded(),
]);

const channelKeys = [Keypair.random(), Keypair.random()];
const facilitatorEntry = await readAccountEntry(server, facilitator.publicKey());
if (!facilitatorEntry) throw new Error("the facilitator account does not exist");
const setup = buildCreateChannelsTx({
  facilitator: new Account(facilitator.publicKey(), facilitatorEntry.seqNum().toString()),
  channels: channelKeys,
  networkPassphrase: Networks.TESTNET,
  fee: 1000,
});
setup.sign(facilitator, ...channelKeys);
const created = await server.pollTransaction((await server.sendTransaction(setup)).hash, {
  attempts: 30,
});
if (created.status !== "SUCCESS") throw new Error(`channel setup ${created.status}`);

const facilitatorServer = await main(
  {
    FACILITATOR_SECRET: facilitator.secret(),
    DATABASE_URL: databaseUrl,
    CLIENT_IP: "socket",
    CHANNELS: channelKeys.map((keypair) => keypair.publicKey()).join(","),
    PORT: "0",
    LOG_LEVEL: "info",
    // The seller runs on this machine, over http.
    CATALOG_LIST_LOCAL: "true",
  },
  { write: (line) => process.stderr.write(line) },
);
const facilitatorUrl = `http://127.0.0.1:${facilitatorServer.port}`;

// The seller: GET /weather costs `price` stroops of testnet XLM, described for the Bazaar.
let price = "10000";
const unpaid: string[] = [];
const settles: { transaction?: string; extensionResponses: string | null }[] = [];
const bazaar = {
  info: {
    input: { type: "http", method: "GET", queryParams: { city: "Warsaw" } },
    output: { type: "json", example: { city: "Warsaw", celsius: 12 } },
  },
};
const requirements = (): PaymentRequirements => ({
  scheme: "exact",
  network,
  asset: XLM_SAC_TESTNET,
  amount: price,
  payTo: seller.publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
});
const sellerServer = createServer((req, res) => {
  void (async () => {
    const url = `${sellerUrl}${req.url}`;
    const signature = req.headers["payment-signature"];
    if (typeof signature !== "string") {
      unpaid.push(`${req.method} ${req.url}`);
      const terms: PaymentRequired = {
        x402Version: 2,
        resource: { url, description: "Weather by city", mimeType: "application/json" },
        accepts: [requirements()],
        extensions: { bazaar },
      };
      res.writeHead(402, { "payment-required": encodePaymentRequiredHeader(terms) }).end();
      return;
    }
    const answer = await fetch(`${facilitatorUrl}/settle`, {
      dispatcher: http,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: decodePaymentSignatureHeader(signature),
        paymentRequirements: requirements(),
      }),
    });
    const settled = (await answer.json()) as { success: boolean; transaction?: string };
    settles.push({
      transaction: settled.transaction,
      extensionResponses: answer.headers.get("extension-responses"),
    });
    res.writeHead(settled.success ? 200 : 402, { "content-type": "application/json" });
    res.end(JSON.stringify({ city: "Warsaw", celsius: 12 }));
  })();
});
sellerServer.listen(0, "127.0.0.1");
await once(sellerServer, "listening");
const sellerUrl = `http://127.0.0.1:${(sellerServer.address() as AddressInfo).port}`;
const resourceUrl = `${sellerUrl}/weather?city=Warsaw`;

// The buyer: upstream's client copies the seller's `resource` and `extensions` into its payment.
const client = x402Client.fromConfig({
  schemes: [
    { network, client: new ExactStellarScheme(createEd25519Signer(buyer.secret(), network)) },
  ],
  spendControls: false,
});
async function buy(): Promise<number> {
  const first = await fetch(resourceUrl, { dispatcher: http });
  const terms = decodePaymentRequiredHeader(first.headers.get("payment-required")!);
  const payload = await client.createPaymentPayload(terms);
  const paid = await fetch(resourceUrl, {
    dispatcher: http,
    headers: { "payment-signature": encodePaymentSignatureHeader(payload) },
  });
  return paid.status;
}

// The outsider: its own copy of the listing, 1 stroop to the seller's payTo, straight to /settle.
const outsiderScheme = new ExactStellarScheme(createEd25519Signer(outsider.secret(), network));
async function outsiderSettle() {
  const cheap = { ...requirements(), amount: "1" };
  const partial = await outsiderScheme.createPaymentPayload(2, cheap);
  const payload: PaymentPayload = {
    ...partial,
    accepted: cheap,
    resource: { url: resourceUrl, description: "Pwned", mimeType: "application/json" },
    extensions: { bazaar },
  };
  const answer = await fetch(`${facilitatorUrl}/settle`, {
    dispatcher: http,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: cheap }),
  });
  const settled = (await answer.json()) as { success: boolean; transaction?: string };
  settles.push({
    transaction: settled.transaction,
    extensionResponses: answer.headers.get("extension-responses"),
  });
  return settled.success;
}

const attempts = async () =>
  (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM catalog_attempts")).rows[0]!.n;
/** Waits until the cataloger has recorded `n` attempts: it runs after the settle response. */
async function attemptsReach(n: number) {
  for (let i = 0; i < 100 && (await attempts()) < n; i++) await sleep(200);
}
/** Waits for the next minute's budget windows, which the rate-limit store aligns to the clock. */
const nextMinute = () => sleep(60_000 - (Date.now() % 60_000) + 1_000);
const listing = async () => {
  const response = await fetch(`${facilitatorUrl}/discovery/resources`, { dispatcher: http });
  const { items } = (await response.json()) as {
    items: {
      description?: string;
      accepts: { amount: string; payTo: string }[];
      lastUpdated: string;
    }[];
  };
  return items.map((item) => ({
    description: item.description,
    amounts: item.accepts.map((offer) => offer.amount),
    lastUpdated: item.lastUpdated,
  }));
};

try {
  const steps: Record<string, unknown> = {};
  await nextMinute();
  steps.buyerPays = await buy();
  await attemptsReach(1);
  steps.afterBuyer = { listing: await listing(), unpaid: [...unpaid] };

  steps.buyerPaysAgain = await buy();
  await attemptsReach(2);
  steps.afterRepeat = { listing: await listing(), unpaid: [...unpaid] };

  steps.outsiderSameMinute = await outsiderSettle();
  await attemptsReach(3);
  steps.afterOutsiderSameMinute = { listing: await listing(), unpaid: [...unpaid] };

  await nextMinute();
  steps.outsiderNextMinute = await outsiderSettle();
  await attemptsReach(4);
  steps.afterOutsiderNextMinute = { listing: await listing(), unpaid: [...unpaid] };

  price = "20000";
  await nextMinute();
  steps.buyerPaysNewPrice = await buy();
  await attemptsReach(5);
  steps.afterNewPrice = { listing: await listing(), unpaid: [...unpaid] };

  const rows = (
    await db.query(
      `SELECT stage, outcome, reason, payer, transaction, resource_url, url, content_hash
       FROM catalog_attempts ORDER BY id`,
    )
  ).rows;
  const onChain = await Promise.all(
    settles.map(async ({ transaction }) =>
      transaction
        ? (await server.pollTransaction(transaction, { attempts: 30 })).status
        : undefined,
    ),
  );
  console.log(
    JSON.stringify(
      {
        facilitator: facilitator.publicKey(),
        seller: seller.publicKey(),
        buyer: buyer.publicKey(),
        outsider: outsider.publicKey(),
        steps,
        settles: settles.map((s, i) => ({
          ...s,
          extensionResponses: s.extensionResponses
            ? JSON.parse(Buffer.from(s.extensionResponses, "base64").toString())
            : null,
          onChain: onChain[i],
        })),
        attempts: rows,
      },
      null,
      2,
    ),
  );
} finally {
  sellerServer.close();
  await facilitatorServer.close();
  await db.end();
  await admin.end();
}
