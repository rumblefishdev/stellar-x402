/**
 * Testnet smoke run of `POST /settle` (0009): real `exact` payments, signed with upstream's
 * client, settled through the channel pool by a facilitator built by `main()`.
 *
 * 1. A payment settles: `success: true`, and the transaction is `SUCCESS` on chain.
 * 2. The same request again gets `…_already_settled` with the same hash: success is answered once.
 * 3. The same payload with other requirements is refused (`…_nonce_already_used`), with the hash.
 * 4. Two concurrent calls for one new payment submit one transaction; one gets the success.
 * 5. `/verify` of the settled payment fails: its nonce is used on chain.
 *
 * Env (each optional; a missing key is a fresh friendbot-funded one, printed by address only):
 *   FACILITATOR_SECRET  pays the fees and creates 2 channels (1.5 XLM each)
 *   CLIENT_SECRET       pays AMOUNT of ASSET per payment
 *   PAY_TO              receives (a funded account)
 *   ASSET               token contract (default: the testnet XLM SAC)
 *   AMOUNT              base units (default 1000 = 0.0001 XLM)
 *   RPC_URLS            passed to the facilitator (default: the testnet RPC); a hung first URL
 *                       shows `/settle`'s checks failing over (0045)
 *   EXPECT_FAILOVER     1: also check that the first `/settle` logged `rpc_failover` from
 *                       `RPC_URLS[0]` to `RPC_URLS[1]` (0045)
 *
 *   cd apps/facilitator && npx tsx scripts/settle-smoke.ts
 *
 * The facilitator's log lines go to stderr, so stdout carries only the result.
 */
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { buildCreateChannelsTx } from "@stellar-x402/signer-pool";
import type { PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { Agent, fetch } from "undici";
import { main } from "../src/main.js";

const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RPC_URL = "https://soroban-testnet.stellar.org";
const network = "stellar:testnet";
const server = new rpc.Server(RPC_URL);

/**
 * The script's own HTTP client, apart from the global one `main()` sets for the facilitator: that
 * one ends a request after 10 s without headers, and a `/settle` behind a hung first RPC URL, or a
 * slow friendbot, takes longer.
 */
const http = new Agent({ headersTimeout: 120_000 });

const events: { event: string; from?: string; to?: string }[] = [];
const write = (line: string) => {
  events.push(JSON.parse(line) as { event: string; from?: string; to?: string });
  process.stderr.write(line);
};

async function funded(secret: string | undefined): Promise<Keypair> {
  if (secret) return Keypair.fromSecret(secret);
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`, {
    dispatcher: http,
  });
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

const facilitator = await funded(process.env.FACILITATOR_SECRET);
const client = await funded(process.env.CLIENT_SECRET);
const payTo = process.env.PAY_TO ?? (await funded(undefined)).publicKey();

// Two delegated channels: master key off, the facilitator their only signer.
const channelKeys = [Keypair.random(), Keypair.random()];
const setup = buildCreateChannelsTx({
  facilitator: await server.getAccount(facilitator.publicKey()),
  channels: channelKeys,
  networkPassphrase: Networks.TESTNET,
  fee: 1000,
});
setup.sign(facilitator, ...channelKeys);
const created = await server.pollTransaction((await server.sendTransaction(setup)).hash, {
  attempts: 30,
});
if (created.status !== "SUCCESS") throw new Error(`channel setup ${created.status}`);

const probe = createServer().listen(0);
await once(probe, "listening");
const { port } = probe.address() as AddressInfo;
await new Promise((resolve) => probe.close(resolve));
const facilitatorServer = await main(
  {
    FACILITATOR_SECRET: facilitator.secret(),
    CHANNELS: channelKeys.map((keypair) => keypair.publicKey()).join(","),
    PORT: String(port),
    LOG_LEVEL: "warn",
    RPC_URLS: process.env.RPC_URLS,
  },
  { write },
);

const requirements: PaymentRequirements = {
  scheme: "exact",
  network,
  asset: process.env.ASSET ?? XLM_SAC_TESTNET,
  amount: process.env.AMOUNT ?? "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
const payer = new ExactStellarScheme(createEd25519Signer(client.secret(), network));
const pay = async () => ({
  ...(await payer.createPaymentPayload(2, requirements)),
  accepted: requirements,
});
const post = async <T>(
  route: string,
  paymentPayload: unknown,
  paymentRequirements = requirements,
) => {
  const response = await fetch(`http://127.0.0.1:${port}/${route}`, {
    dispatcher: http,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  if (response.status !== 200) throw new Error(`/${route} answered ${response.status}`);
  return (await response.json()) as T;
};

try {
  const first = await pay();
  const settled = await post<SettleResponse>("settle", first);
  const failedOver = events.some(
    // Logs name an entry `RPC_URLS[i]#<fingerprint>` (0009 decision 47).
    (e) =>
      e.event === "rpc_failover" &&
      e.from?.startsWith("RPC_URLS[0]#") &&
      e.to?.startsWith("RPC_URLS[1]#"),
  );
  const onChain = settled.success
    ? (await server.pollTransaction(settled.transaction, { attempts: 30 })).status
    : undefined;
  const repeat = await post<SettleResponse>("settle", first);
  const other = { ...requirements, extra: { ...requirements.extra, merchant: "another" } };
  const reused = await post<SettleResponse>("settle", { ...first, accepted: other }, other);
  const second = await pay();
  const concurrent = await Promise.all([
    post<SettleResponse>("settle", second),
    post<SettleResponse>("settle", second),
  ]);
  const verifySettled = await post<VerifyResponse>("verify", first);

  const checks = {
    settled: settled.success && settled.payer === client.publicKey() && onChain === "SUCCESS",
    repeatAlreadySettled:
      !repeat.success &&
      repeat.errorReason === "settle_exact_stellar_already_settled" &&
      repeat.transaction === settled.transaction,
    nonceReuseRefused:
      !reused.success &&
      reused.errorReason === "settle_exact_stellar_nonce_already_used" &&
      reused.transaction === settled.transaction,
    concurrentOneTransaction:
      concurrent.filter((answer) => answer.success).length === 1 &&
      concurrent.some((answer) => answer.errorReason === "settle_exact_stellar_already_settled") &&
      concurrent[0]!.transaction === concurrent[1]!.transaction &&
      concurrent[0]!.transaction !== settled.transaction,
    settledPaymentNoLongerVerifies: !verifySettled.isValid,
    ...(process.env.EXPECT_FAILOVER === "1" && { failedOver }),
  };
  console.log(
    JSON.stringify(
      {
        facilitator: facilitator.publicKey(),
        payer: client.publicKey(),
        payTo,
        settled,
        onChain,
        repeat,
        reused,
        concurrent,
        verifySettled,
        failedOver,
        checks,
      },
      null,
      2,
    ),
  );
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  await facilitatorServer.close();
}
