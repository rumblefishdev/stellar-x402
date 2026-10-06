// Testnet smoke test for the submitter: creates delegated channels with buildCreateChannelsTx,
// checks them, then settles real UptoProxy payments through SettlementSubmitter.
//
// Env: FACILITATOR_SECRET, TOKEN_ID, PROXY_ID, CLIENTS_FILE (0006 bench secrets/accounts.json),
//      [RPC_URLS] comma-separated, tried in order through FallbackRpc,
//      [PIPELINE=0] to turn pipelining off, [POLL_MS] ledger clock interval (default 1000),
//      [FEE_MAX] turns fee escalation on with this ceiling in stroops,
//      [SELLERS] how many sellers to pay (default all; 1 = the one-seller scenario),
//      [CHANNELS_FILE] JSON list of channel addresses reused across runs; missing channels are
//      created and appended
// Usage: tsx scripts/testnet-smoke.ts <channels> <payments>
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Address,
  Keypair,
  Networks,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  FallbackRpc,
  MAX_CHANNELS_PER_TX,
  checkFacilitatorBalance,
  SettlementSubmitter,
  buildCreateChannelsTx,
  checkChannel,
  feeStatsInclusionFee,
  keypairSigner,
} from "../src/index.js";

const need = (k: string) =>
  process.env[k] ??
  (() => {
    throw new Error(`missing ${k}`);
  })();
const rpcUrls = (process.env.RPC_URLS ?? "https://soroban-testnet.stellar.org").split(",");
const server = FallbackRpc.fromUrls(rpcUrls, {
  timeoutMs: 5000,
  onSwitch: (from, to) => console.log(`rpc: ${from} -> ${to}`),
});
const raw = new rpc.Server(rpcUrls.at(-1)!); // pollTransaction for the setup step
const passphrase = Networks.TESTNET;
const facilitator = Keypair.fromSecret(need("FACILITATOR_SECRET"));
const TOKEN = need("TOKEN_ID");
const PROXY = need("PROXY_ID");
const accounts = JSON.parse(readFileSync(need("CLIENTS_FILE"), "utf8"));
const clients: Keypair[] = accounts.clients.map((s: string) => Keypair.fromSecret(s));
const sellers: Keypair[] = accounts.sellers
  .map((s: string) => Keypair.fromSecret(s))
  .slice(0, Number(process.env.SELLERS ?? accounts.sellers.length));
const [nChannels = 5, nPayments = 20] = process.argv.slice(2).map(Number);

const addr = (a: string) => nativeToScVal(Address.fromString(a));
const invocation = (
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
) =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    subInvocations: subs,
  });

async function settleCall(client: Keypair, to: string, expLedger: number) {
  const max = 10_000_000n;
  const actual = 1n + BigInt(randomBytes(2).readUInt16BE());
  const nonce = randomBytes(32);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const [validAfter, deadline] = [now - 60n, now + 900n];
  const signed = [
    addr(TOKEN),
    addr(to),
    addr(facilitator.publicKey()),
    nativeToScVal(max, { type: "i128" }),
    xdr.ScVal.scvBytes(nonce),
    nativeToScVal(validAfter, { type: "u64" }),
    nativeToScVal(deadline, { type: "u64" }),
  ];
  const approve = invocation(TOKEN, "approve", [
    addr(client.publicKey()),
    addr(PROXY),
    nativeToScVal(max, { type: "i128" }),
    nativeToScVal(expLedger, { type: "u32" }),
  ]);
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(client.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString(randomBytes(8).readBigInt64BE().toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation(PROXY, "settle_upto", signed, [approve]),
  });
  const clientAuth = await authorizeEntry(entry, client, expLedger, passphrase);
  const args = [
    addr(TOKEN),
    addr(client.publicKey()),
    addr(to),
    addr(facilitator.publicKey()),
    nativeToScVal(max, { type: "i128" }),
    nativeToScVal(actual, { type: "i128" }),
    xdr.ScVal.scvBytes(nonce),
    nativeToScVal(validAfter, { type: "u64" }),
    nativeToScVal(deadline, { type: "u64" }),
    nativeToScVal(expLedger, { type: "u32" }),
  ];
  const facAuth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation(PROXY, "settle_upto", args),
  });
  return {
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(PROXY).toScAddress(),
        functionName: "settle_upto",
        args,
      }),
    ),
    auth: [clientAuth, facAuth],
  };
}

// 1. Create delegated channels (master key disabled; the secrets are dropped afterwards).
const channelsFile = process.env.CHANNELS_FILE;
const known: string[] =
  channelsFile && existsSync(channelsFile) ? JSON.parse(readFileSync(channelsFile, "utf8")) : [];
const fresh = Array.from({ length: Math.max(0, nChannels - known.length) }, () => Keypair.random());
for (let i = 0; i < fresh.length; i += MAX_CHANNELS_PER_TX) {
  const batch = fresh.slice(i, i + MAX_CHANNELS_PER_TX);
  const setupTx = buildCreateChannelsTx({
    facilitator: await server.getAccount(facilitator.publicKey()),
    channels: batch,
    networkPassphrase: passphrase,
    fee: 1000,
  });
  setupTx.sign(facilitator, ...batch);
  const sent = await raw.sendTransaction(setupTx);
  const created = await raw.pollTransaction(sent.hash, { attempts: 30 });
  console.log(`setup ${sent.hash} ${created.status}`);
}
if (channelsFile && fresh.length > 0)
  writeFileSync(channelsFile, JSON.stringify([...known, ...fresh.map((k) => k.publicKey())]));
