/**
 * Testnet token matrix (0021): one `exact` payment in each kind of SEP-41 token, verified and
 * settled through a facilitator built by `main()`, then a concurrent batch across its channels.
 *
 * 1. Testnet USDC, a self-issued SAC (`UPTOE2E`) and the non-SAC test token each verify
 *    and settle through the same code: only `asset` changes in the requirements.
 * 2. The buyer's XLM balance and sequence number are the same before and after: the facilitator
 *    pays every fee, and the buyer sources no transaction.
 * 3. A batch of concurrent payments settles, and one ledger holds settlements from more than one
 *    channel.
 *
 * Env:
 *   CLIENT_SECRET    the buyer: 0004's e2e client (`client` in
 *                    `contracts/upto-proxy/e2e/secrets/accounts.json`), which holds testnet USDC;
 *                    USDC only comes from Circle's faucet
 *   ISSUER_SECRET    optional, `UPTOE2E`'s issuer (the same file, `issuer`), to top the buyer up
 *   TEST_TOKEN       optional, another deployment of `contracts/test-token` (deploy-contract.sh)
 *   AMOUNT           base units per payment (default 1000)
 *   BATCH            payments in the concurrent batch (default 6)
 *   RPC_URLS         passed to the facilitator (default: the testnet RPC)
 *
 *   cd apps/facilitator
 *   CLIENT_SECRET=S… npx tsx scripts/token-matrix.ts
 *
 * The facilitator, its 4 channels and the seller are new each run. The results, with every hash,
 * go to `scripts/results/token-matrix-testnet.json`; log lines go to stderr.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  Account,
  Address,
  Asset,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { buildCreateChannelsTx, readAccountEntry } from "@stellar-x402/signer-pool";
import type { PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { Agent, fetch } from "undici";
import { main } from "../src/main.js";

const network = "stellar:testnet";
const server = new rpc.Server("https://soroban-testnet.stellar.org");
/** Circle's testnet USDC. */
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
/** 0004's self-issued asset; its SAC is deployed. */
const OWN = new Asset("UPTOE2E", "GD36A3UITJRQD7NTYM43GB6YDGAZOO4XF2FXSSN2C5XWJQVCIRJWNARZ");
/**
 * The non-SAC SEP-41 test token (`contracts/test-token`), whose `mint` takes no auth: okarcz's
 * `deploy/scripts/deploy-contract.sh test-token`, the first with SEP-41 events. WASM SHA-256
 * `d3108f813b0d5f0cb6c400626d7f4d0cf02bacd267afa8b6f9ba7b7f7aa83d31`.
 */
const TEST_TOKEN =
  process.env.TEST_TOKEN ?? "CBFIYRHJG4C4E4AU3K5XCCMSZKZR3IMVFPCKNAJ3OBRQCHDLPCT3GV53";
const CHANNELS = 4;
const AMOUNT = BigInt(process.env.AMOUNT ?? "1000");
const BATCH = Number(process.env.BATCH ?? "6");

const tokens = [
  { kind: "usdc", contract: USDC.contractId(Networks.TESTNET) },
  { kind: "sac", contract: OWN.contractId(Networks.TESTNET) },
  { kind: "sep41", contract: TEST_TOKEN },
] as const;

/** The script's own HTTP client: `main()`'s global one gives up after 10 s without headers. */
const http = new Agent({ headersTimeout: 120_000 });

