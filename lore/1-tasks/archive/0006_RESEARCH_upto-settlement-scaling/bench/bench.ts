// Testnet load bench for task 0006. It settles `upto` payments through the deployed UptoProxy
// and measures fee, size, inclusion latency, throughput and parallel-execution placement.
//
// The client side builds and signs its auth entry locally (no simulation); the facilitator
// side does what a production facilitator would: simulate, assemble, sign, submit, poll.
//
// Env: FACILITATOR_SECRET, ISSUER_SECRET, TOKEN_ID, PROXY_ID, [RPC_URL], [INCLUSION_FEE]
// Generated accounts (secrets) live in ./secrets/, which the repo .gitignore excludes.
//
// Commands:
//   setup <clients> <sellers> <channels>    create and fund accounts (idempotent, tops up)
//   delegate <n>                            add the facilitator as a signer on the first <n> channels
//   shapes                                  one settlement per transaction shape
//   burst <count>                           <count> settlements from one source account, no waiting
//   run <channels> <count> <shape> <sellers>  pool run; sellers = one | many
//   verify <count>                          /verify-style simulation latency
//   placement <results.json>                parallel-execution placement of our transactions
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  FeeBumpTransaction,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const server = new rpc.Server(RPC_URL);
const passphrase = Networks.TESTNET;
const facilitator = Keypair.fromSecret(need("FACILITATOR_SECRET"));
const issuer = Keypair.fromSecret(need("ISSUER_SECRET"));
const TOKEN = need("TOKEN_ID");
const PROXY = need("PROXY_ID");
const ASSET = new Asset("UPSPIKE", issuer.publicKey());
const UNIT = 10_000_000n;
const INCLUSION_FEE = process.env.INCLUSION_FEE ?? "100";
const STATE = "secrets/accounts.json";

type Accounts = { clients: string[]; sellers: string[]; channels: string[] };

function loadAccounts(): { clients: Keypair[]; sellers: Keypair[]; channels: Keypair[] } {
  const a: Accounts = existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, "utf8"))
    : { clients: [], sellers: [], channels: [] };
  const kp = (s: string[]) => s.map((x) => Keypair.fromSecret(x));
  return { clients: kp(a.clients), sellers: kp(a.sellers), channels: kp(a.channels) };
}

function saveAccounts(a: { clients: Keypair[]; sellers: Keypair[]; channels: Keypair[] }) {
  mkdirSync("secrets", { recursive: true });
  const s = (k: Keypair[]) => k.map((x) => x.secret());
  writeFileSync(
    STATE,
    JSON.stringify({ clients: s(a.clients), sellers: s(a.sellers), channels: s(a.channels) }, null, 2),
  );
}

const addr = (a: string) => nativeToScVal(Address.fromString(a));

// ---------------------------------------------------------------------------------------------
// Setup: create accounts with createAccount, trustlines and minted tokens in classic batches.

async function submitClassic(ops: xdr.Operation[], signers: Keypair[]) {
  const src = await server.getAccount(facilitator.publicKey());
  const b = new TransactionBuilder(src, { fee: "1000", networkPassphrase: passphrase }).setTimeout(120);
  for (const op of ops) b.addOperation(op);
  const tx = b.build();
  tx.sign(facilitator, ...signers);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`setup send ${sent.status} ${JSON.stringify(sent.errorResult)}`);
  const res = await server.pollTransaction(sent.hash, { attempts: 60 });
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`setup tx ${sent.hash} ${res.status}`);
  console.log(`setup tx ${sent.hash} (${ops.length} ops)`);
}

