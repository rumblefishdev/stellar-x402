// Throwaway testnet spike for task 0002. It plays the x402 roles against the spike contract:
// the client signs only its auth entry; the facilitator rebuilds the transaction as source with
// the actual amount, adds its own source-account auth, re-simulates, signs and submits.
//
// Env: CLIENT_SECRET, FACILITATOR_SECRET, SELLER_SECRET, CHANNEL_SECRET, TOKEN_ID, PROXY_ID, [RPC_URL]
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const server = new rpc.Server(process.env.RPC_URL ?? "https://soroban-testnet.stellar.org");
const passphrase = Networks.TESTNET;
const client = Keypair.fromSecret(need("CLIENT_SECRET"));
const facilitator = Keypair.fromSecret(need("FACILITATOR_SECRET"));
const seller = Keypair.fromSecret(need("SELLER_SECRET"));
const channel = Keypair.fromSecret(need("CHANNEL_SECRET"));
const TOKEN = need("TOKEN_ID");
const PROXY = need("PROXY_ID");
const UNIT = 10_000_000n;

type Terms = {
  to: string;
  max: bigint;
  nonce: Buffer;
  validAfter: bigint;
  deadline: bigint;
  expLedger: number;
};

type Outcome = {
  scenario: string;
  expect: "success" | "reject";
  ok: boolean;
  hash?: string;
  feeCharged?: string;
  detail?: string;
};
const results: Outcome[] = [];

const addr = (a: string) => nativeToScVal(Address.fromString(a));

function settleArgs(t: Terms, actual: bigint, bound = facilitator.publicKey()): xdr.ScVal[] {
  return [
    addr(TOKEN),
    addr(client.publicKey()),
    addr(t.to),
    addr(bound),
    nativeToScVal(t.max, { type: "i128" }),
    nativeToScVal(actual, { type: "i128" }),
    xdr.ScVal.scvBytes(t.nonce),
    nativeToScVal(t.validAfter, { type: "u64" }),
    nativeToScVal(t.deadline, { type: "u64" }),
    nativeToScVal(t.expLedger, { type: "u32" }),
  ];
}

function invokeArgs(args: xdr.ScVal[]) {
  return new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(PROXY).toScAddress(),
    functionName: "settle_upto",
    args,
  });
}

function credentialAddress(e: xdr.SorobanAuthorizationEntry): string | undefined {
  const c = e.credentials;
  if (c.type === "sorobanCredentialsSourceAccount") return undefined;
  // Address, AddressV2 and AddressWithDelegates all carry SorobanAddressCredentials.
  const creds = c.type === "sorobanCredentialsAddressWithDelegates" ? c.value.addressCredentials : c.value;
  return Address.fromScAddress(creds.address).toString();
}

function describeTree(inv: xdr.SorobanAuthorizedInvocation, depth = 0): string[] {
  const f = inv.function;
  const lines: string[] = [];
  if (f.type === "sorobanAuthorizedFunctionTypeContractFn") {
    const c = f.contractFn;
    const args = c.args.map((a) => {
      const v = scValToNative(a);
      return v instanceof Uint8Array ? `0x${Buffer.from(v).toString("hex").slice(0, 16)}…` : String(v);
    });
    lines.push(
      `${"  ".repeat(depth)}${Address.fromScAddress(c.contractAddress).toString().slice(0, 6)}…` +
        `.${c.functionName.toString()}(${args.join(", ")})`,
    );
  } else {
    lines.push(`${"  ".repeat(depth)}${f.type}`);
  }
  for (const s of inv.subInvocations) lines.push(...describeTree(s, depth + 1));
  return lines;
}

async function newTerms(max: bigint, to = seller.publicKey()): Promise<Terms> {
  const latest = await server.getLatestLedger();
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    to,
    max,
    nonce: randomBytes(32),
    validAfter: now - 60n,
    deadline: now + 600n,
    // ~10 minutes at ~5 s per ledger; also used as the approve expiration.
    expLedger: latest.sequence + 120,
  };
}