async function friendbot(): Promise<Keypair> {
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`, {
    dispatcher: http,
  });
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

async function submit(source: Keypair, operations: xdr.Operation[], soroban = false) {
  const builder = new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(60);
  for (const operation of operations) builder.addOperation(operation);
  const tx = soroban ? await server.prepareTransaction(builder.build()) : builder.build();
  tx.sign(source);
  await sendAndPoll(tx, "setup transaction");
}

/** Sends `tx` and waits for it, with the send's own error when the network refuses it. */
async function sendAndPoll(tx: Parameters<typeof server.sendTransaction>[0], what: string) {
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") {
    const reason = sent.errorResult?.result().switch().name ?? "no error result";
    throw new Error(`${what}: send ${sent.status} (${reason})`);
  }
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== "SUCCESS") throw new Error(`${what}: ${done.status}`);
}

async function tokenBalance(token: string, holder: string, source: string): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(token).call("balance", Address.fromString(holder).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`balance on ${token}`);
  return BigInt(scValToNative(sim.result.retval) as bigint);
}

/** XLM and sequence number: an unchanged sequence shows the buyer sourced no transaction. */
async function xlmAndSequence(address: string): Promise<{ xlm: string; sequence: string }> {
  const entry = await readAccountEntry(server, address);
  if (!entry) throw new Error(`${address} does not exist`);
  return { xlm: entry.balance().toString(), sequence: entry.seqNum().toString() };
}

/** Where a settlement landed and who paid for it, read back from the chain. */
async function onChain(hash: string) {
  const tx = await server.pollTransaction(hash, { attempts: 30 });
  if (tx.status !== "SUCCESS") return { hash, status: tx.status };
  const envelope = TransactionBuilder.fromXDR(tx.envelopeXdr.toXDR("base64"), Networks.TESTNET);
  const [channel, feePayer] =
    envelope instanceof FeeBumpTransaction
      ? [envelope.innerTransaction.source, envelope.feeSource]
      : [envelope.source, envelope.source];
  return {
    hash,
    status: tx.status,
    ledger: tx.ledger,
    channel,
    feePayer,
    feeCharged: tx.resultXdr.feeCharged().toString(),
  };
}

const clientSecret = process.env.CLIENT_SECRET;
if (!clientSecret) throw new Error("CLIENT_SECRET: the buyer that holds testnet USDC (see header)");
const client = Keypair.fromSecret(clientSecret);
const [facilitator, seller] = [await friendbot(), await friendbot()];
const source = facilitator.publicKey();

// The buyer's balances: USDC is checked, the two others are topped up when low.
const usdcHeld = await tokenBalance(tokens[0].contract, client.publicKey(), source);
const needed = AMOUNT * BigInt(1 + BATCH);
if (usdcHeld < AMOUNT) {
  throw new Error(
    `the buyer holds ${usdcHeld} USDC base units: send testnet USDC to ${client.publicKey()} ` +
      `from https://faucet.circle.com (Stellar testnet), then rerun`,
  );
}
if ((await tokenBalance(tokens[1].contract, client.publicKey(), source)) < AMOUNT) {
  if (!process.env.ISSUER_SECRET) throw new Error("the buyer is out of UPTOE2E: set ISSUER_SECRET");
  const issuer = Keypair.fromSecret(process.env.ISSUER_SECRET);
  await submit(issuer, [
    Operation.payment({ destination: client.publicKey(), asset: OWN, amount: "100" }),
  ]);
}
if ((await tokenBalance(TEST_TOKEN, client.publicKey(), source)) < needed) {
  // The facilitator pays for the mint, so the buyer's XLM stays untouched.
  await submit(
    facilitator,
    [
      Operation.invokeContractFunction({
        contract: TEST_TOKEN,
        function: "mint",
        args: [
          Address.fromString(client.publicKey()).toScVal(),
          nativeToScVal(1_000_000_000n, { type: "i128" }),
        ],
      }),
    ],
    true,
  );
}
// The seller holds the classic assets through trustlines.
await submit(seller, [
  Operation.changeTrust({ asset: USDC }),
  Operation.changeTrust({ asset: OWN }),
]);

/**
 * Restores what the buyer's transfer would restore, paid by the facilitator account, and says how
 * many entries. Since Protocol 23 a transaction restores the archived entries it touches and pays
 * their rent: 0004's `UPTOE2E` instance and the buyer's old test-token balance, archived since
 * its runs, put the buyer's transaction above `MAX_FEE_STROOPS`, and the facilitator refused it.
 */