async function setup(nClients: number, nSellers: number, nChannels: number) {
  const a = loadAccounts();
  const exists = async (k: Keypair) =>
    server.getAccount(k.publicKey()).then(
      () => true,
      () => false,
    );
  // Saved but never funded (an earlier setup failed) counts as new too.
  const grow = async (list: Keypair[], n: number) => {
    while (list.length < n) list.push(Keypair.random());
    const fresh: Keypair[] = [];
    for (const k of list) if (!(await exists(k))) fresh.push(k);
    return fresh;
  };
  const newClients = await grow(a.clients, nClients);
  const newSellers = await grow(a.sellers, nSellers);
  const newChannels = await grow(a.channels, nChannels);
  saveAccounts(a);

  // Each client: create (3 XLM), trust, mint 1,000 tokens = 3 ops. Each seller: create + trust.
  // Channels: create with 20 XLM (they pay their own fees when not fee-bumped).
  type Job = { ops: xdr.Operation[]; signers: Keypair[] };
  const jobs: Job[] = [];
  for (const c of newClients)
    jobs.push({
      ops: [
        Operation.createAccount({ destination: c.publicKey(), startingBalance: "3" }),
        Operation.changeTrust({ asset: ASSET, source: c.publicKey() }),
        Operation.payment({ destination: c.publicKey(), asset: ASSET, amount: "1000", source: issuer.publicKey() }),
      ],
      signers: [c, issuer],
    });
  for (const s of newSellers)
    jobs.push({
      ops: [
        Operation.createAccount({ destination: s.publicKey(), startingBalance: "3" }),
        Operation.changeTrust({ asset: ASSET, source: s.publicKey() }),
      ],
      signers: [s],
    });
  for (const ch of newChannels)
    jobs.push({
      ops: [Operation.createAccount({ destination: ch.publicKey(), startingBalance: "20" })],
      signers: [],
    });

  // Up to 99 ops and 19 extra signers per transaction (20 signatures max).
  let ops: xdr.Operation[] = [];
  let signers = new Map<string, Keypair>();
  for (const j of jobs) {
    const extra = j.signers.filter((s) => !signers.has(s.publicKey())).length;
    if (ops.length + j.ops.length > 99 || signers.size + extra > 19) {
      await submitClassic(ops, [...signers.values()]);
      ops = [];
      signers = new Map();
    }
    ops.push(...j.ops);
    for (const s of j.signers) signers.set(s.publicKey(), s);
  }
  if (ops.length) await submitClassic(ops, [...signers.values()]);
  console.log(`accounts: ${a.clients.length} clients, ${a.sellers.length} sellers, ${a.channels.length} channels`);
}

// ---------------------------------------------------------------------------------------------
// Settlement building.

type Shape =
  // facilitator is the tx source; its binding uses source-account credentials
  | "source"
  // channel is the tx source, the facilitator is the operation source (two tx signatures)
  | "opsource"
  // as opsource, wrapped in a fee bump paid by the facilitator
  | "opsource-bump"
  // channel is the tx source, the facilitator signs an address-credential auth entry (spike S8)
  | "addr"
  // as addr, wrapped in a fee bump paid by the facilitator
  | "addr-bump"
  // as opsource-bump, but the facilitator key is a signer on the channel, so its one signature
  // covers both accounts and the channel's own key is never used (see `delegate`)
  | "delegated-bump";

type Terms = {
  client: Keypair;
  to: string;
  max: bigint;
  actual: bigint;
  nonce: Buffer;
  validAfter: bigint;
  deadline: bigint;
  expLedger: number;
};

function proxyInvocation(fn: string, args: xdr.ScVal[], subs: xdr.SorobanAuthorizedInvocation[] = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({ contractAddress: Address.fromString(PROXY).toScAddress(), functionName: fn, args }),
    ),
    subInvocations: subs,
  });
}

function addressEntry(signer: string, root: xdr.SorobanAuthorizedInvocation) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer).toScAddress(),
        nonce: randomBytes(8).readBigInt64BE(),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
}

function settleArgs(t: Terms): xdr.ScVal[] {
  return [
    addr(TOKEN),
    addr(t.client.publicKey()),
    addr(t.to),
    addr(facilitator.publicKey()),
    nativeToScVal(t.max, { type: "i128" }),
    nativeToScVal(t.actual, { type: "i128" }),
    xdr.ScVal.scvBytes(t.nonce),
    nativeToScVal(t.validAfter, { type: "u64" }),
    nativeToScVal(t.deadline, { type: "u64" }),
    nativeToScVal(t.expLedger, { type: "u32" }),
  ];
}

