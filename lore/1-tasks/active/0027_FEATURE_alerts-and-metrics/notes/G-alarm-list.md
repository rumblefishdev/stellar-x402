---
title: "The alarms 0027 builds"
type: generation
status: developing
tags: [monitoring, cloudwatch, alarms]
links:
  - ../README.md
  - R-log-path-spike.md
history:
  - date: "2026-11-02"
    status: developing
    who: akot
    note: "The list agreed for the build. Thresholds marked 'measure' are set from real data."
---

# The alarms 0027 builds

`docs/monitoring.md` takes this list over in the last PR, with how each alarm was fired and when.
Each group goes on once its signal exists, so no alarm watches a series that doesn't.

## Shapes

An alarm helper is the only way to make an alarm, and it fixes these:

| Shape | Rule | Missing data | OK message |
| --- | --- | --- | --- |
| Event | `Sum` at or over the threshold, 1 of 15 one-minute periods, so a late point still counts | Not breaching | None: OK proves nothing about the cause |
| Level | The value past the threshold for the stated time | Not breaching, or kept | Yes |
| Silence | `FILL(m, 0) < 1`, 3 of 3 five-minute periods, `BREACHING` as a backstop | Breaching | Yes |

Each alarm's description says what happened and what to do, in under 1,024 ASCII characters, and
names what covers its silence. A level alarm also says how it re-arms.

## Availability

| Alarm | Signal | Fires when | Silence covered by |
| --- | --- | --- | --- |
| `uptime` | The probe's `ready` | Not 1 for 7 minutes in a row | Itself: a missing point counts as down |
| `rpc-stalled` | `rpc_stalled_seconds` | Above 120 s for 5 minutes. `ready` doesn't show a frozen endpoint until 0049 | `uptime` |

## Money and security

From the off-server check, so they fire with the server down.

| Alarm | Signal | Fires when |
| --- | --- | --- |
| `balance-low` | Spendable balance | Below 25 XLM |
| `balance-critical` | Spendable balance | Below 10 XLM, about a day before the 5 XLM floor |
| `account-state` | Signers and all four thresholds against the declared set | Different, or the account is gone, in 2 reads in a row |
| `account-effects` | Horizon effects on the fee account and channels | Anything but `account_credited` |
| `backup-secret-read` | CloudTrail event history | Any read, a drill's too |

## Settlement

| Alarm | Signal | Fires when |
| --- | --- | --- |
| `pending` | Oldest open record's age, leaving out `history_gone` ones | Above 900 s for 3 minutes: past the 750 s a record can last at the cap |
| `channel-held` | Longest hold (0089) | Above 300 s. A default channel holds up to about 426 s |
| `queue-waiting` | `queue_depth` | Above 0 for 3 minutes: `/settle` is waiting for a channel |
| `channel-quarantined` | Channels out of the pool | 1 or more, level; a restart puts them back |
| `breaker-opened` | `spend_breaker_opened_total` | Any breaker |
| `budget-nearing` | `spend_budget_nearing_total` for `asset`, `other`, `global` | Any, 1 of 4 five-minute periods, so its 15-minute repeat doesn't flap. `global` alone can't reach 80% on the defaults |
| `store-outage` | `settlement_record_failures_total` | 1 or more |
| `refused-after-verify` | `settlement_refused_after_verify_total{stage="pool"}` | 1 or more |
| `history-gone` | `settlement_history_gone_total` | 1 or more; an operator closes the record (runbook) |
| `landed-after-expired` | `settlement_landed_after_expired_total` | 1 or more |
| `sweeps-stopped` | `settlement_sweeps_total{outcome="listed"}`, written even at 0 | Below 1 for 5 minutes |
| `http-500` | `http_requests_total{status="500"}` | 5 or more in 5 minutes. A count, since a rate flaps at low traffic. A lease or drain 503 isn't counted |
| `signer-failures` | `signer_failures_total` | 3 or more in 5 minutes |
| `rpc-on-fallback` | `rpc_on_fallback` | 1 for 15 minutes; its OK reads as the recovery |
| `pool-health` | `pool_events_total` for `sequence-resync` | 5 or more in 5 minutes |
| `failure-ours` | `spend_failure_attributed_total{fault="ours"}` | 1 or more |
| `commit-unmatched` | `spend_commit_unmatched_total` | 1 or more |

## Host

| Alarm | Signal | Fires when |
| --- | --- | --- |
| `disk` | Agent, named mounts | Measure: read the first numbers against 80% used before it goes on. Goes to the explorer team |
| `memory` | Agent | Measure: after a week of data |
| `audit-disk` | Agent, OpenBao's audit volume | 80% used |
| `openbao-down` | Probe | Down or sealed for 3 minutes |
| `wal-failing` | Probe | `last_failed_time` past `last_archived_time` |
| `wal-stale` | Probe | The last archived segment older than 10 minutes |
| `backup-age` | Probe | The last `pgbackrest backup` older than 26 hours |
| `snapshot-age` | Probe | The last OpenBao snapshot older than 26 hours |
| `certificate` | Probe | Under 30 days left; the value goes negative after expiry |
| `watchdog-restart` | The watchdog's line | 1 or more |

## Cost, silence and delivery

| Alarm | Signal | Fires when |
| --- | --- | --- |
| `log-volume` | `AWS/Logs IncomingBytes` | Measure: a flood of log lines, on the bill as on the disk |
| `telemetry-silent` | A host metric from the agent | Silence for 15 minutes: agent, credentials or egress |
| `facilitator-silent` | The always-written sweep counter | Silence for 15 minutes. Fires beside `uptime` when the process is down |
| `probe-silent` | The probe's heartbeat | Silence for 15 minutes |
| `watch-errors` | The off-server check's `Errors` | 2 of 3 runs |
| `watch-no-invocations` | The check's `Invocations` | Silence for 15 minutes |
| `delivery-test` | A manual state change | Each alarm deploy: done only when a person sees it in Slack |

## Metrics with no alarm

- `settlement_uncertain_total`: transient, and `pending` covers one that stays.
- `settlement_hook_failures_total`, `settlement_already_settled_total`,
  `settlement_nonce_reuse_total` (forged bodies raise it), `lease_changes_total` (moves on every
  deploy).

## Deferred

- The UptoProxy TTL alarm, until `upto` reaches `/settle`.
- A cap on a sweep's time, until there are real backlog sizes.
- A dashboard and a stuck-alarm digest, until the alarms show they're needed.
- The phone or SMS route, before mainnet (0038).
