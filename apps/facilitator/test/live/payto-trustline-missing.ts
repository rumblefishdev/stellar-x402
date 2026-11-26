/**
 * Testnet run for 0094: what a seller sees when its `payTo` can't receive the asset it sells, for
 * each kind of client. The seller is `examples/http-api`'s `createApp` as it was before 0164, as
 * this package can build it: upstream's Express middleware, the same route and terms, and its one
 * log line (not its Bazaar extension, which a refusal never reaches; importing the example breaks
 * this package's `rootDir`). It runs without the example's trustline check at start
 * (`src/index.ts`): a seller on upstream's middleware alone. The facilitator is ours, built by
 * `main()` in this process. A recorder in front of the seller writes down every request it got and
 * its answer; that is this run's view, not the seller's, whose own log is the lines its code and
 * the console wrote (the facilitator logs to its own sink). Apart from that log, the run records
 * what 0164's `readVerifyRefusal` reads in the seller's `onAfterVerify` hook, which `createApp`
 * now logs.
 *
 * 1. `payTo` is a fresh account without a USDC trustline. Two clients ask to pay it:
 *    - our SDK's `createPayingFetch`, which `apps/mcp-local` pays through;
 *    - upstream's `@x402/fetch` (`wrapFetchWithPayment`).
 *    Both simulate before signing, so both should stop there, and nothing reaches `/verify`.
 * 2. A client whose payment does reach `/verify`: `payTo` is a fresh account with the trustline
 *    when two payments to it are signed (upstream's client, simulation passes); then the trustline
 *    is removed and the first payment is sent, then the account is merged away and the second is
 *    sent. Our `/verify` should refuse both with `invalid_exact_stellar_payto_trustline_missing`.
 *    The same payments are also sent to `/verify` straight, as the seller's facilitator client
 *    sends them: what a seller's `onAfterVerify` hook would get.
 *
 * Nothing is paid: every payment is refused, so no USDC moves. The XLM spent is friendbot's and
 * the fees of the trustline, merge and channel transactions.
 *
 * Env:
 *   E2E_BUYER_PUBLIC, E2E_BUYER_SECRET  the e2e run's testnet buyer: a USDC trustline and some USDC,
 *                  so its own simulation passes (the secret is never printed)
 *   DATABASE_URL   a migrated PostgreSQL (`pnpm migrate`), for `main()`
 *
 *   pnpm --filter @stellar-x402/sdk build   # the example seller imports the SDK's dist
 *   cd apps/facilitator && set -a && . ../../.env.e2e-testnet && set +a && \
 *     DATABASE_URL=postgres://... npx tsx test/live/payto-trustline-missing.ts
 *
 * The results go to `test/live/results/payto-trustline-missing-testnet.json`. Testnet only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { buildCreateChannelsTx, readAccountEntry } from "@stellar-x402/signer-pool";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { USDC_TESTNET_ADDRESS, createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createPayingFetch, PaymentError } from "@stellar-x402/sdk/buyer";
import {
  checkTrustline,
  createFacilitatorConfig,
  readCatalogAnswer,
  readVerifyRefusal,
  type VerifyRefusal,
} from "@stellar-x402/sdk/seller";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import express from "express";
import { main } from "../../src/main.js";
import { fakeOpenBao, signerEnv } from "../fake-openbao.js";

const RPC_URL = "https://soroban-testnet.stellar.org";
const network = "stellar:testnet";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const server = new rpc.Server(RPC_URL);
const log = (message: string) => process.stderr.write(`[0094] ${message}\n`);

const buyerPublic = process.env.E2E_BUYER_PUBLIC;
const buyerSecret = process.env.E2E_BUYER_SECRET;
if (!buyerPublic || !buyerSecret)
  throw new Error("E2E_BUYER_PUBLIC and E2E_BUYER_SECRET are required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required: a migrated PostgreSQL");

async function funded(): Promise<Keypair> {
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

/** A classic `operation` from `source`'s own account, signed, sent and waited for: its hash. */
async function submit(source: Keypair, operation: xdr.Operation): Promise<string> {
  const built = new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: "1000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  built.sign(source);
  const sent = await server.sendTransaction(built);
  if (sent.status !== "PENDING") throw new Error(`send ${sent.status} ${sent.hash}`);
  const landed = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (landed.status !== "SUCCESS") throw new Error(`${sent.hash} ${landed.status}`);
  return sent.hash;
}

// What the seller's process wrote: `createApp`'s log and anything upstream's middleware prints.
const sellerLog: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    sellerLog.push(`console.${level}: ${args.map(String).join(" ")}`);
    original(...args);
  };
}
// What 0164's reader read in the seller's `onAfterVerify` hook, kept apart from the seller's log.
const refusalsRead: VerifyRefusal[] = [];
// The facilitator's JSON log lines.
const facilitatorLog: Record<string, unknown>[] = [];
const write = (line: string) => {
  for (const part of line.split("\n").filter(Boolean)) {
    try {
      facilitatorLog.push(JSON.parse(part) as Record<string, unknown>);
    } catch {
      facilitatorLog.push({ raw: part });
    }
  }
};

