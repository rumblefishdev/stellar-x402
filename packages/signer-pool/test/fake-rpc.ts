import {
  Account,
  FeeBumpTransaction,
  Keypair,
  SorobanDataBuilder,
  Transaction,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { SorobanRpc } from "../src/types.js";

type SendScript = "PENDING" | "TRY_AGAIN_LATER" | "ERROR_INSUFFICIENT_FEE" | "THROW";
type StatusScript = "THROW";

/**
 * An in-memory stand-in for Soroban RPC with the rules the submitter depends on:
 * - a transaction's sequence must be the source account's sequence + 1 (else `txBadSeq`);
 * - at most one pending transaction per source account (else `TRY_AGAIN_LATER`);
 * - each `getLatestLedger` call closes one ledger, which includes every pending transaction
 *   whose time bound has not passed, and advances the close time by `ledgerSeconds`.
 */
export class FakeRpc implements SorobanRpc {
  ledger = 100;
  closeTime = 1_000_000;
  readonly ledgerSeconds = 5;
  readonly sequences = new Map<string, bigint>();
  readonly sent: (Transaction | FeeBumpTransaction)[] = [];
  readonly calls: Record<string, number> = {};
  private pending = new Map<string, { source: string; seq: bigint; maxTime: number }>();
  private done = new Map<string, { ledger: number; ok: boolean }>();
  /** Scripted results, consumed one per call before the default behaviour. */
  sendScript: SendScript[] = [];
  statusScript: StatusScript[] = [];
  simulation: "ok" | "error" | "restore" = "ok";
  resourceFee = 40_000;
  /** Every included transaction fails on-chain (still consuming its sequence number). */
  failOnChain = false;
  /** Stops including transactions (simulates a full or stalled network). */
  stalled = false;

  constructor(accounts: Record<string, bigint>) {
    for (const [k, v] of Object.entries(accounts)) this.sequences.set(k, v);
  }

  private count(name: string) {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  async getAccount(address: string): Promise<Account> {
    this.count("getAccount");
    const seq = this.sequences.get(address);
    if (seq === undefined) throw new Error(`account ${address} not found`);
    return new Account(address, seq.toString());
  }

  async getAccountEntry(): Promise<xdr.AccountEntry> {
    throw new Error("not used");
  }

  async getFeeStats(): Promise<rpc.Api.GetFeeStatsResponse> {
    throw new Error("not used");
  }

  async simulateTransaction(): Promise<rpc.Api.SimulateTransactionResponse> {
    this.count("simulateTransaction");
    if (this.simulation === "error")
      return rpc.parseRawSimulation({
        id: "1",
        latestLedger: this.ledger,
        error: "HostError: boom",
      });
    const data = new SorobanDataBuilder().setResourceFee(this.resourceFee).build();
    const raw: rpc.Api.RawSimulateTransactionResponse = {
      id: "1",
      latestLedger: this.ledger,
      minResourceFee: String(this.resourceFee),
      transactionData: data.toXDR("base64"),
      results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
    };
    if (this.simulation === "restore")
      raw.restorePreamble = { minResourceFee: "1", transactionData: data.toXDR("base64") };
    return rpc.parseRawSimulation(raw);
  }

  async sendTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    this.count("sendTransaction");
    this.sent.push(tx);
    const hash = tx.hash().toString("hex");
    const base = { hash, latestLedger: this.ledger, latestLedgerCloseTime: this.closeTime };
    const script = this.sendScript.shift();
    if (script === "THROW") throw new Error("network down");
    if (script === "TRY_AGAIN_LATER") return { ...base, status: "TRY_AGAIN_LATER" };
    if (script === "ERROR_INSUFFICIENT_FEE")
      return { ...base, status: "ERROR", errorResult: result("txInsufficientFee") };
    if (this.pending.has(hash) || this.done.has(hash)) return { ...base, status: "DUPLICATE" };
    const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
    const seq = BigInt(inner.sequence);
    const current = this.sequences.get(inner.source);
    if ([...this.pending.values()].some((p) => p.source === inner.source))
      return { ...base, status: "TRY_AGAIN_LATER" };
    if (current === undefined || seq !== current + 1n)
      return { ...base, status: "ERROR", errorResult: result("txBadSeq", true) };
    const maxTime = Number(inner.timeBounds?.maxTime ?? 0);
    this.pending.set(hash, { source: inner.source, seq, maxTime });
    return { ...base, status: "PENDING" };
  }

  async getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    this.count("getTransaction");
    if (this.statusScript.shift() === "THROW") throw new Error("fetch failed");
    const base = {
      txHash: hash,
      latestLedger: this.ledger,
      latestLedgerCloseTime: this.closeTime,
      oldestLedger: 1,
      oldestLedgerCloseTime: 1,
    };
    const d = this.done.get(hash);
    if (!d) return { ...base, status: rpc.Api.GetTransactionStatus.NOT_FOUND };
    const status = d.ok
      ? rpc.Api.GetTransactionStatus.SUCCESS
      : rpc.Api.GetTransactionStatus.FAILED;
    return {
      ...base,
      status,
      ledger: d.ledger,
      createdAt: this.closeTime,
      applicationOrder: 1,
      feeBump: true,
      envelopeXdr: undefined as unknown as xdr.TransactionEnvelope,
      resultXdr: d.ok ? result("txSuccess") : result("txFailed", true),
      resultMetaXdr: undefined as unknown as xdr.TransactionMeta,
      events: { transactionEventsXdr: [], contractEventsXdr: [] },
    } as rpc.Api.GetTransactionResponse;
  }

  async getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> {
    this.count("getLatestLedger");
    this.ledger += 1;
    this.closeTime += this.ledgerSeconds;
    if (!this.stalled) {
      for (const [hash, p] of this.pending) {
        this.pending.delete(hash);
        if (p.maxTime !== 0 && this.closeTime > p.maxTime) continue; // expired, seq untouched
        this.sequences.set(p.source, p.seq);
        this.done.set(hash, { ledger: this.ledger, ok: !this.failOnChain });
      }
    } else {
      for (const [hash, p] of this.pending)
        if (p.maxTime !== 0 && this.closeTime > p.maxTime) this.pending.delete(hash);
    }
    return {
      id: String(this.ledger),
      sequence: this.ledger,
      protocolVersion: "29",
      closeTime: String(this.closeTime),
    } as rpc.Api.GetLatestLedgerResponse;
  }
}