/** Client: the entry `require_auth_for_args` + the `approve` sub-invocation expect (spec §3). */
async function clientEntry(t: Terms) {
  const signedArgs = [
    addr(TOKEN),
    addr(t.to),
    addr(facilitator.publicKey()),
    nativeToScVal(t.max, { type: "i128" }),
    xdr.ScVal.scvBytes(t.nonce),
    nativeToScVal(t.validAfter, { type: "u64" }),
    nativeToScVal(t.deadline, { type: "u64" }),
  ];
  const approve = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(TOKEN).toScAddress(),
        functionName: "approve",
        args: [
          addr(t.client.publicKey()),
          addr(PROXY),
          nativeToScVal(t.max, { type: "i128" }),
          nativeToScVal(t.expLedger, { type: "u32" }),
        ],
      }),
    ),
    subInvocations: [],
  });
  const entry = addressEntry(t.client.publicKey(), proxyInvocation("settle_upto", signedArgs, [approve]));
  return authorizeEntry(entry, t.client, t.expLedger, passphrase);
}

let latestLedger = 0;
let latestLedgerAt = 0;
async function currentLedger(): Promise<number> {
  if (Date.now() - latestLedgerAt > 4000) {
    latestLedger = (await server.getLatestLedger()).sequence;
    latestLedgerAt = Date.now();
  }
  return latestLedger;
}

async function newTerms(client: Keypair, to: string): Promise<Terms> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    client,
    to,
    max: 1n * UNIT,
    actual: 1n + BigInt(randomBytes(2).readUInt16BE()), // a few stroops
    nonce: randomBytes(32),
    validAfter: now - 60n,
    deadline: now + 900n,
    expLedger: (await currentLedger()) + 200,
  };
}

type Resources = { instructions: number; diskReadBytes: number; writeBytes: number; readOnly: number; readWrite: number };
type Built = { envelope: Transaction | FeeBumpTransaction; simMs: number; resourceFee: string; resources: Resources };

/** Facilitator: build, simulate (enforcing auth), assemble and sign one settlement. */
async function buildSettlement(t: Terms, shape: Shape, source: Account, channel?: Keypair): Promise<Built> {
  const args = settleArgs(t);
  const root = proxyInvocation("settle_upto", args);
  const signedClient = await clientEntry(t);
  const usesAddr = shape === "addr" || shape === "addr-bump";
  const facAuth = usesAddr
    ? await authorizeEntry(addressEntry(facilitator.publicKey(), root), facilitator, t.expLedger, passphrase)
    : new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: root,
      });
  const op = Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(PROXY).toScAddress(),
        functionName: "settle_upto",
        args,
      }),
    ),
    auth: [signedClient, facAuth],
    ...(shape.startsWith("opsource") || shape === "delegated-bump" ? { source: facilitator.publicKey() } : {}),
  });
  let tx = new TransactionBuilder(source, { fee: INCLUSION_FEE, networkPassphrase: passphrase })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const t0 = performance.now();
  const sim = await server.simulateTransaction(tx);
  const simMs = performance.now() - t0;
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`simulation failed: ${rpc.Api.isSimulationError(sim) ? firstLine(sim.error) : "restore"}`);
  }
  tx = rpc.assembleTransaction(tx, sim).build();
  const signers =
    shape === "source" || shape === "delegated-bump"
      ? [facilitator]
      : shape.startsWith("opsource")
        ? [channel!, facilitator]
        : [channel!];
  tx.sign(...signers);
  const resourceFee = sim.minResourceFee;
  const r = sim.transactionData.build().resources;
  const resources = {
    instructions: r.instructions,
    diskReadBytes: r.diskReadBytes,
    writeBytes: r.writeBytes,
    readOnly: r.footprint.readOnly.length,
    readWrite: r.footprint.readWrite.length,
  };
  if (!shape.endsWith("-bump")) return { envelope: tx, simMs, resourceFee, resources };
  const bump = TransactionBuilder.buildFeeBumpTransaction(facilitator, INCLUSION_FEE, tx, passphrase);
  bump.sign(facilitator);
  return { envelope: bump, simMs, resourceFee, resources };
}

function errorName(e: unknown): string | undefined {
  if (!e) return undefined;
  const s = JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const m = s.match(/"(tx_[a-z_]+|txFeeBump[A-Za-z]+|tx[A-Z][A-Za-z]+)"/);
  return m ? m[1] : s.slice(0, 120);
}

