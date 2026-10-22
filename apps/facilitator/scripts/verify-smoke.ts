/**
 * Testnet smoke run of `/verify` (0018): a real client signs an `exact` payment with upstream's
 * client, and two verifiers built from the config, as `main()` builds them, check it.
 *
 * 1. Plain facilitator: the payment is valid (`isValid: true`, `payer` = the client).
 * 2. Facilitator that lists the client's address as a channel: rejected by the channel check,
 *    with our code in `extra.reason`.
 *
 * Only the verifier, not `main()`: `main()` refuses to start on channels its key can't sign for
 * alone (0020), and the client's address is one. `settle-smoke.ts` runs `main()` on real
 * channels.
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
import { Agent, setGlobalDispatcher } from "undici";
import { parseConfig } from "../src/config.js";
import { jsonLogger } from "../src/logger.js";
import { UPSTREAM_TIMEOUT_MS, buildRpc, buildVerifier } from "../src/main.js";
import { feeSettings } from "../src/settlement/fees.js";

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

/** The verifiers' log events; the lines go on to stderr. */
const events: { event: string; rpc?: string }[] = [];
const write = (line: string) => {
  events.push(JSON.parse(line) as { event: string; rpc?: string });
  process.stderr.write(line);
};

// The same bounds `main()` sets for stellar-sdk's fetch: a hung RPC URL fails after 10 s.
setGlobalDispatcher(
  new Agent({ headersTimeout: UPSTREAM_TIMEOUT_MS, bodyTimeout: UPSTREAM_TIMEOUT_MS }),
);

async function verifyWith(
  channels: string,
): Promise<{ answer: VerifyResponse; rpc?: string; failedOver: boolean }> {
  const from = events.length;
  // A fresh facilitator key: verify never spends from it.
  const config = parseConfig({
    FACILITATOR_SECRET: Keypair.random().secret(),
    CHANNELS: channels,
    LOG_LEVEL: "info",
    MIN_VALIDITY_LEDGERS: process.env.MIN_VALIDITY_LEDGERS,
    RPC_URLS: process.env.RPC_URLS,
  });
  const logger = jsonLogger(config.logLevel, write, config.rpcUrls);
  const rpc = buildRpc(config, logger);
  const verify = buildVerifier(config, rpc, feeSettings(config.fees, rpc), logger);
  const trace: { rpc?: string } = {};
  const answer = await verify(paymentPayload, requirements, trace);
  return {
    answer,
    rpc: trace.rpc,
    failedOver: events.slice(from).some((e) => e.event === "rpc_failover"),
  };
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
