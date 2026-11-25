/**
 * Testnet run of 0107's balance-missing refusal (decision 6): a payment that would create `payTo`'s
 * balance of a SAC token costs more than the facilitator pays, `/verify` says so with a reason of
 * its own and the fix, and the fix works. A facilitator built by `main()` with
 * `MAX_FEE_STROOPS=100000`, since a new contract balance of XLM costs about 128,000 stroops on
 * testnet (128,027 in the run of 2026-11-24), under the default ceiling; real `exact` payments in
 * XLM, signed with upstream's client; and a fresh contract as `payTo`.
 *
 * 1. A payment to the contract, which holds no XLM yet: `/verify` refuses it with
 *    `invalid_exact_stellar_pay_to_balance_missing`, and `/settle` answers the same.
 * 2. The seller sends the contract a first amount of XLM from its own account, in one transfer.
 *    The contract's balance entry exists after it, under the key the facilitator reads, which is
 *    also in that transfer's footprint.
 * 3. The payer's next payment verifies and settles. The first one stays refused: its record
 *    answers it (0086), so the buyer pays again with a new one, as the message says.
 *
 * Env: DATABASE_URL, a migrated PostgreSQL (`pnpm migrate`), required. Every account is a fresh
 * friendbot-funded one, printed by address only. `payTo` is the SAC of an asset the seller makes
 * up, used only as a contract address.
 *
 *   cd apps/facilitator && npx tsx test/live/pay-to-balance-missing.ts
 *
 * The results, with every hash and fee, go to
 * `test/live/results/pay-to-balance-missing-testnet.json`. Testnet only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { buildCreateChannelsTx, readAccountEntry } from "@stellar-x402/signer-pool";
import type { PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { Agent, fetch } from "undici";
import { main } from "../../src/main.js";
import { PAY_TO_BALANCE_MISSING, sacBalanceKey } from "../../src/settlement/verify.js";
import { fakeOpenBao, signerEnv } from "../fake-openbao.js";

const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RPC_URL = "https://soroban-testnet.stellar.org";
const network = "stellar:testnet";
const MAX_FEE_STROOPS = 100_000;
/** The seller's first amount to `payTo`: 1 XLM. */
const FIRST_AMOUNT = 10_000_000n;
const server = new rpc.Server(RPC_URL);
const http = new Agent({ headersTimeout: 120_000 });
const log = (message: string) => process.stderr.write(`[0107] ${message}\n`);
const write = (line: string) => process.stderr.write(line);