function firstLine(s: string): string {
  const m = s.match(/Error\(Contract, #\d+\)|Error\(Auth, \w+\)|Error\([A-Za-z]+, \w+\)/);
  return m ? m[0] : s.split("\n")[0].slice(0, 160);
}

type Outcome = {
  shape: Shape;
  source: string;
  client: string;
  seller: string;
  hash?: string;
  sendStatus?: string;
  status?: string;
  ledger?: number;
  feeCharged?: string;
  resourceFee?: string;
  resources?: Resources;
  sizeBytes?: number;
  simMs?: number;
  submitMs?: number; // send -> final status
  error?: string;
};

async function submit(b: Built, o: Outcome): Promise<Outcome> {
  o.sizeBytes = b.envelope.toEnvelope().toXDR().length;
  o.simMs = Math.round(b.simMs);
  o.resourceFee = b.resourceFee;
  o.resources = b.resources;
  const t0 = performance.now();
  const sent = await server.sendTransaction(b.envelope);
  o.hash = sent.hash;
  o.sendStatus = sent.status;
  if (sent.status !== "PENDING") {
    o.error = errorName(sent.errorResult);
    o.submitMs = Math.round(performance.now() - t0);
    return o;
  }
  const res = await server.pollTransaction(sent.hash, {
    attempts: 120,
    sleepStrategy: () => 500,
  });
  o.submitMs = Math.round(performance.now() - t0);
  o.status = res.status;
  if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
    o.ledger = res.ledger;
    if ("resultXdr" in res && res.resultXdr) o.feeCharged = String(res.resultXdr.feeCharged);
  }
  return o;
}

function save(name: string, data: unknown) {
  mkdirSync("results", { recursive: true });
  const file = `results/${name}.json`;
  writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`wrote ${file}`);
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
}

// ---------------------------------------------------------------------------------------------
// shapes: one settlement per shape, to compare fee and size.

async function shapes() {
  const a = loadAccounts();
  const out: Outcome[] = [];
  const all: Shape[] = ["source", "opsource", "opsource-bump", "addr", "addr-bump", "delegated-bump"];
  for (const [i, shape] of all.entries()) {
    const channel = a.channels[i];
    const src = shape === "source" ? facilitator : channel;
    const account = await server.getAccount(src.publicKey());
    const t = await newTerms(a.clients[i], a.sellers[0].publicKey());
    const o: Outcome = { shape, source: src.publicKey(), client: t.client.publicKey(), seller: t.to };
    try {
      await submit(await buildSettlement(t, shape, account, channel), o);
    } catch (e) {
      o.error = String(e);
    }
    out.push(o);
    console.log(JSON.stringify(o));
  }
  save("shapes", { ranAt: new Date().toISOString(), rpc: RPC_URL, inclusionFee: INCLUSION_FEE, results: out });
}

// ---------------------------------------------------------------------------------------------
// delegate: add the facilitator key as a signer (weight 1) on the first <n> channels.

async function delegate(n: number) {
  const a = loadAccounts();
  // Skip channels that already have it: the channel's own signature would then be extra.
  const todo: Keypair[] = [];
  for (const ch of a.channels.slice(0, n)) {
    const entry = await server.getAccountEntry(ch.publicKey());
    if (entry.signers.length === 0) todo.push(ch);
  }
  for (let i = 0; i < todo.length; i += 19) {
    const batch = todo.slice(i, i + 19);
    const ops = batch.map((ch) =>
      Operation.setOptions({ source: ch.publicKey(), signer: { ed25519PublicKey: facilitator.publicKey(), weight: 1 } }),
    );
    await submitClassic(ops, batch);
  }
  console.log(`delegated ${todo.length} channels`);
}

// ---------------------------------------------------------------------------------------------
// burst: many settlements from ONE source account without waiting between them.

