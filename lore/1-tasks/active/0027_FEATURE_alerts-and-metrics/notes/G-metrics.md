---
title: "The metrics 0027 emits"
type: generation
status: developing
tags: [monitoring, cloudwatch, metrics, emf]
links:
  - ../README.md
  - G-alarm-list.md
  - S-pr112-spine.md
history:
  - date: "2026-11-03"
    status: developing
    who: akot
    note: "Decision 4 as one table for #112's catalog, from Oskar's review of #111."
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "To the v2 spine and #112's code: scopes, CAIP-2 network values, dimension sets, fixed units, sampled gauges, the one zero seed, 0089's own PR, x402-host for the agent."
  - date: "2026-11-05"
    status: developing
    who: akot
    note: "From the whole-task review: every metric is billed, as the catalog writes it (decision 4 amended), and the disk's dimension is `path`, the agent's name for it."
---

# The metrics 0027 emits

Decision 4 as one table, which #112's catalog (`packages/metrics-catalog`) follows. Where the two
differ, the catalog and the [spine](S-pr112-spine.md) win. The facilitator writes EMF lines to the
namespace `x402-facilitator`. Every metric here is billed (decision 4 as amended on 2026-11-05).
"Billed by" lists the dimensions a metric carries, plus `network` when it is network-scoped. "Yes"
means `network` alone, or no dimension on a process-scoped metric. A label not listed as billed
stays a field in the line, read with Logs Insights. "Only for X" means that the line carries the dimension set for that
value only. The other values write no line at all, so their label is in no metric line either.
Where the call site logs the event, the app log has it: `settlement_refused_after_verify` with its
`stage`, and `spend_budget_nearing` with its `scope`. A `fault` other than `ours` is in no line;
the failure itself is in `settlement_outcomes_total` and the database.

**Scope.** A network-scoped metric carries `network` in every set. Its value is the CAIP-2 string
from `STELLAR_NETWORKS` (`stellar:testnet`, `stellar:pubnet`), never retyped. A process-scoped
metric never carries it. Every facilitator metric is network-scoped except `http_requests_total`,
`store_prune_failures_total`, the five `catalog_*_total` and `discovery_unknown_params_total`. Those
serve every network: a route once 0077 lands, and tables shared by both networks.

**Units** are fixed for a metric's life, and alarms omit `Unit`, since a mismatch leaves an alarm
with no data. Facilitator counters are `Count`, except `fee_charged_stroops`, which is `None`. The
gauges ending in `_seconds` are `Seconds`, `pool_queued` and `pool_quarantined` are `Count`, and
`rpc_on_fallback` is `None`.