/** A transaction result with the given code; `inner` wraps it as a failed fee bump. */
function result(code: string, inner = false): xdr.TransactionResult {
  const fee = xdr.Int64.fromString("41000");
  const make = (c: string) =>
    (
      xdr.TransactionResultResult as unknown as Record<
        string,
        (v?: unknown) => xdr.TransactionResultResult
      >
    )[c]!(c === "txSuccess" || c === "txFailed" ? [] : undefined);
  if (!inner)
    return new xdr.TransactionResult({
      feeCharged: fee,
      result: make(code),
      ext: new xdr.TransactionResultExt(0),
    });
  const innerCode = (
    xdr.InnerTransactionResultResult as unknown as Record<
      string,
      (v?: unknown) => xdr.InnerTransactionResultResult
    >
  )[code]!(code === "txFailed" ? [] : undefined);
  const pair = new xdr.InnerTransactionResultPair({
    transactionHash: Buffer.alloc(32),
    result: new xdr.InnerTransactionResult({
      feeCharged: fee,
      result: innerCode,
      ext: new xdr.InnerTransactionResultExt(0),
    }),
  });
  return new xdr.TransactionResult({
    feeCharged: fee,
    result: xdr.TransactionResultResult.txFeeBumpInnerFailed(pair),
    ext: new xdr.TransactionResultExt(0),
  });
}

export const facilitator = Keypair.random();
export const channelKeys = [Keypair.random(), Keypair.random(), Keypair.random()];
export const channels = channelKeys.map((k) => k.publicKey());