interface Received {
  seller: string;
  method: string;
  url: string;
  paid: boolean;
  status?: number;
  /** The `error` of the 402 the seller answered, from its `PAYMENT-REQUIRED` header. */
  error?: string;
}
const received: Received[] = [];

/** The example seller paying `payTo`, behind a recorder of what reached it. */
async function startSeller(name: string, payTo: string, facilitatorUrl: string) {
  const app = express();
  app.use((req, res, next) => {
    const row: Received = {
      seller: name,
      method: req.method,
      url: req.url,
      paid: req.headers["payment-signature"] !== undefined,
    };
    received.push(row);
    res.on("finish", () => {
      row.status = res.statusCode;
      const header = res.getHeader("payment-required");
      if (typeof header === "string") row.error = decodePaymentRequiredHeader(header).error;
    });
    next();
  });
  // `examples/http-api`'s `createApp`, as it is: upstream's middleware and resource server, the
  // route's price and terms, and its only log, the catalog's answer after a settlement.
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient(createFacilitatorConfig({ url: facilitatorUrl })),
  ).register(network, new ExactStellarServer());
  resourceServer.onAfterSettle(async ({ result }) => {
    const answer = readCatalogAnswer(result);
    if (answer.status !== "none") sellerLog.push(`seller: Bazaar ${answer.status}`);
  });
  resourceServer.onAfterVerify(async ({ result }) => {
    refusalsRead.push(readVerifyRefusal(result));
  });
  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          accepts: { scheme: "exact", price: "$0.001", network, payTo },
          description: "Current temperature for a city",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );
  app.get("/weather", (req, res) => {
    res.json({ city: req.query.city, tempC: 14 });
  });
  const listening = app.listen(0);
  await new Promise((resolve) => listening.once("listening", resolve));
  const { port } = listening.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/weather?city=Warsaw`, close: () => listening.close() };
}

const describeError = (error: unknown) =>
  error instanceof PaymentError
    ? { type: "PaymentError", code: error.code, message: error.message, paid: error.paid }
    : error instanceof Error
      ? { type: error.constructor.name, message: error.message }
      : { type: typeof error, message: String(error) };

const scheme = () => new ExactStellarScheme(createEd25519Signer(buyerSecret, network));

// Our facilitator, as `pay-to-balance-missing.ts` starts it: a fresh key and one channel.
const facilitatorKey = await funded();
const channel = Keypair.random();
const entry = await readAccountEntry(server, facilitatorKey.publicKey());
if (!entry) throw new Error("the facilitator account does not exist");
const setup = buildCreateChannelsTx({
  funder: new Account(facilitatorKey.publicKey(), entry.seqNum().toString()),
  signer: facilitatorKey.publicKey(),
  channels: [channel],
  networkPassphrase: Networks.TESTNET,
  fee: 1000,
});
setup.sign(facilitatorKey, channel);
const channelSetup = (await server.sendTransaction(setup)).hash;
const created = await server.pollTransaction(channelSetup, { attempts: 30 });
if (created.status !== "SUCCESS") throw new Error(`channel setup ${created.status}`);
const openbao = await fakeOpenBao(facilitatorKey);
const facilitator = await main(
  {
    ...signerEnv(facilitatorKey.publicKey(), openbao.socketPath),
    CLIENT_IP: "socket",
    CHANNELS: channel.publicKey(),
    PORT: "0",
    LOG_LEVEL: "info",
    DATABASE_URL: process.env.DATABASE_URL,
  },
  { write },
);
const facilitatorUrl = `http://127.0.0.1:${facilitator.port}`;
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const closers: (() => void)[] = [];
try {
  // 1. A payTo that never had the trustline.
  const neverTrusted = await funded();
  const sellerA = await startSeller("A", neverTrusted.publicKey(), facilitatorUrl);
  closers.push(sellerA.close);
  const checkA = await checkTrustline({
    account: neverTrusted.publicKey(),
    asset: USDC_TESTNET_ADDRESS,
    network,
  });

  log("1a: our SDK's paying fetch, as MCP pays");
  let sdk: unknown;
  try {
    const response = await createPayingFetch({
      schemes: [{ network, client: scheme() }],
      payer: buyerPublic,
      assets: { [USDC_TESTNET_ADDRESS]: { maxPerCall: 10_000n } },
    })(sellerA.url);
    sdk = { status: response.status, payment: response.payment };
  } catch (error) {
    sdk = describeError(error);
  }

  log("1b: upstream's @x402/fetch");
  let upstreamFetch: unknown;
  try {
    const response = await wrapFetchWithPayment(
      fetch,
      new x402Client().register(network, scheme()),
    )(sellerA.url);
    upstreamFetch = { status: response.status };
  } catch (error) {
    upstreamFetch = describeError(error);
  }

  // 2. A payTo that loses the trustline after the payments were signed.
  const losing = await funded();
  const trustlineOpened = await submit(losing, Operation.changeTrust({ asset: USDC }));
  const sellerB = await startSeller("B", losing.publicKey(), facilitatorUrl);
  closers.push(sellerB.close);
  const checkBBefore = await checkTrustline({
    account: losing.publicKey(),
    asset: USDC_TESTNET_ADDRESS,
    network,
  });

  log("2: signing two payments while payTo holds the trustline");
  const client = new x402Client().register(network, scheme());
  const http = new x402HTTPClient(client);
  const unpaid = await fetch(sellerB.url);
  const paymentRequired: PaymentRequired = http.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    await unpaid.json().catch(() => undefined),
  );
  const first = await client.createPaymentPayload(paymentRequired);
  const second = await client.createPaymentPayload(paymentRequired);

  const send = async (payment: PaymentPayload) => {
    const response = await fetch(sellerB.url, {
      headers: http.encodePaymentSignatureHeader(payment),
    });
    const header = response.headers.get("payment-required");
    return {
      status: response.status,
      error: header ? decodePaymentRequiredHeader(header).error : undefined,
      paymentResponse: response.headers.get("payment-response") ?? undefined,
      body: await response.text(),
    };
  };

  log("2a: the trustline removed, the first payment sent");
  const trustlineRemoved = await submit(losing, Operation.changeTrust({ asset: USDC, limit: "0" }));
  const checkBNoTrustline = await checkTrustline({
    account: losing.publicKey(),
    asset: USDC_TESTNET_ADDRESS,
    network,
  });
  const firstAtSeller = await send(first);
  const firstAtVerify = await facilitatorClient.verify(first, first.accepted);

  log("2b: the account merged away, the second payment sent");
  const merged = await submit(
    losing,
    Operation.accountMerge({ destination: neverTrusted.publicKey() }),
  );
  const checkBGone = await checkTrustline({
    account: losing.publicKey(),
    asset: USDC_TESTNET_ADDRESS,
    network,
  });
  const secondAtSeller = await send(second);
  const secondAtVerify = await facilitatorClient.verify(second, second.accepted);

  const verified = facilitatorLog.filter((line) => line.event === "verified");
  const checks = {
    sdkStoppedBeforeSigning:
      (sdk as { code?: string }).code === "payto_trustline_missing" &&
      (sdk as { paid?: string }).paid === "none",
    upstreamFetchStoppedBeforeSigning: /trustline is missing for account/.test(
      (upstreamFetch as { message?: string }).message ?? "",
    ),
    sellerAGotNoPayment: received.filter((r) => r.seller === "A").every((r) => !r.paid),
    firstRefusedAtSeller:
      firstAtSeller.status === 402 &&
      firstAtSeller.error === "invalid_exact_stellar_payto_trustline_missing",
    secondRefusedAtSeller:
      secondAtSeller.status === 402 &&
      secondAtSeller.error === "invalid_exact_stellar_payto_trustline_missing",
    verifyNamesAccount:
      firstAtVerify.invalidMessage?.includes(losing.publicKey()) === true &&
      secondAtVerify.invalidMessage?.includes(losing.publicKey()) === true,
    readerMarksSellerFix:
      refusalsRead.length === 2 &&
      refusalsRead.every(
        (read) =>
          read.status === "refused" &&
          read.sellerMustAct &&
          read.reason === "invalid_exact_stellar_payto_trustline_missing" &&
          read.message?.includes(losing.publicKey()) === true,
      ),
    facilitatorLoggedMessage: verified.some(
      (line) =>
        line.invalidReason === "invalid_exact_stellar_payto_trustline_missing" &&
        typeof line.message === "string",
    ),
  };
  const results = {
    network,
    ranAt: new Date().toISOString(),
    facilitator: facilitatorKey.publicKey(),
    channelSetup,
    buyer: buyerPublic,
    neverTrusted: {
      payTo: neverTrusted.publicKey(),
      checkTrustline: checkA,
      clients: { sdkPayingFetch: sdk, upstreamFetch },
    },
    losesTrustline: {
      payTo: losing.publicKey(),
      trustlineOpened,
      checkTrustlineWhileSigning: checkBBefore,
      trustlineRemoved,
      checkTrustlineAfterRemoval: checkBNoTrustline,
      first: { atSeller: firstAtSeller, atVerify: firstAtVerify },
      merged,
      mergedInto: neverTrusted.publicKey(),
      checkTrustlineAfterMerge: checkBGone,
      second: { atSeller: secondAtSeller, atVerify: secondAtVerify },
    },
    sellerReceived: received,
    sellerLog,
    refusalsRead,
    facilitatorVerified: verified,
    checks,
  };
  const out = new URL("./results/payto-trustline-missing-testnet.json", import.meta.url);
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  for (const close of closers) close();
  await facilitator.close();
  openbao.close();
}