async function restoreArchived(token: string): Promise<number> {
  const transfer = new TransactionBuilder(new Account(client.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(token).call(
        "transfer",
        Address.fromString(client.publicKey()).toScVal(),
        Address.fromString(seller.publicKey()).toScVal(),
        nativeToScVal(AMOUNT, { type: "i128" }),
      ),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(transfer);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`transfer on ${token}: ${sim.error}`);
  const data = sim.transactionData.build();
  const ext = data.ext();
  const archived: number[] =
    ext.switch() === 1 ? (ext.value() as xdr.SorobanResourcesExtV0).archivedSorobanEntries() : [];
  if (archived.length === 0) return 0;
  const readWrite = data.resources().footprint().readWrite();
  const restore = new TransactionBuilder(await server.getAccount(source), {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.restoreFootprint({}))
    .setSorobanData(
      new SorobanDataBuilder().setReadWrite(archived.map((i) => readWrite[i]!)).build(),
    )
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(restore);
  prepared.sign(facilitator);
  await sendAndPoll(prepared, `restore on ${token}`);
  return archived.length;
}
// One at a time: every restore comes from the facilitator account's sequence.
const restored: Record<string, number> = {};
for (const token of tokens) restored[token.kind] = await restoreArchived(token.contract);

// Delegated channels: master key off, the facilitator their only signer.
const channelKeys = Array.from({ length: CHANNELS }, () => Keypair.random());
const facilitatorEntry = await readAccountEntry(server, source);
if (!facilitatorEntry) throw new Error("the facilitator account does not exist");
const setup = buildCreateChannelsTx({
  facilitator: new Account(source, facilitatorEntry.seqNum().toString()),
  channels: channelKeys,
  networkPassphrase: Networks.TESTNET,
  fee: 1000,
});
setup.sign(facilitator, ...channelKeys);
await sendAndPoll(setup, "channel setup");

const facilitatorServer = await main(
  {
    FACILITATOR_SECRET: facilitator.secret(),
    CHANNELS: channelKeys.map((keypair) => keypair.publicKey()).join(","),
    PORT: "0",
    LOG_LEVEL: "warn",
    RPC_URLS: process.env.RPC_URLS,
  },
  { write: (line) => process.stderr.write(line) },
);

const payer = new ExactStellarScheme(createEd25519Signer(client.secret(), network));
const requirementsFor = (asset: string): PaymentRequirements => ({
  scheme: "exact",
  network,
  asset,
  amount: AMOUNT.toString(),
  payTo: seller.publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
});
const post = async <T>(route: string, requirements: PaymentRequirements, payload: unknown) => {
  const response = await fetch(`http://127.0.0.1:${facilitatorServer.port}/${route}`, {
    dispatcher: http,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    }),
  });
  if (response.status !== 200) throw new Error(`/${route} answered ${response.status}`);
  return (await response.json()) as T;
};
/** One payment: the same steps for every token. */
async function pay(asset: string) {
  const requirements = requirementsFor(asset);
  const payload = {
    ...(await payer.createPaymentPayload(2, requirements)),
    accepted: requirements,
  };
  const verified = await post<VerifyResponse>("verify", requirements, payload);
  const settled = await post<SettleResponse>("settle", requirements, payload);
  return { verified, settled, chain: settled.success ? await onChain(settled.transaction) : null };
}

try {
  const buyerBefore = await xlmAndSequence(client.publicKey());
  const matrix = [];
  for (const token of tokens) {
    const sellerBefore = await tokenBalance(token.contract, seller.publicKey(), source);
    const { verified, settled, chain } = await pay(token.contract);
    const sellerAfter = await tokenBalance(token.contract, seller.publicKey(), source);
    matrix.push({
      ...token,
      verified,
      settled,
      chain,
      sellerReceived: `${sellerAfter - sellerBefore}`,
    });
  }
  const batch = await Promise.all(Array.from({ length: BATCH }, () => pay(TEST_TOKEN)));
  const buyerAfter = await xlmAndSequence(client.publicKey());

  const landed = batch.map((payment) => payment.chain).filter((tx) => tx?.status === "SUCCESS");
  // The channels each ledger's batch settlements came through.
  const perLedger = new Map<number, Set<string>>();
  for (const tx of landed)
    perLedger.set(tx.ledger!, (perLedger.get(tx.ledger!) ?? new Set()).add(tx.channel!));
  const checks = {
    everyTokenSettled: matrix.every(
      (row) =>
        row.verified.isValid &&
        row.settled.success &&
        row.chain?.status === "SUCCESS" &&
        row.sellerReceived === AMOUNT.toString(),
    ),
    facilitatorPaidEveryFee: [...matrix.map((row) => row.chain), ...landed].every(
      (tx) => tx?.feePayer === source,
    ),
    buyerPaidNoXlm: buyerAfter.xlm === buyerBefore.xlm,
    buyerSourcedNothing: buyerAfter.sequence === buyerBefore.sequence,
    batchSettled: landed.length === BATCH,
    batchUsedSeveralChannels: new Set(landed.map((tx) => tx.channel)).size > 1,
    batchSharedALedgerAcrossChannels: [...perLedger.values()].some((channels) => channels.size > 1),
  };
  const results = {
    ranAt: new Date().toISOString(),
    network,
    facilitator: source,
    channels: channelKeys.map((keypair) => keypair.publicKey()),
    buyer: client.publicKey(),
    seller: seller.publicKey(),
    amount: AMOUNT.toString(),
    buyerAccount: { before: buyerBefore, after: buyerAfter },
    restoredBeforehand: restored,
    matrix: matrix.map(({ kind, contract, verified, settled, chain, sellerReceived }) => ({
      kind,
      contract,
      verified: verified.isValid,
      ...(verified.invalidReason && { invalidReason: verified.invalidReason }),
      settled: settled.success,
      ...(settled.errorReason && { errorReason: settled.errorReason }),
      sellerReceived,
      ...chain,
    })),
    batch: {
      size: BATCH,
      token: TEST_TOKEN,
      transactions: batch.map(
        ({ verified, settled, chain }) =>
          chain ?? { invalidReason: verified.invalidReason, errorReason: settled.errorReason },
      ),
    },
    checks,
  };
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./results/token-matrix-testnet.json", import.meta.url),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify(results, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  await facilitatorServer.close();
}