/** Client: simulate with a placeholder amount (= max) and sign only its own entry. */
async function clientSign(t: Terms, draftSource: string): Promise<{
  signed?: xdr.SorobanAuthorizationEntry;
  arms: string[];
  tree: string[];
}> {
  const src = await server.getAccount(draftSource);
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(PROXY).call("settle_upto", ...settleArgs(t, t.max)))
    .setTimeout(300)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`client simulation failed: ${sim.error}`);
  const entries = sim.result?.auth ?? [];
  const arms = entries.map((e) => `${credentialAddress(e)?.slice(0, 6) ?? "source"}:${e.credentials.type}`);
  const mine = entries.filter((e) => credentialAddress(e) === client.publicKey());
  if (mine.length !== 1) return { arms, tree: [] };
  const tree = describeTree(mine[0].rootInvocation);
  const signed = await authorizeEntry(mine[0], client, t.expLedger, passphrase);
  return { signed, arms, tree };
}

/** Facilitator (or an impostor): rebuild with itself as source and the actual amount, then submit. */
async function settle(
  scenario: string,
  expect: Outcome["expect"],
  t: Terms,
  signedClient: xdr.SorobanAuthorizationEntry,
  actual: bigint,
  opts: { submitter?: Keypair; overrideTo?: string; viaChannel?: boolean } = {},
): Promise<Outcome> {
  // viaChannel: a channel account is the tx source and fee payer; the facilitator signs an
  // address-credential entry instead of relying on source-account credentials.
  const submitter = opts.viaChannel ? channel : (opts.submitter ?? facilitator);
  const args = settleArgs({ ...t, to: opts.overrideTo ?? t.to }, actual);
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs(args)),
    subInvocations: [],
  });
  const facilitatorAuth = opts.viaChannel
    ? await authorizeEntry(
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
            new xdr.SorobanAddressCredentials({
              address: Address.fromString(facilitator.publicKey()).toScAddress(),
              nonce: randomBytes(8).readBigInt64BE(),
              signatureExpirationLedger: 0,
              signature: xdr.ScVal.scvVoid(),
            }),
          ),
          rootInvocation,
        }),
        facilitator,
        t.expLedger,
        passphrase,
      )
    : new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation,
      });
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs(args)),
    auth: [signedClient, facilitatorAuth],
  });
  const src = await server.getAccount(submitter.publicKey());
  let tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(op)
    .setTimeout(60)
    .build();
  // Auth entries are present, so the RPC simulates in enforcing mode against the real signature.
  const sim = await server.simulateTransaction(tx);
  let out: Outcome;
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = rpc.Api.isSimulationError(sim) ? sim.error : "simulation restore required";
    out = { scenario, expect, ok: expect === "reject", detail: `rejected at simulation: ${firstLine(err)}` };
  } else {
    tx = rpc.assembleTransaction(tx, sim).build();
    tx.sign(submitter);
    const sent = await server.sendTransaction(tx);
    if (sent.status !== "PENDING") {
      out = { scenario, expect, ok: expect === "reject", hash: sent.hash, detail: `send status ${sent.status}` };
    } else {
      const res = await server.pollTransaction(sent.hash, { attempts: 30 });
      const success = res.status === rpc.Api.GetTransactionStatus.SUCCESS;
      const feeCharged =
        "resultXdr" in res && res.resultXdr ? res.resultXdr.feeCharged.toString() : undefined;
      out = {
        scenario,
        expect,
        ok: success === (expect === "success"),
        hash: sent.hash,
        feeCharged,
        detail: `on-chain ${res.status}`,
      };
    }
  }
  results.push(out);
  console.log(`${out.ok ? "PASS" : "FAIL"} ${scenario}: ${out.detail}${out.hash ? ` ${out.hash}` : ""}`);
  return out;
}

