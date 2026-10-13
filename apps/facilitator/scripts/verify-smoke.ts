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
 *
 *   cd apps/facilitator
 *   CLIENT_SECRET=$(stellar keys show x402-verify-client) \
 *     PAY_TO=$(stellar keys address x402-verify-seller) npx tsx scripts/verify-smoke.ts
 *
 * Nothing is submitted: `/verify` only simulates.
 */
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
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

/** A port the OS reports free (`PORT` must be 1–65535, so not 0). */
async function freePort(): Promise<number> {
  const probe = createServer().listen(0);
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function verifyWith(channels: string): Promise<VerifyResponse> {
  const port = await freePort();
  // A fresh facilitator key: verify never spends from it.
  const server = await main({
    FACILITATOR_SECRET: Keypair.random().secret(),
    CHANNELS: channels,
    PORT: String(port),
    LOG_LEVEL: "warn",
    MIN_VALIDITY_LEDGERS: process.env.MIN_VALIDITY_LEDGERS,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements }),
    });
    if (response.status !== 200) throw new Error(`/verify answered ${response.status}`);
    return (await response.json()) as VerifyResponse;
  } finally {
    await server.close();
  }
}

const valid = await verifyWith(Keypair.random().publicKey());
const channel = await verifyWith(client.address);

const checks = {
  validPayment: valid.isValid === true && valid.payer === client.address,
  // The client's address is the payer and may also be the transaction source, so any of
  // upstream's three facilitator codes can come first.
  channelRejected:
    channel.isValid === false &&
    channel.extra?.reason === "invalid_exact_stellar_payload_channel_account",
};
console.log(JSON.stringify({ payer: client.address, payTo, valid, channel, checks }, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