const channels = [...known, ...fresh.map((k) => k.publicKey())].slice(0, nChannels);
for (const c of channels) {
  const problem = await checkChannel(server, c, facilitator.publicKey());
  if (problem) throw new Error(`${c}: ${problem}`);
}
console.log(`${channels.length} channels ok (facilitator is the only signer)`);

// 2. Settle payments through the submitter.
const submitter = new SettlementSubmitter({
  rpc: server,
  networkPassphrase: passphrase,
  signer: keypairSigner(facilitator),
  channels,
  inclusionFee: feeStatsInclusionFee(server),
  timeoutSeconds: 60,
  pipeline: process.env.PIPELINE !== "0",
  pollIntervalMs: Number(process.env.POLL_MS ?? 1000),
  feeEscalation: process.env.FEE_MAX ? { max: Number(process.env.FEE_MAX) } : undefined,
});
const expLedger = (await server.getLatestLedger()).sequence + 200;
const t0 = Date.now();
const outcomes = await Promise.allSettled(
  Array.from({ length: nPayments }, async (_, i) =>
    submitter.submit(
      await settleCall(
        clients[i % clients.length]!,
        sellers[i % sellers.length]!.publicKey(),
        expLedger,
      ),
    ),
  ),
);
const wall = (Date.now() - t0) / 1000;
// A refused submission (an error before anything was sent) is counted, not fatal.
const results = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
const refusals = outcomes.flatMap((o) =>
  o.status === "rejected" ? [o.reason instanceof Error ? o.reason.message : String(o.reason)] : [],
);
const byStatus: Record<string, number> = {};
const perLedger: Record<string, number> = {};
for (const r of results) {
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  if (r.ledger) perLedger[r.ledger] = (perLedger[r.ledger] ?? 0) + 1;
}
// Per-channel cycle: ledgers between a channel's consecutive landings (1 = every ledger).
const landings: Record<string, number[]> = {};
for (const r of results) if (r.ledger) (landings[r.channel] ??= []).push(r.ledger);
const cycleGaps: Record<string, number> = {};
for (const ls of Object.values(landings)) {
  ls.sort((a, b) => a - b);
  for (let i = 1; i < ls.length; i++) {
    const gap = ls[i]! - ls[i - 1]!;
    cycleGaps[gap] = (cycleGaps[gap] ?? 0) + 1;
  }
}
const ledgers = Object.keys(perLedger).map(Number);
const first = Math.min(...ledgers);
const last = Math.max(...ledgers);
const span = ledgers.length ? last - first + 1 : 0;
// Steady state: the ledgers between the first (ramp-up) and the last (tail), empty ones included.
const steady = Array.from(
  { length: Math.max(0, span - 2) },
  (_, i) => perLedger[first + 1 + i] ?? 0,
);
const settled = results.filter((r) => r.feeCharged !== undefined);
const feeAvg = settled.length
  ? Number(settled.reduce((sum, r) => sum + r.feeCharged!, 0n)) / settled.length
  : 0;

// Everyone's Soroban use of the same ledgers, next to ours (envelope XDR bytes; the limit is
// 266,240 per ledger, counted slightly differently by the network, so the share is approximate).
const network: { ledger: number; ours: number; soroban: number; bytesPct: number }[] = [];
for (let start = first; ledgers.length && start <= last;) {
  const page = await raw.getLedgers({
    startLedger: start,
    pagination: { limit: Math.min(20, last - start + 1) },
  });
  for (const l of page.ledgers) {
    if (l.sequence > last) break;
    const meta = l.metadataXdr;
    const body = meta.switch() === 2 ? meta.v2() : meta.v1();
    let soroban = 0;
    let bytes = 0;
    for (const phase of body.txSet().v1TxSet().phases()) {
      if (phase.switch() !== 1) continue; // phase 0 holds classic transactions
      for (const stage of phase.parallelTxsComponent().executionStages())
        for (const cluster of stage)
          for (const env of cluster) {
            soroban++;
            bytes += env.toXDR().length;
          }
    }
    network.push({
      ledger: l.sequence,
      ours: perLedger[l.sequence] ?? 0,
      soroban,
      bytesPct: Math.round((bytes / 266_240) * 100),
    });
  }
  if (page.ledgers.length === 0) break;
  start = page.ledgers.at(-1)!.sequence + 1;
}
console.log(
  JSON.stringify(
    {
      channels: nChannels,
      sellers: sellers.length,
      pipeline: process.env.PIPELINE !== "0",
      pollMs: Number(process.env.POLL_MS ?? 1000),
      feeMax: process.env.FEE_MAX ? Number(process.env.FEE_MAX) : null,
      payments: nPayments,
      wallSeconds: wall,
      byStatus,
      perLedger,
      ledgerSpan: span,
      meanPerLedger: span ? (byStatus.success ?? 0) / span : 0,
      steadyMeanPerLedger: steady.length ? steady.reduce((a, b) => a + b, 0) / steady.length : null,
      cycleGaps,
      feeAvgStroops: Math.round(feeAvg),
      network,
      sample: results
        .slice(0, 3)
        .map((r) => ({ hash: r.hash, status: r.status, fee: String(r.feeCharged) })),
      failures: results.filter((r) => r.status !== "success"),
      refusals,
      stats: submitter.stats(),
      rpcActive: server.active,
      facilitatorBalance: await checkFacilitatorBalance(server, facilitator.publicKey()),
    },
    (_k, v) => (typeof v === "bigint" ? String(v) : v),
    2,
  ),
);
