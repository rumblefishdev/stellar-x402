---
title: "The metrics 0027 emits"
type: generation
status: developing
tags: [monitoring, cloudwatch, metrics, emf]
links:
  - ../README.md
  - G-alarm-list.md
history:
  - date: "2026-11-03"
    status: developing
    who: akot
    note: "Decision 4 as one table for #112's catalog, from Oskar's review of #111."
---

# The metrics 0027 emits

Decision 4 as one table, which #112's catalog follows. The facilitator writes EMF lines to the
namespace `x402-facilitator`. A billed metric carries `network` plus the dimensions listed. A label
not listed as billed stays a field in the line, read with Logs Insights. "Only for X" means that the
line carries the dimension set for that value only, so the other values add no metric.

Counters write their sum each minute. Gauges write their value every minute, changed or not, so a
gauge that stops is silence, not a stale value. `settlement_sweeps_total` writes 0 too.

## Facilitator, on develop today

| Metric | Source | Billed by | Log fields | Alarm |
| --- | --- | --- | --- | --- |
| `settlement_outcomes_total` | Every `/settle` answer, `settle.ts` | `result`: `success` or `error` | `reason`, `replay` | None: traffic, AC 1 |
| `settlement_refused_after_verify_total` | `settle.ts` | `stage`, only for `pool` | `reason` | `refused-after-verify` |
| `settlement_record_failures_total` | `records.ts` | Yes | | `store-outage` |
| `settlement_history_gone_total` | `reconcile.ts` | Yes | | `history-gone` |
| `settlement_landed_after_expired_total` | `records.ts` (0088) | Yes | `state` | `landed-after-expired` |
| `signer_failures_total` | `openbao-signer.ts` (0036) | Yes | `reason`, `step` | `signer-failures` |
| `pool_events_total` | The pool's `onEvent`, `main.ts` | Yes, and `type` only for `sequence-resync` | `type`, `status` on `resolved` | `pool-health` |
| `settlement_uncertain_total` | `settle.ts` | No | | None |
| `settlement_submit_failures_total` | `settle.ts` | No | | None |
| `settlement_budget_exhausted_total` | `settle.ts` | No | `signed` | None |
| `settlement_reconciled_total` | `reconcile.ts` | No | `state` | None |
| `settlement_reopened_total` | `settle.ts` | No | `reason` | None |
| `settlement_lease_fenced_total` | `settle.ts` | No | | None |
| `settlement_hook_failures_total` | `records.ts` | No | `hook` | None |
| `settlement_already_settled_total` | `settle.ts` | No | | None |
| `settlement_nonce_reuse_total` | `settle.ts` | No | | None |
| `lease_changes_total` | `lease.ts` | No | `held` | None |
| `store_prune_failures_total` | `pruner.ts` | No | `table` | None |
| `catalog_*_total` (5 metrics), `discovery_unknown_params_total` | `cataloger.ts`, `discovery.ts` | No | `stage`, `origin`, `reason`, `outcome` | None |

## Facilitator, from 0024 (#105)

| Metric | Source | Billed by | Log fields | Alarm |
| --- | --- | --- | --- | --- |
| `spend_breaker_opened_total` | `spend/policy.ts` | Yes | `breaker` | `breaker-opened` |
| `spend_budget_nearing_total` | `spend/policy.ts` | `budget`, only for `asset`, `other` and `global` | `budget` | `budget-nearing` |
| `spend_failure_attributed_total` | `spend/policy.ts` | `fault`, only for `ours` | `fault` | `failure-ours` |
| `spend_commit_unmatched_total` | `spend/policy.ts` | Yes | `state` | `commit-unmatched` |
| `spend_store_failures_total` | `spend/policy.ts` | Yes | `op` | `store-outage` |
| `spend_refused_total` | `spend/policy.ts` | No | `reason` | None |
| `balance_read_failures_total` | `spend/balance-floor.ts`: a failed read of the fee account | No | | None: `balance-stale` sees a reading that stays old |

## Facilitator, new in #112

| Metric | Source | Billed by | Log fields | Alarm |
| --- | --- | --- | --- | --- |
| `http_requests_total` | Every HTTP answer | `route` (`/verify`, `/settle`, `/supported`, `/health`, `/discovery`, `other`); and `status`, only for `500` | `status` | `http-500` |
| `settlement_sweeps_total` | Each sweep, `reconcile.ts`, 0 written too | `outcome`: `listed` or `failed` | | `sweeps-stopped`, `facilitator-silent` |
| `settlement_oldest_open_seconds` | Gauge: the age of the oldest non-final record the latest sweep listed, `history_gone` ones left out; 0 with none | Yes | | `pending` |
| `pool_queued` | Gauge from the pool's stats | Yes | `channels`, `busy` | `queue-waiting` |
| `pool_quarantined` | Gauge from the pool's stats: channels out of the pool since start | Yes | | `channel-quarantined` |
| `rpc_on_fallback` | Gauge: 1 while the shared `FallbackRpc` isn't on `RPC_URLS[0]` | Yes | the endpoint's `rpcEndpointName` | `rpc-on-fallback` |
| `rpc_stalled_seconds` | Gauge: seconds since `getLatestLedger`'s sequence last rose, read every 30 s | Yes | | `rpc-stalled` |
| `balance_reading_age_seconds` | Gauge: seconds since the floor's last good read of the fee account, or since start before the first (decision 17) | Yes | | `balance-stale` |
| `fee_charged_stroops` | The sum of `feeCharged`, once per landed transaction (decision 13) | Yes | `state` | None: the weekly review |

`http_requests_total` has no `network`: a route serves both networks once 0077 lands.

## From 0089

| Metric | Source | Billed by | Alarm |
| --- | --- | --- | --- |
| `channel_longest_hold_seconds` | Gauge, built in 0089 | Yes | `channel-held` |

## Host, namespace `x402-host`

The host probe (#113) writes a line a minute to the file the agent reads. A failed check, or a job
that never ran, writes a value past its alarm's threshold, so a broken check alarms rather than
reading as healthy.

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
| `mem_used_percent`, `disk_used_percent` per named mount | The agent | `memory`, `disk`, `audit-disk`, `telemetry-silent` |

## Off the server, namespace `x402-watch`

Published with `PutMetricData` by two Lambdas.

| Metric | Source | Alarm statistic | Alarm |
| --- | --- | --- | --- |
| `ready` | The uptime probe, every minute: `/health`'s `ready`, 0 when it can't read it | `Minimum` | `uptime` |
| `spendable_stroops` | The off-server check, every 5 minutes, `checkFacilitatorBalance` | `Minimum` | `balance-low`, `balance-critical` |
| `account_state_mismatches` | The check: accounts whose signers or thresholds differ from the declared set, or that are gone | `Maximum` | `account-state` |
| `account_effects_unexpected` | The check: effects other than the allowed two, since the cursor | `Maximum` | `account-effects` |
| `backup_secret_reads` | The check: `GetSecretValue` events not counted before | `Maximum` | `backup-secret-read` |

The statistics are the ones a forged point can't hide a real one behind
([G-alarm-list](G-alarm-list.md#statistics)).
