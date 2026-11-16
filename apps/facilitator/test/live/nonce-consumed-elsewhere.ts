/**
 * Testnet run of 0141: what a seller sees from our `/verify` and `/settle` when another
 * transaction uses the payer's signed auth entry first. A facilitator built by `main()` settles
 * real `exact` payments, signed with upstream's client; a front-runner sends the same auth entry
 * in a transaction of its own.
 *
 * 1. before: the front-run lands before `/verify` and `/settle` run. Both refuse with
 *    `invalid_exact_stellar_payload_nonce_consumed_elsewhere`; the counter's window is `verify`.
 * 2. on chain: the front-run lands right after the pool's simulation and before our send, so our
 *    transaction fails on chain with `Error(Auth, ExistingValue)`. `/settle` answers
 *    `settle_exact_stellar_nonce_consumed_elsewhere`, with no advice to sign again; the record's
 *    log line carries the fee; the counter's window is `settle`.
 * 3. on chain, no events: as 2, but `getTransaction` drops our transaction's diagnostic events
 *    and its meta, as an RPC without events answers. The record's failure names no error, and
 *    the nonce entry tells (0141 decision 5).
 *
 * How 2 and 3 race: the script wraps the SDK's `sendTransaction`. Armed with the front-run, the
 * next send (the pool's) first sends the front-run and waits for it to land, then sends ours,
 * which the pool simulated before. A real front-runner copies the entry from the flooded
 * transaction instead; the chain sees the same two transactions.
 *
 * Env: DATABASE_URL, a migrated PostgreSQL (`pnpm migrate`), required. Every account is a fresh
 * friendbot-funded one.
 *
 *   cd apps/facilitator && npx tsx test/live/nonce-consumed-elsewhere.ts
 *
 * The results, with every hash, go to `test/live/results/nonce-consumed-elsewhere-testnet.json`.
 * Testnet only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { buildCreateChannelsTx, readAccountEntry } from "@stellar-x402/signer-pool";
import type { PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { Agent, fetch } from "undici";
import { main } from "../../src/main.js";
import { fakeOpenBao, signerEnv } from "../fake-openbao.js";

const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RPC_URL = "https://soroban-testnet.stellar.org";
const network = "stellar:testnet";
const server = new rpc.Server(RPC_URL);
const http = new Agent({ headersTimeout: 120_000 });
const log = (message: string) => process.stderr.write(`[0141] ${message}\n`);

const lines: Record<string, unknown>[] = [];
const write = (line: string) => {
  lines.push(JSON.parse(line) as Record<string, unknown>);
  process.stderr.write(line);
};

async function funded(): Promise<Keypair> {
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`, {
    dispatcher: http,
  });
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

// The race seam: the pool's next send first lands the armed front-run. Hashes in `stripped` lose
// their diagnostic events in `getTransaction`, as from an RPC that doesn't keep them.
const send = rpc.Server.prototype.sendTransaction;
const get = rpc.Server.prototype.getTransaction;
let armed: Transaction | undefined;
const stripped = new Set<string>();
let ours: { hash: string; strip: boolean } | undefined;
let stripNext = false;
rpc.Server.prototype.sendTransaction = async function (this: rpc.Server, tx) {
  const frontRun = armed;
  if (frontRun) {
    armed = undefined;
    const sent = await send.call(this, frontRun);
    const landed = await server.pollTransaction(sent.hash, { attempts: 40 });
    log(`front-run ${landed.status} ${sent.hash}, now ours`);
    const hash = tx.hash().toString("hex");
    if (stripNext) stripped.add(hash);
    ours = { hash, strip: stripNext };
  }
  return send.call(this, tx);
};
rpc.Server.prototype.getTransaction = async function (this: rpc.Server, hash: string) {
  const res = await get.call(this, hash);
  if (!stripped.has(hash)) return res;
  // `failureCause` falls back to the events in the meta; a core that emits none has none there.
  return {
    ...res,
    diagnosticEventsXdr: undefined,
    resultMetaXdr: undefined,
  } as unknown as typeof res;
};

const facilitator = await funded();
const client = await funded();
const payTo = (await funded()).publicKey();
const frontRunner = await funded();

const channelKeys = [Keypair.random(), Keypair.random()];
const facilitatorEntry = await readAccountEntry(server, facilitator.publicKey());
if (!facilitatorEntry) throw new Error("the facilitator account does not exist");
const setup = buildCreateChannelsTx({
  funder: new Account(facilitator.publicKey(), facilitatorEntry.seqNum().toString()),
  signer: facilitator.publicKey(),
  channels: channelKeys,
  networkPassphrase: Networks.TESTNET,
  fee: 1000,
});
setup.sign(facilitator, ...channelKeys);
const created = await server.pollTransaction((await server.sendTransaction(setup)).hash, {
  attempts: 30,
});
if (created.status !== "SUCCESS") throw new Error(`channel setup ${created.status}`);

const openbao = await fakeOpenBao(facilitator);
const facilitatorServer = await main(
  {
    ...signerEnv(facilitator.publicKey(), openbao.socketPath),
    CLIENT_IP: "socket",
    CHANNELS: channelKeys.map((keypair) => keypair.publicKey()).join(","),
    PORT: "0",
    LOG_LEVEL: "warn",
    DATABASE_URL: process.env.DATABASE_URL,
  },
  { write },
);

const requirements: PaymentRequirements = {
  scheme: "exact",
  network,
  asset: XLM_SAC_TESTNET,
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
const payer = new ExactStellarScheme(createEd25519Signer(client.secret(), network));
const pay = async () => ({
  ...(await payer.createPaymentPayload(2, requirements)),
  accepted: requirements,
});
const post = async <T>(route: string, paymentPayload: unknown) => {
  const response = await fetch(`http://127.0.0.1:${facilitatorServer.port}/${route}`, {
    dispatcher: http,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements }),
  });
  if (response.status !== 200) throw new Error(`/${route} answered ${response.status}`);
  return (await response.json()) as T;
};

/** The front-runner's transaction: the payment's operation and its signed auth entry, its source. */
async function frontRunOf(payload: Awaited<ReturnType<typeof pay>>) {
  const inner = TransactionBuilder.fromXDR(
    (payload.payload as { transaction: string }).transaction,
    Networks.TESTNET,
  ) as Transaction;
  const op = inner.operations[0] as Operation.InvokeHostFunction;
  const built = new TransactionBuilder(await server.getAccount(frontRunner.publicKey()), {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth: op.auth ?? [] }))
    .setTimeout(120)
    .build();
  const tx = await server.prepareTransaction(built);
  tx.sign(frontRunner);
  return tx;
}