async function burst(count: number) {
  const a = loadAccounts();
  const account = await server.getAccount(facilitator.publicKey());
  const built: { b: Built; o: Outcome }[] = [];
  for (let i = 0; i < count; i++) {
    const t = await newTerms(a.clients[i % a.clients.length], a.sellers[i % a.sellers.length].publicKey());
    const o: Outcome = { shape: "source", source: facilitator.publicKey(), client: t.client.publicKey(), seller: t.to };
    built.push({ b: await buildSettlement(t, "source", account), o });
  }
  // Send all in sequence-number order as fast as possible, then poll.
  const t0 = Date.now();
  const sent = [];
  for (const { b, o } of built) {
    o.sizeBytes = b.envelope.toEnvelope().toXDR().length;
    const r = await server.sendTransaction(b.envelope);
    o.hash = r.hash;
    o.sendStatus = r.status;
    if (r.errorResult) o.error = errorName(r.errorResult);
    sent.push(o);
  }
  const sendMs = Date.now() - t0;
  for (const o of sent) {
    if (o.sendStatus !== "PENDING") continue;
    const res = await server.pollTransaction(o.hash!, { attempts: 120, sleepStrategy: () => 1000 });
    o.status = res.status;
    if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) o.ledger = res.ledger;
  }
  const ok = sent.filter((o) => o.status === "SUCCESS");
  const ledgers = [...new Set(ok.map((o) => o.ledger!))].sort();
  const summary = {
    count,
    sendMs,
    sendStatuses: tally(sent.map((o) => o.sendStatus ?? "?")),
    finalStatuses: tally(sent.map((o) => o.status ?? "not sent")),
    perLedger: tally(ok.map((o) => String(o.ledger))),
    ledgerSpan: ledgers.length ? ledgers.at(-1)! - ledgers[0] + 1 : 0,
  };
  console.log(summary);
  save(`burst-${count}`, { ranAt: new Date().toISOString(), rpc: RPC_URL, summary, results: sent });
}