function firstLine(s: string): string {
  const m = s.match(/Error\(Contract, #\d+\)|Error\(Auth, \w+\)|Error\([A-Za-z]+, \w+\)/);
  return m ? m[0] : s.split("\n")[0].slice(0, 160);
}

async function tokenBalance(owner: string): Promise<bigint> {
  const src = await server.getAccount(facilitator.publicKey());
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(TOKEN).call("balance", addr(owner)))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error("balance simulation failed");
  return scValToNative(sim.result.retval) as bigint;
}

async function xlmBalance(pub: string): Promise<bigint> {
  const entry = await server.getAccountEntry(pub);
  return entry.balance;
}

async function main() {
  const clientXlm0 = await xlmBalance(client.publicKey());
  const facXlm0 = await xlmBalance(facilitator.publicKey());

  // Finding check: a draft whose source is the client gives the client source-account credentials.
  const probe = await newTerms(1n * UNIT);
  const selfSourced = await clientSign(probe, client.publicKey());
  console.log("draft sourced by client ->", selfSourced.arms.join(", "));

  // S1 partial settlement: signed with actual = max at simulation, settled for 37.5.
  const t1 = await newTerms(100n * UNIT);
  const c1 = await clientSign(t1, facilitator.publicKey());
  console.log("draft sourced by facilitator ->", c1.arms.join(", "));
  console.log("client-signed tree:\n" + c1.tree.join("\n"));
  const [from0, to0] = [await tokenBalance(client.publicKey()), await tokenBalance(seller.publicKey())];
  await settle("S1 partial 37.5 of 100", "success", t1, c1.signed!, 375n * (UNIT / 10n));
  const [from1, to1] = [await tokenBalance(client.publicKey()), await tokenBalance(seller.publicKey())];
  console.log(`  deltas: client ${from1 - from0}, seller ${to1 - to0}`);
  results.at(-1)!.detail += `; deltas client ${from1 - from0}, seller ${to1 - to0}`;

  // S2 replay of the S1 entry with a different amount.
  await settle("S2 replay S1 entry", "reject", t1, c1.signed!, 1n * UNIT);

  // Negative cases against a fresh, unused authorization t3.
  const t3 = await newTerms(10n * UNIT);
  const c3 = await clientSign(t3, facilitator.publicKey());
  await settle("S3 redirect recipient", "reject", t3, c3.signed!, 1n * UNIT, {
    overrideTo: facilitator.publicKey(),
  });
  await settle("S4 actual above max", "reject", t3, c3.signed!, 10n * UNIT + 1n);
  await settle("S5 other party settles", "reject", t3, c3.signed!, 1n * UNIT, { submitter: seller });
  // S6: the same, still unused, authorization settles for zero.
  await settle("S6 zero amount", "success", t3, c3.signed!, 0n);

  // S7 two open authorizations from one payer, settled out of signing order.
  const t7a = await newTerms(50n * UNIT);
  const c7a = await clientSign(t7a, facilitator.publicKey());
  const t7b = await newTerms(50n * UNIT);
  const c7b = await clientSign(t7b, facilitator.publicKey());
  await settle("S7b second auth settles first (20)", "success", t7b, c7b.signed!, 20n * UNIT);
  await settle("S7a first auth settles at max (50)", "success", t7a, c7a.signed!, 50n * UNIT);

  // S8 channel account as source, facilitator bound via its own signed address-credential entry.
  const t8 = await newTerms(10n * UNIT);
  const c8 = await clientSign(t8, facilitator.publicKey());
  const chanXlm0 = await xlmBalance(channel.publicKey());
  const facXlmBefore8 = await xlmBalance(facilitator.publicKey());
  await settle("S8 channel source + facilitator address auth", "success", t8, c8.signed!, 3n * UNIT, {
    viaChannel: true,
  });
  const chanDelta = (await xlmBalance(channel.publicKey())) - chanXlm0;
  const facDelta8 = (await xlmBalance(facilitator.publicKey())) - facXlmBefore8;
  results.at(-1)!.detail += `; channel XLM ${chanDelta}, facilitator XLM ${facDelta8}`;

  const clientXlm1 = await xlmBalance(client.publicKey());
  const facXlm1 = await xlmBalance(facilitator.publicKey());
  const summary = {
    network: "stellar:testnet",
    proxy: PROXY,
    token: TOKEN,
    client: client.publicKey(),
    facilitator: facilitator.publicKey(),
    seller: seller.publicKey(),
    clientXlmDelta: (clientXlm1 - clientXlm0).toString(),
    facilitatorXlmDelta: (facXlm1 - facXlm0).toString(),
    draftSourcedByClient: selfSourced.arms,
    draftSourcedByFacilitator: c1.arms,
    clientSignedTree: c1.tree,
    results,
    ranAt: new Date().toISOString(),
  };
  mkdirSync("../results", { recursive: true });
  writeFileSync("../results/testnet-run.json", JSON.stringify(summary, null, 2) + "\n");
  console.log(`client XLM delta ${summary.clientXlmDelta}, facilitator XLM delta ${summary.facilitatorXlmDelta}`);
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `${failed.length} scenario(s) FAILED` : "all scenarios as expected");
  process.exitCode = failed.length ? 1 : 0;
}

await main();
