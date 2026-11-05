// G-alarm-list, "Settlement": the facilitator's EMF lines (#112), which reach CloudWatch with #113.
import type { EnvironmentConfig } from "../config.js";
import { networkSuffix } from "../names.js";
import type { AlarmFactory } from "./factory.js";

const SILENT_LEVEL = "Keeps its state; facilitator-silent covers a stopped process.";
const SILENT_EVENT = "Nothing happened; facilitator-silent covers a stopped process.";

export function addSettlementAlarms(f: AlarmFactory, c: EnvironmentConfig): void {
  const t = c.thresholds;

  f.event("http-500", {
    group: "facilitator",
    signal: { catalog: "http_requests_total", dims: { status: "500" } },
    periodMinutes: 5,
    periods: 3,
    threshold: t.http500Count,
    description: {
      what: `The facilitator answered with status 500 at least ${t.http500Count} times in 5 minutes, across every route and network. A lease or drain 503 isn't counted.`,
      next: `Read the error lines around that time in /x402/${c.envName}/app with Logs Insights.`,
      noData: SILENT_EVENT,
    },
  });

  for (const network of c.networks) {
    const on = { network };

    f.level("pending", {
      group: "facilitator",
      network,
      signal: { catalog: "settlement_oldest_open_seconds", dims: on },
      statistic: "Maximum",
      periodMinutes: 1,
      periods: 3,
      comparison: ">",
      threshold: t.pendingSeconds,
      description: {
        what: `A settlement on ${network} has been open for over ${t.pendingSeconds} s, past the 750 s a record can last at the cap: reconciliation is not closing it. A sweep that hangs after one that left nothing open reads 0 here; sweeps-stopped catches that.`,
        next: "Read settlement_reconcile_failed and reconcile_failed in the app logs, and the record's settlement_hashes. history-gone records are left out, but count again after a restart until a sweep reads their history.",
        noData: SILENT_LEVEL,
      },
    });

    f.level("channel-held", {
      group: "channelHeld",
      network,
      signal: { catalog: "channel_longest_hold_seconds", dims: on },
      statistic: "Maximum",
      periodMinutes: 1,
      periods: 1,
      comparison: ">",
      threshold: t.channelHeldSeconds,
      description: {
        what: `A channel on ${network} has been held by one settlement for over ${t.channelHeldSeconds} s; a default hold lasts up to about 426 s.`,
        next: "Find the channel and its settlement in the app logs (pool events) and check the RPC; a channel that never frees shrinks the pool.",
        noData: SILENT_LEVEL,
      },
    });

    f.level("queue-waiting", {
      group: "facilitator",
      network,
      signal: { catalog: "pool_queued", dims: on },
      statistic: "Minimum",
      periodMinutes: 1,
      periods: 3,
      comparison: ">",
      threshold: 0,
      description: {
        what: `Settle on ${network} has waited for a free channel for 3 minutes, every sample of each minute: every channel is busy or out of the pool.`,
        next: "Check channel-quarantined and the traffic; add channels (docs/runbook.md, OpenBao) when it is load rather than faults that holds them.",
        noData: SILENT_LEVEL,
      },
    });

    f.level("channel-quarantined", {
      group: "facilitator",
      network,
      signal: { catalog: "pool_quarantined", dims: on },
      statistic: "Maximum",
      periodMinutes: 1,
      periods: 1,
      comparison: ">=",
      threshold: 1,
      description: {
        what: `A channel on ${network} was taken out of the pool since the facilitator started; the pool settles with fewer channels.`,
        next: "Read the channel-quarantined pool event in the app logs for the channel and the reason; a restart puts the channels back.",
        noData: SILENT_LEVEL,
      },
    });

    f.event("breaker-opened", {
      group: "facilitator",
      network,
      signal: { catalog: "spend_breaker_opened_total", dims: on },
      description: {
        what: `A spend breaker opened on ${network}: a payer, a seller, an asset or our own side failed past its limit, and its payments are refused for the cool-down (0024).`,
        next: "Read spend_breaker_opened in the app logs for the scope, then the failures that tripped it.",
        noData: SILENT_EVENT,
      },
    });

    f.event("budget-nearing", {
      group: "facilitator",
      network,
      signal: { catalog: "spend_budget_nearing_total", dims: on },
      periodMinutes: 5,
      periods: 4,
      description: {
        what: `A fee budget on ${network} (asset, other or global) passed its nearing level: at its limit, settlement for that scope stops until the window rolls (0024). The 4 five-minute periods match its 15-minute repeat.`,
        next: "Read spend_budget_nearing in the app logs for the scope, the used and max stroops; raise the budget only if the traffic is real.",
        noData: SILENT_EVENT,
      },
    });

    f.event("store-outage", {
      group: "facilitator",
      network,
      // The one Event alarm on metric math: two counters, one condition (G-alarm-list). FILL,
      // since a sum with a missing term has no value.
      signal: {
        expression: "FILL(records, 0) + FILL(spend, 0)",
        using: {
          records: { catalog: "settlement_record_failures_total", dims: on },
          spend: { catalog: "spend_store_failures_total", dims: on },
        },
      },
      description: {
        what: `A write to Postgres failed on ${network}: a settlement record or the spend store. Settle answers may be lost from the records, and the spend policy may be blind.`,
        next: `Check x402-db-${networkSuffix(network)}@${c.envName} and its log, then settlement_record_failed and spend_store_failed in the app logs for the operation.`,
        noData: SILENT_EVENT,
      },
    });

    f.event("refused-after-verify", {
      group: "facilitator",
      network,
      signal: {
        catalog: "settlement_refused_after_verify_total",
        dims: { network, stage: "pool" },
      },
      description: {
        what: `Settle on ${network} refused, at the pool, a payment that verify had accepted: the fee went over its cap or the ledger bound passed while it waited.`,
        next: "Read settlement_refused_after_verify in the app logs for the reason; check queue-waiting and the fee settings.",
        noData: SILENT_EVENT,
      },
    });

    f.event("history-gone", {
      group: "facilitator",
      network,
      signal: { catalog: "settlement_history_gone_total", dims: on },
      description: {
        what: `A settlement record on ${network} has hashes the RPC's history no longer reaches; it stays open until an operator closes it. Every restart or deploy reports each such record again; this sends one message for them, so read the log for each record.`,
        next: "Match the settlementKey in settlement_history_gone against the records already being handled, check the hashes on Horizon, and close the record by hand (0019 decision 22).",
        noData: SILENT_EVENT,
      },
    });

    f.event("landed-after-expired", {
      group: "facilitator",
      network,
      signal: { catalog: "settlement_landed_after_expired_total", dims: on },
      description: {
        what: `A transaction on ${network} landed after its record was marked expired: the payer may have been told the payment failed while it settled.`,
        next: "Read settlement_landed_after_expired in the app logs for the record, and reconcile it with the payer.",
        noData: SILENT_EVENT,
      },
    });

    f.level("sweeps-stopped", {
      group: "facilitator",
      network,
      signal: { catalog: "settlement_sweeps_total", dims: { network, outcome: "listed" } },
      statistic: "Sum",
      periodMinutes: 1,
      periods: 5,
      comparison: "<",
      threshold: 1,
      description: {
        what: `No reconciliation sweep on ${network} listed the open records for 5 minutes: sweeps fail or hang, so a stuck settlement stays stuck. A live process writes 0 here.`,
        next: `Read reconcile_failed in the app logs; restart x402@${c.envName} if a sweep hangs.`,
        noData: SILENT_LEVEL,
      },
    });

    f.event("signer-failures", {
      group: "facilitator",
      network,
      signal: { catalog: "signer_failures_total", dims: on },
      description: {
        what: `OpenBao did not give a usable signature on ${network} (sealed, denied or a wrong key): settlement fails. The check after start counts each retry; this sends one message for them.`,
        next: "Read signer_failed in the app logs for the reason and step, then OpenBao's status and audit log (docs/runbook.md, OpenBao).",
        noData: SILENT_EVENT,
      },
    });

    f.level("rpc-on-fallback", {
      group: "facilitator",
      network,
      signal: { catalog: "rpc_on_fallback", dims: on },
      statistic: "Minimum",
      periodMinutes: 1,
      periods: 15,
      comparison: ">=",
      threshold: 1,
      description: {
        what: `The facilitator's RPC on ${network} has run on a fallback endpoint for 15 minutes, every sample: a lagging fallback answers valid payments with rejections. Its OK is the recovery.`,
        next: "Read rpc_failover in the app logs for why endpoint 0 failed, then fix it or reorder RPC_URLS.",
        noData: SILENT_LEVEL,
      },
    });

    f.event("pool-health", {
      group: "facilitator",
      network,
      signal: { catalog: "pool_events_total", dims: { network, type: "sequence-resync" } },
      periodMinutes: 5,
      periods: 3,
      threshold: t.sequenceResyncCount,
      description: {
        what: `Channels on ${network} resynced their sequence numbers ${t.sequenceResyncCount} or more times in 5 minutes: something else uses the channel accounts, or submissions keep failing.`,
        next: "Read the sequence-resync pool events in the app logs for the channels; make sure no other process holds the facilitator key.",
        noData: SILENT_EVENT,
      },
    });

    f.event("failure-ours", {
      group: "facilitator",
      network,
      signal: { catalog: "spend_failure_attributed_total", dims: { network, fault: "ours" } },
      description: {
        what: `A settlement on ${network} failed for a reason attributed to us, not to the payer, the seller or the asset.`,
        next: "Read spend_failure_ours in the app logs for the reason.",
        noData: SILENT_EVENT,
      },
    });

    f.event("commit-unmatched", {
      group: "facilitator",
      network,
      signal: { catalog: "spend_commit_unmatched_total", dims: on },
      description: {
        what: `A settled fee on ${network} counts against no budget: its reservation was never made or was pruned meanwhile, so the fee budgets undercount.`,
        next: "Read spend_commit_unmatched in the app logs for the key and state, and compare with the settlement record.",
        noData: SILENT_EVENT,
      },
    });
  }
}
