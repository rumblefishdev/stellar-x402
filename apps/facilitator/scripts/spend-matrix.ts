/**
 * Testnet spend matrix (0024): the spend budgets, breakers and payer proof of a facilitator built
 * by `main()`, against real tokens on Stellar testnet.
 *
 * 1. Settles: a payment in the test token (wasm) and in a self-issued SAC settles, both in the
 *    `other` tier; testnet USDC (the known tier) too when `CLIENT_SECRET` is set.
 * 2. One balance, six payments: six payments sent at once from a balance that covers one. One
 *    settles; the rest are refused for free (`payer_busy`, or a simulation that sees the spent
 *    balance), and no transaction fails on chain.
 * 3. Payer proof: a payment the payer never signed, in `hostile-token` mode 1 (`transfer` without
 *    `require_auth`), is refused `settle_exact_stellar_payer_not_authorized`, with nothing sent.
 * 4. C-account payer: a payment from a `test-wallet` contract (`__check_auth`) settles, as the
 *    host writes its nonce under the contract's address.
 * 5. Asset breaker: `hostile-token` mode 3 lets one `transfer` per ledger through, so of six
 *    payments from six payers sent at once, all but the first included fail on chain and are
 *    charged. Once five have failed (each payer at most twice, below the payer breaker), `/verify`
 *    and `/settle` answer `settle_exact_stellar_breaker_open_asset`. Each failed record's stored
 *    failure cause is kept. Before it, a sample of mode 2 (fails on odd ledgers): a settlement
 *    usually lands in the ledger its simulation ran as, so it is refused by a simulation or
 *    settles, and fails on chain only when it lands a ledger later. That is up to timing (none of
 *    19 in one run), so mode 2 alone can't be relied on to open the breaker.
 * 6. Budget: a second facilitator with `SPEND_PER_PAYER_STROOPS=260000` settles a payer's first
 *    payment and refuses its second `settle_exact_stellar_spend_limit_payer`: a reservation is
 *    `MAX_FEE_STROOPS` (250,000) and a final settlement counts its fee charged, so the first fee
 *    (above 10,000) plus the second's reservation is above the budget. 0024's brief said 300,000,
 *    which assumed 0021's 152,649-stroop first fee; a first test-token payment now costs ~26,000,
 *    and three fit in 300,000.
 *
 * Env:
 *   DATABASE_URL     the PostgreSQL to use (default: compose's, 127.0.0.1:15432); each facilitator
 *                    gets a new schema of its own, migrated here and dropped at the end
 *   CLIENT_SECRET    optional: an account holding Circle-faucet testnet USDC, for the USDC case
 *   AMOUNT           base units per payment (default 1000)
 *   RPC_URLS         passed to the facilitators (default: the testnet RPC)
 *
 * The wasm files must be built first (no stellar-cli needed):
 *   cd contracts && SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1 cargo build --release \
 *     --target wasm32v1-none -p test-token -p hostile-token -p test-wallet
 *   cd apps/facilitator && npx tsx scripts/spend-matrix.ts
 *
 * Every account, contract, channel and schema is new each run. The results, with every hash, go
 * to `scripts/results/spend-matrix-testnet.json`; log lines go to stderr. Testnet only.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  contract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { buildCreateChannelsTx, readAccountEntry } from "@stellar-x402/signer-pool";
import type { PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer, getUsdcAddress } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { Agent, fetch } from "undici";
import { createPool } from "../src/adapters/postgres.js";
import { migrate } from "../src/adapters/postgres-schema.js";
import { main } from "../src/main.js";
import { fakeOpenBao, signerEnv } from "../test/fake-openbao.js";

const network = "stellar:testnet";
const RPC_URL = "https://soroban-testnet.stellar.org";
const server = new rpc.Server(RPC_URL);
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:15432/postgres";
const AMOUNT = BigInt(process.env.AMOUNT ?? "1000");
const CHANNELS = 4;
const PARALLEL = 6;
/** The budget case's per-payer budget: one reservation fits, a fee and a reservation don't. */
const LOW_PER_PAYER_STROOPS = 260_000n;
const MAX_FEE_STROOPS = 250_000n;
/** Mode-2 payments in its sample. */
const MODE_2_SAMPLE = 6;
/** Mode-3 rounds before the case gives up: the wasm breaker's window is 10 minutes. */
const MAX_BREAKER_ROUNDS = 4;
const MODE_NO_AUTH = 1;
const MODE_FAIL_ON_ODD_LEDGER = 2;
const MODE_ONE_PER_LEDGER = 3;
const FAILED = "settle_exact_stellar_transaction_failed";
const BREAKER_OPEN_ASSET = "settle_exact_stellar_breaker_open_asset";
const WASM_DIR = new URL("../../../contracts/target/wasm32v1-none/release/", import.meta.url);

