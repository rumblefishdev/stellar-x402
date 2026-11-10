/**
 * Testnet probe (0024, PR #105 review): which contract a front-run against a C-account payer
 * reports. A `test-wallet` payment's one signed auth entry goes into two transactions, both
 * prepared before either is sent, as a seller racing the facilitator would: the front-runner's
 * lands, ours lands after it and fails on chain with `Error(Auth, ExistingValue)`. The failed
 * one is read back with `failureCause`, every diagnostic `error` event it carries is listed, and
 * `attribute` says whom 0024 charges. Run once in the test token (wasm) and once in a
 * self-issued SAC, the class USDC is in.
 *
 * Build the wasm first (see `spend-matrix.ts`), then:
 *   cd apps/facilitator && npx tsx test/live/front-run-probe.ts
 *
 * The results, with every hash, go to `test/live/results/front-run-testnet.json`. Testnet only.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  contract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { failureCause } from "@stellar-x402/signer-pool";
import { attribute } from "../../src/spend/attribution.js";

const RPC_URL = "https://soroban-testnet.stellar.org";
const server = new rpc.Server(RPC_URL);
const WASM_DIR = new URL("../../../../contracts/target/wasm32v1-none/release/", import.meta.url);
const AMOUNT = 1_000n;
const log = (message: string) => process.stderr.write(`[front-run] ${message}\n`);
const addr = (address: string) => Address.fromString(address).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

async function friendbot(): Promise<Keypair> {
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`);
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

async function send(tx: Transaction, what: string) {
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") {
    const reason = sent.errorResult?.result().switch().name ?? "no error result";
    throw new Error(`${what}: send ${sent.status} (${reason})`);
  }
  return server.pollTransaction(sent.hash, { attempts: 40 });
}

/** One setup transaction from `source`; a Soroban one prepared first. */
async function submit(source: Keypair, operation: xdr.Operation, what: string, soroban = true) {
  const built = new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const tx = soroban ? await server.prepareTransaction(built) : built;
  tx.sign(source);
  const done = await send(tx, what);
  if (done.status !== "SUCCESS") throw new Error(`${what}: ${done.status}`);
  return done;
}

async function deploy(source: Keypair, name: string, constructorArgs: xdr.ScVal[] = []) {
  const wasm = readFileSync(new URL(`${name}.wasm`, WASM_DIR));
  const uploaded = await submit(source, Operation.uploadContractWasm({ wasm }), `upload ${name}`);
  const created = await submit(
    source,
    Operation.createCustomContract({
      address: Address.fromString(source.publicKey()),
      wasmHash: Buffer.from(scValToNative(uploaded.returnValue!) as Uint8Array),
      salt: randomBytes(32),
      constructorArgs,
    }),
    `create ${name}`,
  );
  return scValToNative(created.returnValue!) as string;
}

const invoke = (source: Keypair, token: string, fn: string, args: xdr.ScVal[]) =>
  submit(source, Operation.invokeContractFunction({ contract: token, function: fn, args }), fn);

/** The latest ledger's sequence, read raw: this SDK fails to parse the header testnet sends now. */
async function latestLedger(): Promise<{ sequence: number }> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  const body = (await response.json()) as { result: { sequence: number } };
  return { sequence: body.result.sequence };
}

/** The wallet's `transfer`, its auth entry signed as `spend-matrix.ts`'s `walletPayload` does. */
async function walletTransfer(token: string, wallet: string, owner: Keypair, payTo: string) {
  const latest = await latestLedger();
  const tx = await contract.AssembledTransaction.build({
    contractId: token,
    method: "transfer",
    args: [addr(wallet), addr(payTo), i128(AMOUNT)],
    networkPassphrase: Networks.TESTNET,
    rpcUrl: RPC_URL,
    parseResultXdr: (result) => result,
  });
  await tx.signAuthEntries({
    address: wallet,
    expiration: latest.sequence + 30,
    authorizeEntry: (entry, _signer, validUntil, passphrase) =>
      authorizeEntry(
        entry,
        async (_preimage, payload) => ({ signatureScVal: xdr.ScVal.scvBytes(owner.sign(payload)) }),
        validUntil,
        passphrase,
      ),
  });
  const op = tx.built!.operations[0] as Operation.InvokeHostFunction;
  return { func: op.func, auth: op.auth ?? [] };
}