function tally(xs: string[]) {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

// ---------------------------------------------------------------------------------------------
// run: a pool of channel accounts, one transaction in flight per channel.

async function run(nChannels: number, count: number, shape: Shape, sellers: "one" | "many") {
  const a = loadAccounts();
  if (a.channels.length < nChannels) throw new Error(`only ${a.channels.length} channels; run setup`);
  // Clients are partitioned per channel so no client has two settlements in flight.
  const clientsPer = Math.floor(a.clients.length / nChannels);
  if (clientsPer < 1) throw new Error("need at least one client per channel");
  const channels = a.channels.slice(0, nChannels);
  const accounts = await Promise.all(channels.map((c) => server.getAccount(c.publicKey())));
  const outcomes: Outcome[] = [];
  let next = 0;
  const t0 = Date.now();
  await currentLedger();
  const startLedger = latestLedger;

  async function worker(w: number) {
    let k = 0;
    while (next < count) {
      const i = next++;
      const client = a.clients[w * clientsPer + (k++ % clientsPer)];
      const seller = sellers === "one" ? a.sellers[0] : a.sellers[i % a.sellers.length];
      const t = await newTerms(client, seller.publicKey());
      const o: Outcome = { shape, source: channels[w].publicKey(), client: client.publicKey(), seller: t.to };
      try {
        await submit(await buildSettlement(t, shape, accounts[w], channels[w]), o);
        if (o.sendStatus !== "PENDING") accounts[w] = await server.getAccount(channels[w].publicKey());
      } catch (e) {
        o.error = String(e).slice(0, 200);
        accounts[w] = await server.getAccount(channels[w].publicKey());
      }
      outcomes.push(o);
      if (o.status !== "SUCCESS") console.log(`! ${JSON.stringify(o)}`);
    }
  }
  await Promise.all(channels.map((_, w) => worker(w)));
  const wallMs = Date.now() - t0;
  const ok = outcomes.filter((o) => o.status === "SUCCESS");
  const ledgers = ok.map((o) => o.ledger!);
  const first = Math.min(...ledgers);
  const last = Math.max(...ledgers);
  const perLedger = tally(ok.map((o) => String(o.ledger)));
  const summary = {
    channels: nChannels,
    count,
    shape,
    sellers,
    ok: ok.length,
    failed: outcomes.length - ok.length,
    failures: tally(outcomes.filter((o) => o.status !== "SUCCESS").map((o) => o.error ?? o.status ?? o.sendStatus ?? "?")),
    wallSeconds: wallMs / 1000,
    settlementsPerSecond: +(ok.length / (wallMs / 1000)).toFixed(2),
    startLedger,
    firstLedger: first,
    lastLedger: last,
    perLedgerMax: Math.max(...Object.values(perLedger)),
    perLedgerMean: +(ok.length / (last - first + 1)).toFixed(2),
    simMs: { p50: pct(ok.map((o) => o.simMs!), 50), p95: pct(ok.map((o) => o.simMs!), 95) },
    submitMs: { p50: pct(ok.map((o) => o.submitMs!), 50), p95: pct(ok.map((o) => o.submitMs!), 95) },
    feeCharged: { p50: pct(ok.map((o) => Number(o.feeCharged)), 50), max: Math.max(...ok.map((o) => Number(o.feeCharged))) },
    sizeBytes: { p50: pct(ok.map((o) => o.sizeBytes!), 50) },
  };
  console.log(summary);
  save(`run-${shape}-c${nChannels}-n${count}-${sellers}`, { ranAt: new Date().toISOString(), rpc: RPC_URL, summary, perLedger, results: outcomes });
}

// ---------------------------------------------------------------------------------------------
// verify: what a /verify costs the facilitator. Each request is a full enforcing simulation of
// a fresh payment (signature check included), never submitted.

async function verify(count: number, concurrency = 1) {
  const a = loadAccounts();
  const account = await server.getAccount(facilitator.publicKey());
  const lat: number[] = [];
  const errors: string[] = [];
  let next = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < count) {
      const i = next++;
      const src = new Account(account.accountId(), account.sequenceNumber());
      try {
        const t = await newTerms(a.clients[i % a.clients.length], a.sellers[i % a.sellers.length].publicKey());
        const b = await buildSettlement(t, "source", src);
        lat.push(b.simMs);
      } catch (e) {
        errors.push(String(e).slice(0, 120));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = Date.now() - t0;
  const summary = {
    count,
    concurrency,
    ok: lat.length,
    errors: tally(errors),
    simMs: { p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), max: Math.round(Math.max(...lat)) },
    simulationsPerSecond: +(lat.length / (wallMs / 1000)).toFixed(2),
  };
  console.log(summary);
  save(`verify-n${count}-c${concurrency}`, { ranAt: new Date().toISOString(), rpc: RPC_URL, summary });
}

// ---------------------------------------------------------------------------------------------
// ledgers: where our transactions sat in the parallel Soroban phase (CAP-63).

function envelopeHash(env: xdr.TransactionEnvelope): string {
  return Buffer.from(TransactionBuilder.fromXDR(env, passphrase).hash()).toString("hex");
}

/* eslint-disable @typescript-eslint/no-explicit-any -- walking generated XDR objects */
async function ledgers(from: number, to: number, ours: Set<string>) {
  const out = [];
  for (let seq = from; seq <= to; seq++) {
    const res = await server.getLedgers({ startLedger: seq, pagination: { limit: 1 } });
    const meta: any = res.ledgers[0].metadataXdr;
    const body = meta.v2 ?? meta.v1;
    let classic = 0;
    let soroban = 0;
    const stages: { size: number; ours: number }[][] = [];
    for (const phase of (body.txSet.v1 ?? body.txSet.v1TxSet).phases) {
      if (phase.v0Components) {
        for (const comp of phase.v0Components) classic += comp.txsMaybeDiscountedFee.txs.length;
      } else {
        for (const stage of phase.parallelTxsComponent.executionStages) {
          stages.push(
            stage.map((cluster: any[]) => {
              soroban += cluster.length;
              return { size: cluster.length, ours: cluster.filter((e) => ours.has(envelopeHash(e))).length };
            }),
          );
        }
      }
    }
    const row = { ledger: seq, classicTxs: classic, sorobanTxs: soroban, stages };
    out.push(row);
    console.log(JSON.stringify(row));
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function ledgersCmd(file: string) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const ok = (data.results as Outcome[]).filter((o) => o.status === "SUCCESS");
  const ours = new Set(ok.map((o) => o.hash!));
  const ls = ok.map((o) => o.ledger!);
  const rows = await ledgers(Math.min(...ls), Math.max(...ls), ours);
  data.placement = rows;
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`placement added to ${file}`);
}

// ---------------------------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "setup":
    await setup(Number(rest[0]), Number(rest[1]), Number(rest[2]));
    break;
  case "shapes":
    await shapes();
    break;
  case "delegate":
    await delegate(Number(rest[0]));
    break;
  case "burst":
    await burst(Number(rest[0]));
    break;
  case "run":
    await run(Number(rest[0]), Number(rest[1]), rest[2] as Shape, (rest[3] ?? "many") as "one" | "many");
    break;
  case "verify":
    await verify(Number(rest[0]), Number(rest[1] ?? 1));
    break;
  case "placement":
    await ledgersCmd(rest[0]);
    break;
  default:
    console.log("commands: setup | shapes | burst | run | verify | placement");
}