**Writing.** Counters write their sum for each wall-clock minute, stamped with the minute's start.
A facilitator metric an Event alarm reads is written eager-first: the first increment of a series
in a minute goes out at once, so the deciding point leaves the process before a crash, and later
ones add to the minute line. Gauges are sampled every 10 s and written as a `Values` array, so `Minimum` and
`Maximum` describe the minute. A gauge's minute is one line per series, keyed by its dimensions:
a log field that changes between samples (`pool_queued`'s `busy`) is written as its last sample's. Whether CloudWatch aggregates an array as samples is unverified:
verify it at the first deploy, or fall back to writing the minute's minimum and maximum as two
metrics. A gauge that stops is silence, not a stale value. The only zero written is
`settlement_sweeps_total{outcome:"listed"}`, every minute for each configured network.

## Facilitator, on develop today

| Metric | Source | Billed by | Log fields | Alarm |
| --- | --- | --- | --- | --- |
| `settlement_outcomes_total` | Every `/settle` answer, `settle.ts`, which sets `result` at the call site | `result`: `success` or `error` | `reason`, `replay` | None: traffic, AC 1 |
| `settlement_refused_after_verify_total` | `settle.ts` | `stage`, only for `pool` | `reason` (on `pool` lines; a `check` refusal is in the `settlement_refused_after_verify` log only) | `refused-after-verify` |
| `settlement_record_failures_total` | `records.ts` | Yes | | `store-outage` |
| `settlement_history_gone_total` | `reconcile.ts` | Yes | | `history-gone` |
| `settlement_landed_after_expired_total` | `records.ts` (0088) | Yes | `state` | `landed-after-expired` |
| `signer_failures_total` | `openbao-signer.ts` (0036) | Yes | `reason`, `step` | `signer-failures` |
| `pool_events_total` | The pool's `onEvent`, `main.ts` | Yes, and `type` only for `sequence-resync` | `type`, `status` on `resolved` | `pool-health` |
| `settlement_uncertain_total` | `settle.ts` | Yes | | None |
| `settlement_submit_failures_total` | `settle.ts` | Yes | | None |
| `settlement_budget_exhausted_total` | `settle.ts` | Yes | `signed` | None |
| `settlement_reconciled_total` | `reconcile.ts` | Yes | `state` | None |
| `settlement_reopened_total` | `settle.ts` | Yes | `reason` | None |
| `settlement_lease_fenced_total` | `settle.ts` | Yes | | None |
| `settlement_hook_failures_total` | `records.ts` | Yes | `hook` | None |
| `settlement_already_settled_total` | `settle.ts` | Yes | | None |
| `settlement_nonce_reuse_total` | `settle.ts` | Yes | | None |
| `lease_changes_total` | `lease.ts` | Yes | `held` | None |
| `store_prune_failures_total` | `pruner.ts` | Yes | `table` | None |
| `catalog_*_total` (5 metrics), `discovery_unknown_params_total` | `cataloger.ts`, `discovery.ts` | Yes | `stage`, `origin`, `reason`, `outcome` | None |

## Facilitator, from 0024 (#105)

| Metric | Source | Billed by | Log fields | Alarm |
| --- | --- | --- | --- | --- |
| `spend_breaker_opened_total` | `spend/policy.ts` | Yes | `breaker` | `breaker-opened` |
| `spend_budget_nearing_total` | `spend/policy.ts` | Yes, only for `budget` `asset`, `other` and `global`. The set has no `budget`, so the three share one series | `budget` (a `payer` budget is in the `spend_budget_nearing` log only) | `budget-nearing` |
| `spend_failure_attributed_total` | `spend/policy.ts` | `fault`, only for `ours` | None: only `ours` writes a line | `failure-ours` |
| `spend_commit_unmatched_total` | `spend/policy.ts` | Yes | `state` | `commit-unmatched` |
| `spend_store_failures_total` | `spend/policy.ts` | Yes | `op` | `store-outage` |
| `spend_refused_total` | `spend/policy.ts` | Yes | `reason` | None |
| `balance_read_failures_total` | `spend/balance-floor.ts`: a failed read of the fee account | Yes | | None: `balance-stale` sees a reading that stays old |

## Facilitator, new in #112

| Metric | Source | Billed by | Log fields | Alarm |
| --- | --- | --- | --- | --- |
| `http_requests_total` | Every HTTP answer Express sees, when its response closes | Two sets: `[route]` (`/verify`, `/settle`, `/supported`, `/health`, `/discovery`, `other`), and `[status]`, only for `500` | `status` | `http-500` |
| `settlement_sweeps_total` | Each sweep, `reconcile.ts`: `listed` once it has listed the records, `failed` when it rejects. Only `listed` is written as 0 | `outcome`: `listed` or `failed` | | `sweeps-stopped`, `facilitator-silent` |
| `settlement_oldest_open_seconds` | Gauge, computed at the read: the age of the oldest record the latest sweep left open, `history_gone` ones left out; 0 with none | Yes | | `pending` |
| `pool_queued` | Gauge from the pool's stats | Yes | `channels`, `busy` | `queue-waiting` |
| `pool_quarantined` | Gauge from the pool's stats: channels out of the pool since start | Yes | | `channel-quarantined` |
| `rpc_on_fallback` | Gauge: 1 while the shared `FallbackRpc`'s `active` isn't endpoint 0's name | Yes | `rpc`: the active endpoint's name | `rpc-on-fallback` |
| `rpc_stalled_seconds` | Gauge: seconds since the ledger sequence last changed, read every 30 s through the shared `FallbackRpc`. A new active endpoint or a lower sequence starts a new baseline | Yes | | `rpc-stalled` |
| `balance_reading_age_seconds` | Gauge: seconds since the floor's last good read of the fee account, or since start before the first (decision 17) | Yes | | `balance-stale` |
| `fee_charged_stroops` | The sum of `feeCharged`, where a record's final write wins, plus the landed-after-expired path (decision 13). Approximate: EMF is at most once | Yes | `state` | None: the weekly review, which takes the database as the source of truth |

`http_requests_total` is process-scoped: it has no `network`, since a route serves both networks once
0077 lands. A middleware mounted first counts it once, when the response closes. The `route` label
is taken when the request arrives, from a fixed prefix map, never the raw path or `req.route`.
`status` is the final status, or `aborted` for a response that didn't finish: the client left, or
the connection was cut. Requests that Node refuses before Express, a parser 400 or a header-timeout
408, are not counted.

## From 0089

| Metric | Source | Billed by | Alarm |
| --- | --- | --- | --- |
| `channel_longest_hold_seconds` | Gauge. The catalog declares it; 0089 builds it in its own PR, on #112's port. It needs a signer-pool hold timestamp | Yes | `channel-held`, once that PR lands |

## Host, namespace `x402-host`

The host probe (#113) writes a line a minute to the file the agent reads. A failed check, or a job
that never ran, writes a value past its alarm's threshold, so a broken check alarms rather than
reading as healthy. The agent reports no CPU (decision 20). Its own metrics go to `x402-host` with
the catalog's dimensions, not the agent's default `CWAgent` (#113). Every host metric is
process-scoped: one host, no `network`.
The ages are `Seconds`, the percentages `Percent`, `watchdog_restarts_total` `Count`, and the rest
`None`.

| Metric | Source | Alarm |
| --- | --- | --- |
| `openbao_up` | 1 when OpenBao answers unsealed on its socket, else 0 | `openbao-down` |
| `wal_failing` | 1 when `last_failed_time` is past `last_archived_time`, nothing was ever archived, or the check fails | `wal-failing` |
| `wal_last_archived_age_seconds` | Since `last_archived_time` | `wal-stale` |
| `backup_age_seconds` | Since the last `pgbackrest backup` | `backup-age` |
| `snapshot_age_seconds` | Since the last OpenBao snapshot | `snapshot-age` |
| `certificate_days_left` | The Roles Anywhere certificate, negative after expiry | `certificate` |
| `host_probe_heartbeat` | 1 on every run | `probe-silent` |
| `watchdog_restarts_total` | The watchdog, once per restart | `watchdog-restart` |
| `mem_used_percent`, `disk_used_percent` per named mount | The agent. `disk_used_percent` carries `path`, the mount point, as the agent's disk plugin names it, open until #113 names the mounts | `memory`, `disk`, `audit-disk`, `telemetry-silent` |

## Off the server, namespace `x402-watch`

Published with `PutMetricData` by two Lambdas. `spendable_stroops`, `account_state_mismatches` and
`account_effects_unexpected` are network-scoped. `ready` and `backup_secret_reads` are
process-scoped: one probe, one AWS account. `ready` and `spendable_stroops` are `None`, the rest
`Count`.

| Metric | Source | Alarm statistic | Alarm |
| --- | --- | --- | --- |
| `ready` | The uptime probe, every minute: `/health`'s `ready`, 0 when it can't read it | `Minimum` | `uptime` |
| `spendable_stroops` | The off-server check, every 5 minutes, `checkFacilitatorBalance` | `Minimum` | `balance-low`, `balance-critical` |
| `account_state_mismatches` | The check: accounts whose signers or thresholds differ from the declared set, or that are gone | `Maximum` | `account-state` |
| `account_effects_unexpected` | The check: effects other than the allowed two, since the cursor | `Maximum` | `account-effects` |
| `backup_secret_reads` | The check: `GetSecretValue` events not counted before | `Maximum` | `backup-secret-read` |

The statistics are the ones a forged point can't hide a real one behind
([G-alarm-list](G-alarm-list.md#statistics)).