/** The script's own HTTP client: `main()`'s global one gives up after 10 s without headers. */
const http = new Agent({ headersTimeout: 120_000 });
const log = (message: string) => process.stderr.write(`[spend-matrix] ${message}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const addr = (address: string) => Address.fromString(address).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

async function friendbot(): Promise<Keypair> {
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`, {
    dispatcher: http,
  });
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

/** Sends `tx` and waits for it, with the send's own error when the network refuses it. */
async function sendAndPoll(tx: Parameters<typeof server.sendTransaction>[0], what: string) {
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") {
    const reason = sent.errorResult?.result().switch().name ?? "no error result";
    throw new Error(`${what}: send ${sent.status} (${reason})`);
  }
  const done = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (done.status !== "SUCCESS") throw new Error(`${what}: ${done.status}`);
  return done;
}

/** One setup transaction from `source`, signed by it and `signers`; Soroban ones prepared. */
async function submit(
  source: Keypair,
  operations: xdr.Operation[],
  what: string,
  opts: { signers?: Keypair[]; soroban?: boolean } = {},
) {
  const builder = new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(120);
  for (const operation of operations) builder.addOperation(operation);
  const tx = opts.soroban ? await server.prepareTransaction(builder.build()) : builder.build();
  tx.sign(source, ...(opts.signers ?? []));
  return sendAndPoll(tx, what);
}

async function deploy(source: Keypair, name: string, constructorArgs: xdr.ScVal[] = []) {
  const wasm = readFileSync(new URL(`${name}.wasm`, WASM_DIR));
  const uploaded = await submit(
    source,
    [Operation.uploadContractWasm({ wasm })],
    `upload ${name}`,
    {
      soroban: true,
    },
  );
  const created = await submit(
    source,
    [
      Operation.createCustomContract({
        address: Address.fromString(source.publicKey()),
        wasmHash: Buffer.from(scValToNative(uploaded.returnValue!) as Uint8Array),
        salt: randomBytes(32),
        constructorArgs,
      }),
    ],
    `create ${name}`,
    { soroban: true },
  );
  return {
    contract: scValToNative(created.returnValue!) as string,
    wasmSha256: createHash("sha256").update(wasm).digest("hex"),
  };
}

const call = (source: Keypair, token: string, fn: string, args: xdr.ScVal[]) =>
  submit(
    source,
    [Operation.invokeContractFunction({ contract: token, function: fn, args })],
    `${fn} on ${token}`,
    { soroban: true },
  );

async function tokenBalance(token: string, holder: string, source: string): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: token,
        function: "balance",
        args: [addr(holder)],
      }),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`balance on ${token}`);
  return BigInt(scValToNative(sim.result.retval) as bigint);
}

/** Where a transaction landed and what it was charged, read back from the chain. */
async function onChain(hash: string) {
  const tx = await server.pollTransaction(hash, { attempts: 40 });
  if (tx.status === "NOT_FOUND") return { hash, status: tx.status };
  return {
    hash,
    status: tx.status,
    ledger: tx.ledger,
    feeCharged: tx.resultXdr.feeCharged().toString(),
  };
}

// --- Payments ---------------------------------------------------------------------------------

