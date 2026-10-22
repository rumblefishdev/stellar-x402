/**
 * Testnet smoke run of `POST /verify` (0018): a real client signs an `exact` payment with
 * upstream's client, and two facilitators built by `main()` verify it.
 *
 * 1. Plain facilitator: the payment is valid (`isValid: true`, `payer` = the client).
 * 2. Facilitator that lists the client's address as a channel: rejected by the channel check,
 *    with our code in `extra.reason`.
 *
 * Env:
 *   CLIENT_SECRET  funded testnet key that pays (never printed)
 *   PAY_TO         funded testnet account that receives
 *   ASSET          token contract (default: the testnet XLM SAC)
 *   AMOUNT         base units (default 1000 = 0.0001 XLM)
 *   MIN_VALIDITY_LEDGERS  passed to the facilitators (default: the config default, 4)
 *   RPC_URLS       passed to the facilitators (default: the testnet RPC); a down first URL shows
 *                  the failover (0045)
 *   EXPECT_FAILOVER  1: also check that each `/verify` failed over, logging `rpc_failover`, and
 *                  was answered by `RPC_URLS[1]` (0045)
 *
 *   cd apps/facilitator
 *   CLIENT_SECRET=$(stellar keys show x402-verify-client) \
 *     PAY_TO=$(stellar keys address x402-verify-seller) npx tsx scripts/verify-smoke.ts
 *
 * Nothing is submitted: `/verify` only simulates. The facilitators' log lines go to stderr, so
 * stdout carries only the result.
 */
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { Agent, fetch } from "undici";
import { main } from "../src/main.js";

const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const network = "stellar:testnet";

const clientSecret = process.env.CLIENT_SECRET;
const payTo = process.env.PAY_TO;
if (!clientSecret || !payTo) {
  console.error("set CLIENT_SECRET and PAY_TO (see the header of this file)");
  process.exit(2);
}

const client = createEd25519Signer(clientSecret, network);
const requirements: PaymentRequirements = {
  scheme: "exact",
  network,
  asset: process.env.ASSET ?? XLM_SAC_TESTNET,
  amount: process.env.AMOUNT ?? "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

const signed = await new ExactStellarScheme(client).createPaymentPayload(2, requirements);
const paymentPayload = { ...signed, accepted: requirements };

/** The facilitators' log events, from `main()`'s log sink; the lines go on to stderr. */
const events: { event: string; rpc?: string }[] = [];
const write = (line: string) => {
  events.push(JSON.parse(line) as { event: string; rpc?: string });
  process.stderr.write(line);
};

/** The script's own HTTP client, apart from the global one `main()` sets for the facilitator. */
const http = new Agent({ headersTimeout: 120_000 });

async function verifyWith(
  channels: string,
): Promise<{ answer: VerifyResponse; rpc?: string; failedOver: boolean }> {
  const from = events.length;
  // A fresh facilitator key: verify never spends from it.
  const server = await main(
    {
      FACILITATOR_SECRET: Keypair.random().secret(),
      CHANNELS: channels,
      PORT: "0",
      LOG_LEVEL: "info",
      MIN_VALIDITY_LEDGERS: process.env.MIN_VALIDITY_LEDGERS,
      RPC_URLS: process.env.RPC_URLS,
    },
    { write },
  );
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/verify`, {
      // `main()` bounds this process's `fetch` at 10 s without headers; a hung first RPC URL makes
      // `/verify` itself take longer.
      dispatcher: http,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements }),
    });
    if (response.status !== 200) throw new Error(`/verify answered ${response.status}`);
    const answer = (await response.json()) as VerifyResponse;
    const own = events.slice(from);
    return {
      answer,
      rpc: own.find((e) => e.event === "verified")?.rpc,
      failedOver: own.some((e) => e.event === "rpc_failover"),
    };
  } finally {
    await server.close();
  }
}

const plain = await verifyWith(Keypair.random().publicKey());
const channelled = await verifyWith(client.address);
const valid = plain.answer;
const channel = channelled.answer;
const expectFailover = process.env.EXPECT_FAILOVER === "1";

const checks = {
  validPayment: valid.isValid === true && valid.payer === client.address,
  // The client's address is the payer and may also be the transaction source, so any of
  // upstream's three facilitator codes can come first.
  channelRejected:
    channel.isValid === false &&
    channel.extra?.reason === "invalid_exact_stellar_payload_channel_account",
  ...(expectFailover && {
    failedOver: [plain, channelled].every((r) => r.failedOver && r.rpc?.startsWith("RPC_URLS[1]#")),
  }),
};
const answeredBy = { valid: plain.rpc, channel: channelled.rpc };
console.log(
  JSON.stringify({ payer: client.address, payTo, valid, channel, answeredBy, checks }, null, 2),
);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