async function funded(): Promise<Keypair> {
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`, {
    dispatcher: http,
  });
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

/** `operation` from `source`'s own account, prepared, signed, sent and waited for. */
async function submit(source: Keypair, operation: xdr.Operation) {
  const built = new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: "1000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(source);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error(`send ${sent.status} ${sent.hash}`);
  const landed = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (landed.status !== "SUCCESS") throw new Error(`${sent.hash} ${landed.status}`);
  return {
    hash: sent.hash,
    feeCharged: landed.resultXdr.feeCharged().toString(),
    footprint: prepared
      .toEnvelope()
      .v1()
      .tx()
      .ext()
      .sorobanData()
      .resources()
      .footprint()
      .readWrite()
      .map((key) => key.toXDR("base64")),
  };
}

const facilitator = await funded();
const client = await funded();
const seller = await funded();

// `payTo`: a contract of the seller's that holds no XLM yet.
const own = new Asset("PAYTO", seller.publicKey());
const deployed = await submit(seller, Operation.createStellarAssetContract({ asset: own }));
const payTo = own.contractId(Networks.TESTNET);
log(`payTo ${payTo}, deployed in ${deployed.hash}`);

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
    MAX_FEE_STROOPS: String(MAX_FEE_STROOPS),
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

const balanceKey = sacBalanceKey(XLM_SAC_TESTNET, payTo);
/** Whether `payTo`'s balance entry is on the ledger, read by the facilitator's key. */
const hasBalance = async () => (await server.getLedgerEntries(balanceKey)).entries.length > 0;

/**
 * A payment's fees: the resource fee the buyer's client put in it from its own simulation, and
 * the minimum resource fee a simulation of it gives now.
 */
async function feesOf(payment: Awaited<ReturnType<typeof pay>>) {
  const transaction = (payment.payload as { transaction: string }).transaction;
  const data = xdr.TransactionEnvelope.fromXDR(transaction, "base64").v1().tx().ext().sorobanData();
  const simulated = await server.simulateTransaction(
    new Transaction(transaction, Networks.TESTNET),
  );
  return {
    clientResourceFee: data.resourceFee().toString(),
    archivedEntries:
      data.ext().switch() === 1
        ? (data.ext().value() as xdr.SorobanResourcesExtV0).archivedSorobanEntries().length
        : 0,
    minResourceFee: rpc.Api.isSimulationSuccess(simulated) ? simulated.minResourceFee : undefined,
  };
}

try {
  const balanceBefore = await hasBalance();

  log("1: a payment to payTo, which holds no XLM yet");
  const first = await pay();
  const firstFees = await feesOf(first);
  const verified = await post<VerifyResponse>("verify", first);
  const settled = await post<SettleResponse>("settle", first);

  log("2: the seller's first amount to payTo, from its own account");
  const transfer = await submit(
    seller,
    Operation.invokeContractFunction({
      contract: XLM_SAC_TESTNET,
      function: "transfer",
      args: [
        nativeToScVal(seller.publicKey(), { type: "address" }),
        nativeToScVal(payTo, { type: "address" }),
        nativeToScVal(FIRST_AMOUNT, { type: "i128" }),
      ],
    }),
  );
  const balanceAfter = await hasBalance();

  log("3: the payer's next payment");
  const second = await pay();
  const secondFees = await feesOf(second);
  const verifiedNext = await post<VerifyResponse>("verify", second);
  const settledNext = await post<SettleResponse>("settle", second);
  const landed = settledNext.success
    ? await server.pollTransaction(settledNext.transaction, { attempts: 40 })
    : undefined;
  const firstAgain = await post<VerifyResponse>("verify", first);

  const checks = {
    noBalanceBefore: !balanceBefore,
    firstVerifyRefused: !verified.isValid && verified.invalidReason === PAY_TO_BALANCE_MISSING,
    firstSettleRefused: !settled.success && settled.errorReason === PAY_TO_BALANCE_MISSING,
    firstListsNoArchivedEntry: firstFees.archivedEntries === 0,
    balanceKeyInTransferFootprint: transfer.footprint.includes(balanceKey.toXDR("base64")),
    balanceAfterTransfer: balanceAfter,
    nextVerified: verifiedNext.isValid,
    nextSettled: settledNext.success && landed?.status === "SUCCESS",
    firstStillRefused: !firstAgain.isValid && firstAgain.invalidReason === PAY_TO_BALANCE_MISSING,
  };
  const results = {
    network,
    ranAt: new Date().toISOString(),
    maxFeeStroops: MAX_FEE_STROOPS,
    facilitator: facilitator.publicKey(),
    payer: client.publicKey(),
    seller: seller.publicKey(),
    payTo,
    payToDeployed: deployed.hash,
    balanceKey: balanceKey.toXDR("base64"),
    first: { fees: firstFees, verified, settled, verifiedAgain: firstAgain },
    transfer: {
      hash: transfer.hash,
      amount: FIRST_AMOUNT.toString(),
      feeCharged: transfer.feeCharged,
    },
    next: {
      fees: secondFees,
      verified: verifiedNext,
      settled: settledNext,
      onChain: landed?.status,
      feeCharged:
        landed?.status === "SUCCESS" ? landed.resultXdr.feeCharged().toString() : undefined,
    },
    checks,
  };
  const out = new URL("./results/pay-to-balance-missing-testnet.json", import.meta.url);
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  await facilitatorServer.close();
  openbao.close();
}