/** One transaction from `source` carrying the payment's operation, prepared now. */
async function carrying(source: Keypair, payment: Awaited<ReturnType<typeof walletTransfer>>) {
  const built = new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.invokeHostFunction({ func: payment.func, auth: payment.auth }))
    .setTimeout(120)
    .build();
  const tx = await server.prepareTransaction(built);
  tx.sign(source);
  return tx;
}

/** Every diagnostic `error` event of a failed transaction: its contract and its error. */
function errorEvents(res: rpc.Api.GetFailedTransactionResponse) {
  return (res.diagnosticEventsXdr ?? []).flatMap((diagnostic) => {
    const event = diagnostic.event();
    const [name, value] = event.body().v0().topics();
    if (name?.switch().name !== "scvSymbol" || name.sym().toString() !== "error") return [];
    const id = event.contractId();
    return [
      {
        type: event.type().name,
        contract: id ? Address.contract(id as unknown as Buffer).toString() : null,
        error: value?.switch().name === "scvError" ? value.error().switch().name : null,
        code:
          value?.switch().name === "scvError" && value.error().switch().name !== "sceContract"
            ? value.error().code().name
            : null,
      },
    ];
  });
}

async function probe(
  kind: "wasm" | "sac",
  token: string,
  wallet: string,
  owner: Keypair,
  payTo: string,
  us: Keypair,
  frontRunner: Keypair,
) {
  log(`${kind}: building the payment and both transactions`);
  const payment = await walletTransfer(token, wallet, owner, payTo);
  const ours = await carrying(us, payment);
  const theirs = await carrying(frontRunner, payment);
  const first = await send(theirs, "front-run");
  log(`${kind}: front-run ${first.status} ${theirs.hash().toString("hex")}`);
  const second = await send(ours, "ours");
  const hash = ours.hash().toString("hex");
  log(`${kind}: ours ${second.status} ${hash}`);
  if (second.status !== "FAILED")
    return {
      kind,
      token,
      wallet,
      frontRun: theirs.hash().toString("hex"),
      ours: { hash, status: second.status },
    };
  const failed = second as rpc.Api.GetFailedTransactionResponse;
  const cause = failureCause(failed);
  return {
    kind,
    token,
    wallet,
    frontRun: {
      hash: theirs.hash().toString("hex"),
      status: first.status,
      ledger: first.status === "SUCCESS" ? first.ledger : undefined,
    },
    ours: {
      hash,
      status: second.status,
      ledger: failed.ledger,
      feeCharged: failed.resultXdr.feeCharged().toString(),
      failureCause: cause,
      errorEvents: errorEvents(failed),
      faults: attribute(cause, { kind, tier: "other", payer: wallet, payTo, asset: token }),
    },
  };
}

const funder = await friendbot();
const frontRunner = await friendbot();
const owner = Keypair.random();
const issuer = Keypair.random();
const seller = Keypair.random();
log(`funder ${funder.publicKey()}, front-runner ${frontRunner.publicKey()}`);
await submit(
  funder,
  Operation.createAccount({ destination: issuer.publicKey(), startingBalance: "5" }),
  "issuer",
  false,
);
await submit(
  funder,
  Operation.createAccount({ destination: seller.publicKey(), startingBalance: "5" }),
  "seller",
  false,
);
const wallet = await deploy(funder, "test_wallet", [xdr.ScVal.scvBytes(owner.rawPublicKey())]);
const testToken = await deploy(funder, "test_token");
await invoke(funder, testToken, "mint", [addr(wallet), i128(1_000_000n)]);
const PROBE = new Asset("FRUNPRB", issuer.publicKey());
await submit(funder, Operation.createStellarAssetContract({ asset: PROBE }), "SAC deploy");
const sac = PROBE.contractId(Networks.TESTNET);
// The issuer is the SAC's admin; a contract holds a SAC balance without a trustline, and the
// issuer receives its own asset without one.
await invoke(issuer, sac, "mint", [addr(wallet), i128(1_000_000n)]);

const results = {
  network: "stellar:testnet",
  ranAt: new Date().toISOString(),
  owner: owner.publicKey(),
  cases: [
    await probe("wasm", testToken, wallet, owner, seller.publicKey(), funder, frontRunner),
    await probe("sac", sac, wallet, owner, issuer.publicKey(), funder, frontRunner),
  ],
};
const out = new URL("./results/front-run-testnet.json", import.meta.url);
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
log(`written ${out.pathname}`);