type Payload = { x402Version: number; payload: { transaction: string }; accepted: unknown };

const requirementsFor = (asset: string, payTo: string): PaymentRequirements => ({
  scheme: "exact",
  network,
  asset,
  amount: AMOUNT.toString(),
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
});

/** A G-account's payment, signed by upstream's own client. */
async function honestPayload(payer: Keypair, requirements: PaymentRequirements): Promise<Payload> {
  const client = new ExactStellarScheme(createEd25519Signer(payer.secret(), network));
  const payload = await client.createPaymentPayload(2, requirements);
  return { ...(payload as Omit<Payload, "accepted">), accepted: requirements };
}

/**
 * A `test-wallet` payment: built like upstream's client builds one, its auth entry signed for the
 * wallet's C-address with the bare ed25519 signature its `__check_auth` takes.
 */
async function walletPayload(
  wallet: string,
  owner: Keypair,
  requirements: PaymentRequirements,
): Promise<Payload> {
  const latest = await server.getLatestLedger();
  const tx = await contract.AssembledTransaction.build({
    contractId: requirements.asset,
    method: "transfer",
    args: [addr(wallet), addr(requirements.payTo), i128(BigInt(requirements.amount))],
    networkPassphrase: Networks.TESTNET,
    rpcUrl: RPC_URL,
    parseResultXdr: (result) => result,
  });
  await tx.signAuthEntries({
    address: wallet,
    expiration: latest.sequence + 12,
    authorizeEntry: (entry, _signer, validUntil, passphrase) =>
      authorizeEntry(
        entry,
        async (_preimage, payload) => ({ signatureScVal: xdr.ScVal.scvBytes(owner.sign(payload)) }),
        validUntil,
        passphrase,
      ),
  });
  await tx.simulate();
  return { x402Version: 2, payload: { transaction: tx.built!.toXDR() }, accepted: requirements };
}

/**
 * A payment `victim` never signed, built by hand as 0024's spike did: `from` is the victim, the
 * auth entry carries a random nonce and a random 64-byte "signature".
 */
async function forgedPayload(victim: string, requirements: PaymentRequirements): Promise<Payload> {
  const latest = await server.getLatestLedger();
  const args = [addr(victim), addr(requirements.payTo), i128(BigInt(requirements.amount))];
  const garbage = xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("public_key"),
        val: xdr.ScVal.scvBytes(Keypair.fromPublicKey(victim).rawPublicKey()),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signature"),
        val: xdr.ScVal.scvBytes(randomBytes(64)),
      }),
    ]),
  ]);
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(victim).toScAddress(),
        nonce: xdr.Int64.fromString(BigInt(`0x${randomBytes(7).toString("hex")}`).toString()),
        signatureExpirationLedger: latest.sequence + 10,
        signature: garbage,
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(requirements.asset).toScAddress(),
          functionName: "transfer",
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
  const tx = new TransactionBuilder(await server.getAccount(victim), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: requirements.asset,
        function: "transfer",
        args,
        auth: [auth],
      }),
    )
    .setTimeout(60)
    .build();
  return { x402Version: 2, payload: { transaction: tx.toXDR() }, accepted: requirements };
}