const logged = (event: string) => lines.filter((line) => line.event === event);
const advice = (answer: { errorMessage?: string }) =>
  /sign a new payment/.test(answer.errorMessage ?? "");

try {
  // 1: the front-run lands first.
  log("case before");
  const before = await pay();
  const beforeRun = await frontRunOf(before);
  const beforeSent = await server.sendTransaction(beforeRun);
  const beforeLanded = await server.pollTransaction(beforeSent.hash, { attempts: 40 });
  const verified = await post<VerifyResponse>("verify", before);
  const refused = await post<SettleResponse>("settle", before);

  // 2 and 3: the front-run lands between the pool's simulation and our send.
  const onChain = async (strip: boolean) => {
    log(`case on chain${strip ? ", no events" : ""}`);
    const payment = await pay();
    armed = await frontRunOf(payment);
    stripNext = strip;
    const answer = await post<SettleResponse>("settle", payment);
    const repeat = await post<SettleResponse>("settle", payment);
    const seen = ours;
    ours = undefined;
    const res = seen && (await server.getTransaction(seen.hash));
    return {
      frontRun: armed === undefined ? "landed first" : "not sent",
      ours: seen?.hash,
      oursOnChain: res?.status,
      oursEventsStripped: seen?.strip ?? false,
      answer,
      repeat,
    };
  };
  const events = await onChain(false);
  const noEvents = await onChain(true);

  await facilitatorServer.close();
  const counted = lines.filter((line) => "settlement_nonce_consumed_elsewhere_total" in line);
  const reported = logged("settlement_nonce_consumed_elsewhere");

  const settleCode = "settle_exact_stellar_nonce_consumed_elsewhere";
  const checks = {
    beforeFrontRunLanded: beforeLanded.status === "SUCCESS",
    beforeVerifyRefused:
      !verified.isValid &&
      verified.invalidReason === "invalid_exact_stellar_payload_nonce_consumed_elsewhere",
    beforeSettleRefused:
      !refused.success &&
      refused.errorReason === "invalid_exact_stellar_payload_nonce_consumed_elsewhere" &&
      !advice(refused),
    ...Object.fromEntries(
      (
        [
          ["events", events],
          ["noEvents", noEvents],
        ] as const
      ).flatMap(([name, run]) => [
        [`${name}OursFailedOnChain`, run.oursOnChain === "FAILED"],
        [
          `${name}Answer`,
          !run.answer.success &&
            run.answer.errorReason === settleCode &&
            !advice(run.answer) &&
            !(run.answer.extra && "retryable" in run.answer.extra),
        ],
        [`${name}Repeat`, !run.repeat.success && run.repeat.errorReason === settleCode],
        [
          `${name}Logged`,
          reported.some((line) => line.transaction === run.ours && line.feeCharged !== undefined),
        ],
      ]),
    ),
    countedVerify: counted.some((line) => line.window === "verify"),
    countedSettle: counted.some((line) => line.window === "settle"),
  };
  const results = {
    network,
    ranAt: new Date().toISOString(),
    facilitator: facilitator.publicKey(),
    payer: client.publicKey(),
    payTo,
    frontRunner: frontRunner.publicKey(),
    before: {
      frontRun: { hash: beforeSent.hash, status: beforeLanded.status },
      verified,
      refused,
    },
    onChain: events,
    onChainNoEvents: noEvents,
    reported,
    counted,
    checks,
  };
  const out = new URL("./results/nonce-consumed-elsewhere-testnet.json", import.meta.url);
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(checks, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  await facilitatorServer.close();
  openbao.close();
}
