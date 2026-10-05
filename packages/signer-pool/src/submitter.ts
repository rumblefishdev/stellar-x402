import {
  Account,
  FeeBumpTransaction,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { ChannelPool, type Channel } from "./channel-pool.js";
import { LedgerClock } from "./ledger-clock.js";
import {
  SubmitterStats,
  type RefusalReason,
  type SubmitterEvent,
  type SubmitterStatsSnapshot,
} from "./stats.js";
import type { SorobanRpc, SubmitResult, TransactionSigner } from "./types.js";

export interface SubmitterOptions {
  rpc: SorobanRpc;
  networkPassphrase: string;
  /**
   * The facilitator. It is the operation source of every call (so contract `require_auth` on its
   * address uses source-account credentials), a signer on every channel, and the fee-bump payer.
   */
  signer: TransactionSigner;
  /** Channel account addresses. Each must list `signer.address` as a signer. */
  channels: readonly string[];
  /** Inclusion fee bid in stroops, or a provider such as {@link feeStatsInclusionFee}. */
  inclusionFee?: number | (() => Promise<number>);
  /**
   * Upper bound on the total fee in stroops (resource fee plus inclusion fees). Simulations
   * above it are refused before signing. 0006 measured ~41,000 per settlement and 151,550 for
   * one that also paid a TTL extension.
   */
  maxFeeStroops?: number;
  /** Time bound of each transaction, in seconds from build. */
  timeoutSeconds?: number;
  /** How often the shared ledger clock polls `getLatestLedger`. */
  pollIntervalMs?: number;
  /** Receives every submitter event, for metrics and logs. Must not throw (errors are ignored). */
  onEvent?: (event: SubmitterEvent) => void;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The contract call to submit. The submitter sets the facilitator as its operation source. */
export interface ContractCall {
  func: xdr.HostFunction;
  auth: xdr.SorobanAuthorizationEntry[];
}

export interface SubmitOptions {
  /**
   * Inspects the simulation before anything is signed; throw to abort. Schemes put their
   * balance-change checks here (architecture doc §3.2).
   */
  checkSimulation?: (sim: rpc.Api.SimulateTransactionSuccessResponse) => void | Promise<void>;
  /** Called once the network accepts the transaction (`PENDING`), before it is final. */
  onSent?: (hash: string) => void;
}

/** Simulation failed or needs a restore; nothing was signed or sent. */
export class SimulationError extends Error {
  override readonly name = "SimulationError";
}

/** The caller's `checkSimulation` refused the simulation; nothing was signed or sent. */
export class SimulationCheckError extends Error {
  override readonly name = "SimulationCheckError";
}

/** The simulated fee is above `maxFeeStroops`; nothing was signed or sent. */
export class FeeLimitError extends Error {
  override readonly name = "FeeLimitError";
}

const BAD_SEQ = new Set(["txBadSeq"]);

/**
 * Submits Soroban contract calls through a pool of channel accounts, one transaction in flight
 * per channel, in the shape 0006 measured as cheapest ("delegated-bump"):
 *
 * - tx source: a channel (sequence number only);
 * - operation source: the facilitator;
 * - one facilitator signature covers both, because the facilitator is a signer on the channel;
 * - wrapped in a fee bump the facilitator pays, so channels hold only their reserve.
 *
 * Sequence rule: a channel's cached sequence number is advanced only when its transaction is
 * final, and dropped (re-read before next use) only when the network says it is wrong. It is
 * never re-read while a transaction may still be pending, even if status checks fail.
 */
export class SettlementSubmitter {
  readonly pool: ChannelPool;
  private readonly clock: LedgerClock;
  private readonly rpc: SorobanRpc;
  private readonly signer: TransactionSigner;
  private readonly passphrase: string;
  private readonly inclusionFee: () => Promise<number>;
  private readonly maxFee: bigint;
  private readonly timeoutSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onEvent?: (event: SubmitterEvent) => void;
  private readonly statsCollector = new SubmitterStats();

  constructor(opts: SubmitterOptions) {
    this.rpc = opts.rpc;
    this.signer = opts.signer;
    this.passphrase = opts.networkPassphrase;
    this.pool = new ChannelPool(opts.channels);
    if (opts.channels.includes(opts.signer.address))
      throw new Error("the facilitator account cannot also be a channel");
    const fee = opts.inclusionFee ?? 100;
    this.inclusionFee = typeof fee === "number" ? async () => fee : fee;
    this.maxFee = BigInt(opts.maxFeeStroops ?? 250_000);
    this.timeoutSeconds = opts.timeoutSeconds ?? 60;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = new LedgerClock(this.rpc, this.pollIntervalMs, this.sleep);
    this.onEvent = opts.onEvent;
  }

  /** Waits for a free channel, then builds, simulates, signs, sends and confirms `call`. */
  async submit(call: ContractCall, opts: SubmitOptions = {}): Promise<SubmitResult> {
    const start = this.now();
    const channel = await this.pool.acquire();
    const acquired = this.now();
    try {
      const result = await this.submitOn(channel, call, opts);
      this.emit({
        type: "final",
        result,
        queuedMs: acquired - start,
        totalMs: this.now() - start,
      });
      return result;
    } catch (error) {
      this.emit({
        type: "refused",
        channel: channel.address,
        reason: refusalReason(error),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.pool.release(channel);
    }
  }

  /** Counters since construction, plus the pool's current load. */
  stats(): SubmitterStatsSnapshot {
    return this.statsCollector.snapshot({
      channels: this.pool.size,
      busy: this.pool.busy,
      queued: this.pool.queued,
    });
  }

  private emit(event: SubmitterEvent): void {
    this.statsCollector.record(event);
    try {
      this.onEvent?.(event);
    } catch {
      // A broken listener must not break settlement.
    }
  }

  private async submitOn(
    channel: Channel,
    call: ContractCall,
    opts: SubmitOptions,
  ): Promise<SubmitResult> {
    if (channel.sequence === undefined) {
      const account = await this.rpc.getAccount(channel.address);
      channel.sequence = BigInt(account.sequenceNumber());
    }
    const fee = await this.inclusionFee();
    const maxTime = Math.floor(this.now() / 1000) + this.timeoutSeconds;
    const draft = new TransactionBuilder(
      new Account(channel.address, channel.sequence.toString()),
      { fee: String(fee), networkPassphrase: this.passphrase, timebounds: { minTime: 0, maxTime } },
    )
      .addOperation(Operation.invokeHostFunction({ ...call, source: this.signer.address }))
      .build();
    const txSequence = BigInt(draft.sequence);

    const sim = await this.rpc.simulateTransaction(draft);
    if (rpc.Api.isSimulationError(sim)) throw new SimulationError(sim.error);
    if (rpc.Api.isSimulationRestore(sim))
      throw new SimulationError("archived entries need a restore before this call");
    if (!rpc.Api.isSimulationSuccess(sim))
      throw new SimulationError("unexpected simulation response");
    try {
      await opts.checkSimulation?.(sim);
    } catch (error) {
      throw new SimulationCheckError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    // Inner inclusion fee plus the fee bump's own (one operation + the bump).
    const total = BigInt(sim.minResourceFee) + 3n * BigInt(fee);
    if (total > this.maxFee)
      throw new FeeLimitError(`fee ${total} stroops is above the limit of ${this.maxFee}`);

    const inner = await this.sign(rpc.assembleTransaction(draft, sim).build());
    if (!(inner instanceof Transaction)) throw new Error("signer returned a fee bump");
    const bump = await this.sign(
      TransactionBuilder.buildFeeBumpTransaction(
        this.signer.address,
        String(fee),
        inner,
        this.passphrase,
      ),
    );
    const base = { channel: channel.address };
    const hash = bump.hash().toString("hex");
    const pastMaxTime = () => Math.floor(this.now() / 1000) > maxTime;

    // Send. Resending the same signed envelope is always safe: it has the same hash, so the
    // network answers DUPLICATE or applies it once. TRY_AGAIN_LATER means the network did not
    // take it. A thrown send is uncertain: the network may have taken it without our seeing the
    // reply, so from then on a txBadSeq may mean "already applied" and is settled by its hash.
    let uncertain = false;
    let accepted = false;
    for (let attempt = 1; ; attempt++) {
      let sent: rpc.Api.SendTransactionResponse | undefined;
      try {
        sent = await this.rpc.sendTransaction(bump);
      } catch {
        uncertain = true;
      }
      if (sent?.status === "PENDING" || sent?.status === "DUPLICATE") {
        accepted = true;
        this.emit({ type: "sent", channel: channel.address, hash, attempts: attempt });
        break;
      }
      if (sent?.status === "ERROR") {
        const errorCode = resultCode(sent.errorResult);
        const badSeq = errorCode !== undefined && BAD_SEQ.has(errorCode);
        if (badSeq && uncertain) break; // an earlier attempt may have landed; confirm by hash
        if (badSeq) channel.sequence = undefined;
        return { ...base, status: "rejected", hash, errorCode };
      }
      if (pastMaxTime()) {
        if (uncertain) break;
        return { ...base, status: "expired", hash };
      }
      this.emit({
        type: "send-retry",
        channel: channel.address,
        hash,
        reason: sent ? "try-again-later" : "send-error",
      });
      await this.clock.next(this.clock.current);
    }
    if (accepted) opts.onSent?.(hash);

    // Confirm: one status check per new ledger until it is final or provably never will be.
    let seen = this.clock.current;
    for (;;) {
      seen = await this.clock.next(seen);
      let res: rpc.Api.GetTransactionResponse;
      try {
        res = await this.rpc.getTransaction(hash);
      } catch {
        continue; // The transaction may still land; keep the sequence number and retry.
      }
      if (res.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (res.latestLedgerCloseTime > maxTime) {
          // It can no longer be applied. After an uncertain send the cached sequence may be
          // stale, and re-reading it is now safe.
          if (uncertain) channel.sequence = undefined;
          return { ...base, status: "expired", hash };
        }
        continue;
      }
      channel.sequence = txSequence;
      const feeCharged = res.resultXdr.feeCharged().toBigInt();
      if (res.status === rpc.Api.GetTransactionStatus.SUCCESS)
        return { ...base, status: "success", hash, ledger: res.ledger, feeCharged };
      return {
        ...base,
        status: "failed",
        hash,
        ledger: res.ledger,
        feeCharged,
        errorCode: resultCode(res.resultXdr),
      };
    }
  }

  private async sign(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<Transaction | FeeBumpTransaction> {
    const { signedTxXdr } = await this.signer.signTransaction(tx.toXDR(), {
      networkPassphrase: this.passphrase,
    });
    return TransactionBuilder.fromXDR(signedTxXdr, this.passphrase);
  }
}

function refusalReason(error: unknown): RefusalReason {
  if (error instanceof SimulationError) return "simulation";
  if (error instanceof FeeLimitError) return "fee-limit";
  if (error instanceof SimulationCheckError) return "check";
  return "other";
}

/** The result code name, looking inside a failed fee bump's inner result. */
function resultCode(result: xdr.TransactionResult | undefined): string | undefined {
  if (!result) return undefined;
  const outer = result.result();
  const name = outer.switch().name;
  if (name === "txFeeBumpInnerFailed" || name === "txFeeBumpInnerSuccess") {
    const innerName = outer.innerResultPair().result().result().switch().name;
    return name === "txFeeBumpInnerFailed" ? innerName : name;
  }
  return name;
}