/** One answer of a facilitator route, and how long it took. */
async function post<T>(
  port: number,
  route: "verify" | "settle",
  requirements: PaymentRequirements,
  payload: Payload,
): Promise<{ answer: T; ms: number }> {
  const begun = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/${route}`, {
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
  return { answer: (await response.json()) as T, ms: Date.now() - begun };
}

/** A payment's `/verify` and, unless told not to or it was refused, `/settle`: as recorded. */
async function pay(
  port: number,
  requirements: PaymentRequirements,
  payload: Payload,
  opts: { settleAnyway?: boolean } = {},
) {
  const verify = await post<VerifyResponse>(port, "verify", requirements, payload);
  const row: Record<string, unknown> = {
    verified: verify.answer.isValid,
    ...(verify.answer.invalidReason && { invalidReason: verify.answer.invalidReason }),
    verifyMs: verify.ms,
  };
  if (!verify.answer.isValid && !opts.settleAnyway) return { row, settle: undefined };
  const settle = await post<SettleResponse>(port, "settle", requirements, payload);
  Object.assign(row, {
    settled: settle.answer.success,
    ...(settle.answer.errorReason && { errorReason: settle.answer.errorReason }),
    payer: settle.answer.payer,
    settleMs: settle.ms,
    ...(settle.answer.transaction && { chain: await onChain(settle.answer.transaction) }),
  });
  return { row, settle: settle.answer };
}

// --- Databases and facilitators ---------------------------------------------------------------

const schemas: string[] = [];
const admin = createPool(DATABASE_URL, () => {}, 2);

/** A new migrated schema of the run's own, and the URL whose connections use it. */
async function database(name: string): Promise<string> {
  const schema = `spend_matrix_${randomBytes(4).toString("hex")}_${name}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const url = new URL(DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = createPool(url.toString(), () => {}, 2);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return url.toString();
}

/** The facilitator's log lines, kept for the breaker openings, and written to stderr. */
const logged: { event: string; [field: string]: unknown }[] = [];
const write = (line: string) => {
  logged.push(JSON.parse(line) as { event: string });
  process.stderr.write(line);
};

async function facilitatorOn(databaseUrl: string, env: Record<string, string> = {}) {
  return main(
    {
      ...signerEnv(facilitator.publicKey(), openbao.socketPath),
      CHANNELS: channelKeys.map((keypair) => keypair.publicKey()).join(","),
      DATABASE_URL: databaseUrl,
      CLIENT_IP: "socket",
      PORT: "0",
      LOG_LEVEL: "warn",
      RPC_URLS: process.env.RPC_URLS,
      ...env,
    },
    { write },
  );
}
type Facilitator = Awaited<ReturnType<typeof facilitatorOn>>;

/** The stored records of `payer`'s settlements, with the number of hashes each signed. */
async function records(running: Facilitator, payer: string) {
  const { rows } = await running.pools.main.query<{
    state: string;
    error_reason: string | null;
    failure: unknown;
    fee_charged: string | null;
    hashes: string[];
  }>(
    `SELECT s.state, s.error_reason, s.failure, s.fee_charged::text,
            COALESCE(array_agg(h.hash) FILTER (WHERE h.hash IS NOT NULL), '{}') AS hashes
       FROM settlements s LEFT JOIN settlement_hashes h ON h.key = s.key
      WHERE s.payer = $1 GROUP BY s.key ORDER BY s.created_at`,
    [payer],
  );
  return rows;
}

// --- Setup ------------------------------------------------------------------------------------

const clientSecret = process.env.CLIENT_SECRET;
const [funder, facilitator] = [await friendbot(), await friendbot()];
const issuer = Keypair.random();
const seller = Keypair.random();
/** The budget case's seller: its first payment creates its balance, so that fee is high. */
const budgetSeller = Keypair.random();
/** Pays in each token; payer B's balance covers one payment; payer C is the budget case's. */
const payerA = Keypair.random();
const payerB = Keypair.random();
const payerC = Keypair.random();
/** Holds hostile tokens and never signs a payment. */
const victim = Keypair.random();
const walletOwner = Keypair.random();
/** The hostile token's payers: mode 2's, mode 3's rounds and the breaker probe's. */
const parityPayer = Keypair.random();
const breakerPayers = Array.from({ length: 2 * PARALLEL }, () => Keypair.random());
const probePayer = Keypair.random();
const SPENDMX = new Asset("SPENDMX", issuer.publicKey());
/** Circle's testnet USDC, the known tier. */
const USDC_ASSET = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const USDC = getUsdcAddress(network);
log(`funder ${funder.publicKey()}, facilitator ${facilitator.publicKey()}`);

await submit(
  funder,
  [
    ...[issuer, seller, budgetSeller, payerA, payerB, victim, payerC],
    ...[parityPayer, ...breakerPayers, probePayer],
  ].map((keypair) =>
    Operation.createAccount({ destination: keypair.publicKey(), startingBalance: "5" }),
  ),
  "accounts",
);
// The self-issued SAC: payer A and the seller hold it through trustlines.
await submit(
  funder,
  [
    Operation.changeTrust({ asset: SPENDMX, source: payerA.publicKey() }),
    Operation.changeTrust({ asset: SPENDMX, source: seller.publicKey() }),
    ...(clientSecret
      ? [Operation.changeTrust({ asset: USDC_ASSET, source: seller.publicKey() })]
      : []),
    Operation.payment({
      destination: payerA.publicKey(),
      asset: SPENDMX,
      amount: "100",
      source: issuer.publicKey(),
    }),
  ],
  "trustlines",
  { signers: [payerA, seller, issuer] },
);
const sac = SPENDMX.contractId(Networks.TESTNET);
await submit(funder, [Operation.createStellarAssetContract({ asset: SPENDMX })], "SAC deploy", {
  soroban: true,
});
const testToken = await deploy(funder, "test_token");
const hostileToken = await deploy(funder, "hostile_token");
const testWallet = await deploy(funder, "test_wallet", [
  xdr.ScVal.scvBytes(walletOwner.rawPublicKey()),
]);
const plenty = 1_000_000n * AMOUNT;
await call(funder, testToken.contract, "mint", [addr(payerA.publicKey()), i128(plenty)]);
// Payer B's balance covers exactly one payment.
await call(funder, testToken.contract, "mint", [addr(payerB.publicKey()), i128(AMOUNT)]);
await call(funder, testToken.contract, "mint", [addr(payerC.publicKey()), i128(plenty)]);
await call(funder, testToken.contract, "mint", [addr(testWallet.contract), i128(plenty)]);
await call(funder, hostileToken.contract, "mint", [addr(victim.publicKey()), i128(plenty)]);
// Each hostile-token payer pays for its own mint, so they go out at once.
await Promise.all(
  [parityPayer, ...breakerPayers, probePayer].map((payer) =>
    call(payer, hostileToken.contract, "mint", [addr(payer.publicKey()), i128(plenty)]),
  ),
);
log(`contracts: test-token ${testToken.contract}, hostile-token ${hostileToken.contract}`);

// Delegated channels: master key off, the facilitator their only signer.
const channelKeys = Array.from({ length: CHANNELS }, () => Keypair.random());
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
await sendAndPoll(setup, "channel setup");

// The fake OpenBao holds this run's key (0036): a testnet account funded for the run.
const openbao = await fakeOpenBao(facilitator);

// --- Cases on the default budgets -------------------------------------------------------------

const cases: Record<string, unknown> = {};
const checks: Record<string, boolean> = {};
const timed = async <T>(run: () => Promise<T>) => {
  const begun = Date.now();
  const value = await run();
  return { value, ms: Date.now() - begun };
};

const running = await facilitatorOn(await database("default"));
try {
  const port = running.port;

  // 1. Settles, one per kind of token.
  log("case: settles");
  const settles: Record<string, unknown>[] = [];
  if (clientSecret) {
    const client = Keypair.fromSecret(clientSecret);
    const requirements = requirementsFor(USDC, seller.publicKey());
    const { row } = await pay(port, requirements, await honestPayload(client, requirements));
    settles.push({ kind: "usdc", tier: "known", contract: USDC, ...row });
  } else {
    settles.push({
      kind: "usdc",
      tier: "known",
      contract: USDC,
      status: "not run (needs CLIENT_SECRET: an account holding Circle-faucet testnet USDC)",
    });
  }
  for (const [kind, asset] of [
    ["test-token (wasm)", testToken.contract],
    ["self-issued SAC (SPENDMX)", sac],
  ] as const) {
    const requirements = requirementsFor(asset, seller.publicKey());
    const { row } = await pay(port, requirements, await honestPayload(payerA, requirements));
    settles.push({ kind, tier: "other", contract: asset, ...row });
  }
  cases.settles = settles;
  checks.everyTokenRunSettled = settles
    .filter((row) => !("status" in row))
    .every((row) => row.settled === true);

  // 2. Six payments at once from a balance that covers one.
  log("case: one balance, six payments");
  const parallelRequirements = requirementsFor(testToken.contract, seller.publicKey());
  const parallelPayloads: Payload[] = [];
  for (let i = 0; i < PARALLEL; i++)
    parallelPayloads.push(await honestPayload(payerB, parallelRequirements));
  const parallel = await timed(() =>
    Promise.all(parallelPayloads.map((payload) => pay(port, parallelRequirements, payload))),
  );
  const parallelRecords = await records(running, payerB.publicKey());
  const parallelRows = parallel.value.map(({ row }) => row);
  cases.oneBalanceSixPayments = {
    payer: payerB.publicKey(),
    balanceBefore: AMOUNT.toString(),
    balanceAfter: `${await tokenBalance(testToken.contract, payerB.publicKey(), funder.publicKey())}`,
    ms: parallel.ms,
    payments: parallelRows,
    stored: parallelRecords.map(({ state, error_reason, hashes }) => ({
      state,
      errorReason: error_reason,
      hashes,
    })),
  };
  checks.oneOfSixSettled = parallelRows.filter((row) => row.settled === true).length === 1;
  checks.restRefusedWithoutATransaction = parallelRows
    .filter((row) => row.settled !== true)
    .every((row) => row.chain === undefined);
  checks.noFailedTransaction =
    parallelRecords.every((record) => record.state !== "failed") &&
    parallelRecords.flatMap((record) => record.hashes).length === 1;

  // 3. A payment the payer never signed, through a `transfer` without `require_auth`.
  log("case: payer proof (hostile-token mode 1)");
  await call(funder, hostileToken.contract, "set_mode", [
    nativeToScVal(MODE_NO_AUTH, { type: "u32" }),
  ]);
  const forgedRequirements = requirementsFor(hostileToken.contract, seller.publicKey());
  const victimBefore = await tokenBalance(
    hostileToken.contract,
    victim.publicKey(),
    funder.publicKey(),
  );
  const forged = await pay(
    port,
    forgedRequirements,
    await forgedPayload(victim.publicKey(), forgedRequirements),
    { settleAnyway: true },
  );
  const victimAfter = await tokenBalance(
    hostileToken.contract,
    victim.publicKey(),
    funder.publicKey(),
  );
  const forgedRecords = await records(running, victim.publicKey());
  cases.payerNotAuthorized = {
    token: hostileToken.contract,
    mode: MODE_NO_AUTH,
    victim: victim.publicKey(),
    ...forged.row,
    victimBalance: { before: `${victimBefore}`, after: `${victimAfter}` },
    stored: forgedRecords.map(({ state, error_reason, hashes }) => ({
      state,
      errorReason: error_reason,
      hashes,
    })),
  };
  checks.forgedPayerRefused =
    forged.row.errorReason === "settle_exact_stellar_payer_not_authorized" &&
    forged.row.chain === undefined &&
    victimAfter === victimBefore &&
    forgedRecords.every((record) => record.hashes.length === 0);

  // 4. A C-account payer.
  log("case: C-account payer (test-wallet)");
  const walletRequirements = requirementsFor(testToken.contract, seller.publicKey());
  const wallet = await pay(
    port,
    walletRequirements,
    await walletPayload(testWallet.contract, walletOwner, walletRequirements),
  );
  cases.cAccountPayer = {
    wallet: testWallet.contract,
    owner: walletOwner.publicKey(),
    ...wallet.row,
  };
  checks.cAccountSettled =
    wallet.row.settled === true &&
    wallet.row.payer === testWallet.contract &&
    (wallet.row.chain as { status?: string } | undefined)?.status === "SUCCESS";

  // 5a. Mode 2, a sample: a payment fails on chain only when it lands a ledger after its
  // simulation, which is up to timing, so mode 2 alone can't be relied on to open the breaker.
  log("case: mode-2 sample (hostile-token, fails on odd ledgers)");
  await call(funder, hostileToken.contract, "set_mode", [
    nativeToScVal(MODE_FAIL_ON_ODD_LEDGER, { type: "u32" }),
  ]);
  const hostileRequirements = requirementsFor(hostileToken.contract, seller.publicKey());
  /**
   * A payload whose client simulation passed: in mode 2 it fails on an odd ledger, in mode 3 in a
   * ledger that already has a transfer.
   */
  const simulatedPayload = async (payer: Keypair) => {
    for (let tries = 1; ; tries++) {
      try {
        return await honestPayload(payer, hostileRequirements);
      } catch (error) {
        if (tries >= 10) throw error;
        await sleep(2_500);
      }
    }
  };
  const sample: Record<string, unknown>[] = [];
  for (let attempt = 1; attempt <= MODE_2_SAMPLE; attempt++) {
    const { row } = await pay(port, hostileRequirements, await simulatedPayload(parityPayer));
    sample.push({ attempt, ...row });
    log(`mode 2, attempt ${attempt}: ${row.invalidReason ?? row.errorReason ?? "settled"}`);
    // Below the payer breaker's 3.
    if (sample.filter((r) => r.errorReason === FAILED).length >= 2) break;
  }
  cases.mode2Sample = {
    token: hostileToken.contract,
    mode: MODE_FAIL_ON_ODD_LEDGER,
    payer: parityPayer.publicKey(),
    attempts: sample,
    settled: sample.filter((r) => r.settled === true).length,
    failedOnChain: sample.filter((r) => r.errorReason === FAILED).length,
    refusedBySimulation: sample.filter((r) => r.settled !== true && r.errorReason !== FAILED)
      .length,
  };

  // 5b. Mode 3: rounds of payments sent at once from different payers, until the asset's
  // breaker opens. All but the first included in a ledger fail on chain and are charged.
  log("case: asset breaker (hostile-token, one transfer per ledger)");
  await call(funder, hostileToken.contract, "set_mode", [
    nativeToScVal(MODE_ONE_PER_LEDGER, { type: "u32" }),
  ]);
  const breakerBegun = Date.now();
  const rounds: Record<string, unknown>[] = [];
  let opened: Record<string, unknown> | undefined;
  for (let round = 0; round < MAX_BREAKER_ROUNDS && !opened; round++) {
    // Each payer is in every other round, so it fails at most twice: below its breaker's 3.
    const payers = breakerPayers.slice((round % 2) * PARALLEL, ((round % 2) + 1) * PARALLEL);
    const payloads = [];
    for (const payer of payers) payloads.push(await simulatedPayload(payer));
    const verified = await Promise.all(
      payloads.map((payload) => post<VerifyResponse>(port, "verify", hostileRequirements, payload)),
    );
    // Sent together, so their settlements land in the same ledger.
    const settled = await Promise.all(
      payloads.map((payload) => post<SettleResponse>(port, "settle", hostileRequirements, payload)),
    );
    const payments = await Promise.all(
      settled.map(async ({ answer, ms }, i) => ({
        payer: payers[i]!.publicKey(),
        verified: verified[i]!.answer.isValid,
        ...(verified[i]!.answer.invalidReason && {
          invalidReason: verified[i]!.answer.invalidReason,
        }),
        settled: answer.success,
        ...(answer.errorReason && { errorReason: answer.errorReason }),
        settleMs: ms,
        ...(answer.transaction && { chain: await onChain(answer.transaction) }),
      })),
    );
    rounds.push({ round: round + 1, payments });
    log(`round ${round + 1}: ${payments.map((p) => p.errorReason ?? "settled").join(", ")}`);
    // A new payment from a payer with no failures: refused only for the asset's breaker.
    const probePayload = await simulatedPayload(probePayer);
    const probe = await pay(port, hostileRequirements, probePayload, { settleAnyway: true });
    if (probe.row.invalidReason === BREAKER_OPEN_ASSET) {
      opened = { afterMs: Date.now() - breakerBegun, afterRound: round + 1, ...probe.row };
    }
  }
  const breakerRecords = (
    await Promise.all(
      [parityPayer, ...breakerPayers, probePayer].map((p) => records(running, p.publicKey())),
    )
  ).flat();
  const failed = breakerRecords.filter((record) => record.state === "failed");
  cases.assetBreaker = {
    token: hostileToken.contract,
    mode: MODE_ONE_PER_LEDGER,
    rounds,
    /** Every failed settlement of the hostile token in this run, mode 2's included. */
    failedSettlements: failed.map(({ hashes, fee_charged, failure }) => ({
      hashes,
      feeCharged: fee_charged,
      failure,
    })),
    successes: breakerRecords.filter((record) => record.state === "success").length,
    breakerOpenings: logged.filter((line) => line.event === "spend_breaker_opened"),
    probe: opened,
  };
  checks.assetBreakerOpenedAfterFiveFailures =
    failed.length >= 5 && opened?.errorReason === BREAKER_OPEN_ASSET;
  checks.noPayerBreakerOpened = !logged.some(
    (line) => line.event === "spend_breaker_opened" && String(line.scope).startsWith("payer:"),
  );
  checks.failureCauseStored = failed.every((record) => record.failure !== null);
} finally {
  await running.close();
}

// --- 6. A low per-payer budget, on a facilitator of its own -----------------------------------

log(`case: budget refusal (SPEND_PER_PAYER_STROOPS=${LOW_PER_PAYER_STROOPS})`);
const budgeted = await facilitatorOn(await database("budget"), {
  SPEND_PER_PAYER_STROOPS: LOW_PER_PAYER_STROOPS.toString(),
});
try {
  const requirements = requirementsFor(testToken.contract, budgetSeller.publicKey());
  const payments: Record<string, unknown>[] = [];
  for (let i = 1; i <= 3; i++) {
    const { row } = await pay(
      budgeted.port,
      requirements,
      await honestPayload(payerC, requirements),
    );
    payments.push({ payment: i, ...row });
    if (row.settled !== true) break;
  }
  const first = payments[0]?.chain as { feeCharged?: string } | undefined;
  cases.budgetRefusal = {
    perPayerStroops: LOW_PER_PAYER_STROOPS.toString(),
    reservationStroops: MAX_FEE_STROOPS.toString(),
    payer: payerC.publicKey(),
    payTo: budgetSeller.publicKey(),
    payments,
    why:
      first?.feeCharged &&
      `first fee ${first.feeCharged} + reservation ${MAX_FEE_STROOPS} = ${
        BigInt(first.feeCharged) + MAX_FEE_STROOPS
      } ${BigInt(first.feeCharged) + MAX_FEE_STROOPS > LOW_PER_PAYER_STROOPS ? ">" : "<="} ${LOW_PER_PAYER_STROOPS}`,
  };
  checks.secondPaymentRefusedByPayerBudget =
    payments.length === 2 &&
    payments[0]!.settled === true &&
    payments[1]!.errorReason === "settle_exact_stellar_spend_limit_payer" &&
    payments[1]!.chain === undefined;
} finally {
  await budgeted.close();
}

try {
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
} finally {
  await admin.end();
  openbao.close();
}

const results = {
  ranAt: new Date().toISOString(),
  network,
  facilitator: facilitator.publicKey(),
  channels: channelKeys.map((keypair) => keypair.publicKey()),
  funder: funder.publicKey(),
  seller: seller.publicKey(),
  amount: AMOUNT.toString(),
  contracts: {
    testToken,
    hostileToken,
    testWallet,
    sac: { contract: sac, asset: `${SPENDMX.code}:${SPENDMX.issuer}` },
  },
  cases,
  checks,
};
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("./results/spend-matrix-testnet.json", import.meta.url),
  `${JSON.stringify(results, null, 2)}\n`,
);
console.log(JSON.stringify(results, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
