// The off-server check's balance section (0027 decision 7, ADR 0013): every 5 minutes, from AWS,
// it reads each network's fee account through `checkFacilitatorBalance`, the same formula as the
// facilitator's floor, and publishes `spendable_stroops` to `x402-watch`. `balance-low` (25 XLM)
// and `balance-critical` (10 XLM) read it with `Minimum`, so a forged higher point from the server
// can't hide a real low one. Apart from the AWS SDK, so tests run it with fakes; the handler is
// `lambdas/watch/index.mjs`.
//
// A network whose read fails publishes nothing, not 0: a 0 would read as an empty account and page
// as one. The alarms keep their state on missing data, and `watch-errors` reports the failure.
import type { StellarNetwork } from "@stellar-x402/config";
import { type SorobanRpc, checkFacilitatorBalance } from "@stellar-x402/signer-pool";

import { describeError } from "./errors.js";
import { METRIC, NAMESPACE, UNIT } from "./metric.js";

export { METRIC, NAMESPACE, UNIT };

/** Below the function's timeout, with room left to publish. */
export const DEADLINE_MS = 30_000;

/** One network the check reads: its fee account and the RPC it reads it through. */
export interface WatchTarget {
  readonly network: StellarNetwork;
  readonly feeAccount: string;
  readonly rpcUrl: string;
}

export interface PutMetricDataInput {
  Namespace: string;
  MetricData: {
    MetricName: string;
    Dimensions: { Name: string; Value: string }[];
    Value: number;
    Unit: string;
    Timestamp: Date;
  }[];
}

export interface BalanceDeps {
  readonly targets: readonly WatchTarget[];
  readonly rpcFor: (url: string) => Pick<SorobanRpc, "getLedgerEntries">;
  readonly publish: (input: PutMetricDataInput) => Promise<unknown>;
  readonly log: (line: Record<string, unknown>) => void;
  /** The run's scheduled time: each point counts for its 5-minute slot, however long the read. */
  readonly at: Date;
  readonly deadlineMs?: number;
}

export type BalanceResult =
  | { readonly network: StellarNetwork; readonly ok: true; readonly spendableStroops: bigint }
  | { readonly network: StellarNetwork; readonly ok: false; readonly error: string };

/** Rejects after `ms`, so one stalled RPC can't hold the others past the function's timeout. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The `PutMetricData` input for the networks read: one point each, in the catalog's unit. */
export function balanceMetricData(
  readings: readonly { network: StellarNetwork; spendableStroops: bigint }[],
  at: Date,
): PutMetricDataInput {
  return {
    Namespace: NAMESPACE,
    MetricData: readings.map((r) => {
      // CloudWatch takes a double; past 2^53 stroops (900 million XLM) it would round.
      if (r.spendableStroops > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error(`${r.network}: ${r.spendableStroops} stroops is past a safe number`);
      return {
        MetricName: METRIC,
        Dimensions: [{ Name: "network", Value: r.network }],
        Value: Number(r.spendableStroops),
        Unit: UNIT,
        Timestamp: at,
      };
    }),
  };
}

/**
 * One run of the section: read every network at once, publish the ones that were read, then throw
 * if any failed, so the run counts in `AWS/Lambda Errors` (`watch-errors`). A failed publish
 * throws too: no point was written.
 */
export async function runBalance(deps: BalanceDeps): Promise<BalanceResult[]> {
  const deadlineMs = deps.deadlineMs ?? DEADLINE_MS;
  const results = await Promise.all(
    deps.targets.map(async (target): Promise<BalanceResult> => {
      try {
        const report = await withDeadline(
          checkFacilitatorBalance(deps.rpcFor(target.rpcUrl), target.feeAccount),
          deadlineMs,
        );
        deps.log({
          msg: "watch_balance",
          network: target.network,
          account: target.feeAccount,
          spendable_stroops: report.spendableStroops.toString(),
        });
        return { network: target.network, ok: true, spendableStroops: report.spendableStroops };
      } catch (error) {
        const text = describeError(error, target.rpcUrl, `rpc(${target.network})`);
        deps.log({
          msg: "watch_section_failed",
          section: "balance",
          network: target.network,
          error: text,
        });
        return { network: target.network, ok: false, error: text };
      }
    }),
  );

  const read = results.filter((r) => r.ok);
  if (read.length > 0) await deps.publish(balanceMetricData(read, deps.at));

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0)
    throw new Error(
      `balance not read on ${failed.map((f) => `${f.network} (${f.error})`).join(", ")}`,
    );
  return results;
}
