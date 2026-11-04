---
title: "The alarms 0027 builds"
type: generation
status: developing
tags: [monitoring, cloudwatch, alarms]
links:
  - ../README.md
  - R-log-path-spike.md
  - G-metrics.md
  - S-pr112-spine.md
history:
  - date: "2026-11-02"
    status: developing
    who: akot
    note: "The list agreed for the build. Thresholds marked 'measure' are set from real data."
  - date: "2026-11-03"
    status: developing
    who: akot
    note: "Oskar's review of #111: a shape and missing-data rule per alarm, statistics a forged point can't move, signer failures at 1, disk to our channel."
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "To the v2 spine and #112's code: Level alarms ignore missing data, EMF error alarms, 14 to 30 days for the metrics group, per-network sweep series, sampled gauges, what pending and rpc-stalled miss."
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "#112's final review: metric-issue, a Logs metric filter and Event alarm on the metric_issue log, since a metric the writer drops writes no line and EMFValidationErrors never sees it."
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "Decisions 18-20: the metrics group kept 30 days, Level alarms on ignore confirmed against the Prices API, the disk alarm names the Prices API's."
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "metric-issue dropped: the port's types reject a metric in the wrong scope, so the case it watched for doesn't compile."
---

# The alarms 0027 builds

`docs/monitoring.md` takes this list over in the last PR, with how each alarm was fired and when.
Each group goes on once its series has data, or with `WarmUpConfiguration`, so no alarm reads OK on
a series that doesn't exist yet. The metrics are in [G-metrics](G-metrics.md).

## Shapes

An alarm helper is the only way to make an alarm. Each alarm below names its shape and anything
that differs from the shape's defaults.

| Shape | Rule | Missing data | OK message |
| --- | --- | --- | --- |
| Event | The statistic at or over the threshold in 1 of N periods, so a late point still counts. Default: `Sum`, 1-minute periods, N = 15 | Not breaching | None: OK proves nothing about the cause |
| Count | `Sum` over one 5-minute period at or over the threshold, 1 of 3 periods. A burst that a period boundary splits counts in two periods: accepted | Not breaching | None |
| Level | The statistic past the threshold in M of M periods, as listed | Ignore (`treatMissingData: ignore`): the alarm keeps its state, so a crash isn't read as a recovery (decision 19). A row may say otherwise | Yes, with how it re-arms |
| Silence | `FILL(SampleCount(m), 0) < 1` in 3 of 3 five-minute periods, so it tests that points arrive, not their value. `BREACHING` as a backstop | Breaching | Yes |

Each alarm's description says what happened and what to do, in under 1,024 ASCII characters, and
names what covers its silence. "Not breaching" and "Ignore" in the last column of each table name
that witness.

### Statistics

Root on the server holds the agent's credentials and can write an EMF line into any namespace,
since an EMF namespace is free text that no IAM condition covers. That includes the off-server
ones; it's untested, but nothing stops it. So an alarm on an off-server metric takes the statistic
a forged point can't hide a real one behind: `Minimum` for a balance and for `ready`, `Maximum`
for a count. A forged point can still raise a false alarm. Root can't stop the two Lambdas from
the server, and their silence is read from `AWS/Lambda`.

### Gauges

A facilitator gauge is sampled every 10 s and written as a `Values` array, so a gauge alarm's
`Minimum` or `Maximum` is taken over the minute's samples. `queue-waiting` and `rpc-on-fallback`
depend on it most: their `Minimum` says the condition held all minute. Whether CloudWatch
aggregates an array as samples is unverified: verify it at the first deploy.

## Availability

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `uptime` | The uptime probe's `ready` | Level, `Minimum` below 1, 7 of 7 one-minute periods | Not 1 for 7 minutes in a row. Its actions go on at the first good deploy | Breaching: a missing point counts as down |
| `rpc-stalled` | `rpc_stalled_seconds` | Level, `Maximum`, 5 of 5 one-minute periods | Above 120 s for 5 minutes. `ready` doesn't show a frozen endpoint until 0049. A failover resets the age, by design; a frozen endpoint that still answers never does. Endpoint swaps faster than every 2 minutes can keep the age under 120 s: they show in `rpc_on_fallback` and the `rpc_failover` logs instead | Ignore: `facilitator-silent` |
| `balance-stale` | `balance_reading_age_seconds` | Level, `Maximum`, 1 of 1 one-minute period | Above 300 s, the floor's `maxStaleMs` at the default interval: `/settle` refuses every payment with `facilitator_underfunded`, while `ready` stays 1 and the balance off the server looks fine. The floor reads on a timer, so it fires on a quiet server too. The threshold is tied to `maxStaleMs`: startup logs `balance_stale_threshold_mismatch` when the configured bound isn't 300 s, since the alarm then fires before `/settle` refuses, or after | Ignore: `facilitator-silent` |

## Money and security

From the off-server check, every 5 minutes, so they fire with the server down.

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `balance-low` | `spendable_stroops` | Level, `Minimum`, 1 of 1 five-minute period | Below 25 XLM | Ignore: `watch-errors`, `watch-no-invocations` |
| `balance-critical` | `spendable_stroops` | Level, `Minimum`, 1 of 1 five-minute period | Below 10 XLM, about a day before the 5 XLM floor | As above |
| `account-state` | `account_state_mismatches` | Level, `Maximum`, 2 of 2 five-minute periods | Signers or any of the four thresholds differ from the declared set, or the account is gone, in 2 reads in a row | As above |
| `account-effects` | `account_effects_unexpected` | Event, `Maximum`, 5-minute periods, N = 3 | Any effect but `account_credited` and `claimable_balance_claimant_created`, which anyone can cause | Not breaching: as above; after a gap the cursor reads what was missed |
| `backup-secret-read` | `backup_secret_reads` | Event, `Maximum`, 5-minute periods, N = 3 | Any read, a drill's too | Not breaching: as above |

`account-state` and `account-effects` are one alarm each across all accounts. While a rotation or a
channel setup holds one in ALARM, a theft on another account sends nothing new. Per-account
dimensions would cost about $15 a month at 50 channels, so we accept this.

## Settlement

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `pending` | `settlement_oldest_open_seconds` | Level, `Maximum`, 3 of 3 one-minute periods | Above 900 s: past the 750 s a record can last at the cap. The age is computed at the read, from the oldest record the latest sweep left open. A sweep that hangs after one that ended with nothing open reads 0 for as long as it hangs: `sweeps-stopped` catches a hung sweep after 5 minutes, not `pending`. `history_gone` records are left out, but that set is in memory: after a restart a record counts again until a sweep reads its history, so while that read fails `pending` can fire on it | Ignore: `facilitator-silent` |
| `channel-held` | `channel_longest_hold_seconds` (0089) | Level, `Maximum`, 1 of 1 one-minute period | Above 300 s. A default channel holds up to about 426 s. 0027 owns this alarm; 0089 builds the gauge in its own PR, on #112's port, and the alarm goes on with that PR | Ignore: as above |
| `queue-waiting` | `pool_queued` | Level, `Minimum`, 3 of 3 one-minute periods | Above 0 for 3 minutes: `/settle` is waiting for a channel. Reads the sampled `Values` | Ignore: as above |
| `channel-quarantined` | `pool_quarantined` | Level, `Maximum`, 1 of 1 one-minute period | 1 or more; a restart puts the channels back | Ignore: as above |
| `breaker-opened` | `spend_breaker_opened_total` | Event | Any breaker | Not breaching: `facilitator-silent` |
| `budget-nearing` | `spend_budget_nearing_total`: one series for `asset`, `other` and `global`, with no `budget` dimension | Event, 5-minute periods, N = 4, so its 15-minute repeat doesn't flap | Any. `global` alone can't reach 80% on the defaults | Not breaching: as above |
| `store-outage` | `settlement_record_failures_total` plus `spend_store_failures_total`, by metric math | Event | 1 or more. The only alarm that stays metric math | Not breaching: as above |
| `refused-after-verify` | `settlement_refused_after_verify_total` for `stage="pool"` | Event | 1 or more | Not breaching: as above |
| `history-gone` | `settlement_history_gone_total` | Event | 1 or more; an operator closes the record (runbook). A key is reported once per process, so after each restart or deploy it fires again for every record still open with its history gone. Match the `settlementKey` in the `settlement_history_gone` log against the records already being handled, and close them to stop the repeats | Not breaching: as above |
| `landed-after-expired` | `settlement_landed_after_expired_total` | Event | 1 or more | Not breaching: as above |
| `sweeps-stopped` | `settlement_sweeps_total{outcome:"listed"}`, per network | Level, `Sum` below 1, 5 of 5 one-minute periods | No sweep listed the records for 5 minutes. A live process with failing or hung sweeps writes 0 | Ignore: as above |
| `http-500` | `http_requests_total`, the `[status]` set at `500`: no `route`, no `network` | Count | 5 or more in 5 minutes. A count, since a rate flaps at low traffic. A lease or drain 503 isn't counted | Not breaching: as above |
| `signer-failures` | `signer_failures_total` | Event | 1 or more. On a quiet server one failed payment may be all there is, and nothing else sees a signer that fails while OpenBao looks healthy (a restored snapshot, a changed key policy). The check after start counts each retry, and the alarm sends one message for them | Not breaching: as above |
| `rpc-on-fallback` | `rpc_on_fallback` | Level, `Minimum`, 15 of 15 one-minute periods | 1 for 15 minutes; its OK reads as the recovery. Reads the sampled `Values` | Ignore: as above |
| `pool-health` | `pool_events_total` for `type="sequence-resync"` | Count | 5 or more in 5 minutes | Not breaching: as above |
| `failure-ours` | `spend_failure_attributed_total` for `fault="ours"` | Event | 1 or more | Not breaching: as above |
| `commit-unmatched` | `spend_commit_unmatched_total` | Event | 1 or more | Not breaching: as above |

## Host

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `disk` | `disk_used_percent`, named mounts | Level, `Maximum`, 3 of 3 five-minute periods | Measure: read the first numbers against 80% used before it goes on. To our channel: the server's base setup is Stan's, and our WAL and logs are what fills it. Its description names the Prices API's `prices-<env>-ch-disk-free` on the same host's ClickHouse volume (decision 20) | Ignore: `telemetry-silent` |
| `memory` | `mem_used_percent` | Level | Measure: after a week of data | As above |
| `audit-disk` | `disk_used_percent`, OpenBao's audit volume | Level, `Maximum`, 3 of 3 five-minute periods | 80% used | As above |
| `openbao-down` | `openbao_up` | Level, `Minimum`, 3 of 3 one-minute periods | Down, sealed, or its check failing, for 3 minutes | Ignore: `probe-silent` |
| `wal-failing` | `wal_failing` | Level, `Maximum`, 3 of 3 one-minute periods | `last_failed_time` past `last_archived_time`, nothing ever archived, or the check failing | As above |
| `wal-stale` | `wal_last_archived_age_seconds` | Level, `Minimum`, 3 of 3 one-minute periods | The last archived segment older than 10 minutes | As above |
| `backup-age` | `backup_age_seconds` | Level, `Minimum`, 3 of 3 one-minute periods | The last `pgbackrest backup` older than 26 hours, or none | As above |
| `snapshot-age` | `snapshot_age_seconds` | Level, `Minimum`, 3 of 3 one-minute periods | The last OpenBao snapshot older than 26 hours, or none | As above |
| `certificate` | `certificate_days_left` | Level, `Maximum`, 1 of 1 one-hour period | Under 30 days left, or the check failing | As above |
| `watchdog-restart` | `watchdog_restarts_total` | Event | 1 or more | Not breaching: a stopped watchdog leaves a hung facilitator to `uptime` |

A failed host check, or a job that never ran, writes a value past its threshold
([G-metrics](G-metrics.md#host-namespace-x402-host)).

## Cost, silence and delivery

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `log-volume` | `AWS/Logs IncomingBytes` | Level | Measure: a flood of log lines, on the bill as on the disk | Ignore: `telemetry-silent` |
| `emf-validation` | `AWS/Logs EMFValidationErrors` for the metrics log group | Event | 1 or more: CloudWatch rejected a line, so its metrics are gone: Event and Count alarms on them read OK, and Level ones keep their last state | Not breaching: written only when a line fails |
| `emf-parsing` | `AWS/Logs EMFParsingErrors` for the metrics log group | Event | 1 or more: a line CloudWatch couldn't parse as EMF | As above |
| `telemetry-silent` | `mem_used_percent` from the agent | Silence | 15 minutes: agent, credentials or egress | Breaching |
| `facilitator-silent` | `settlement_sweeps_total{outcome:"listed"}`, per network, written every minute, 0 included | Silence | 15 minutes. Fires beside `uptime` when the process is down | Breaching |
| `probe-silent` | `host_probe_heartbeat` | Silence | 15 minutes | Breaching |
| `watch-errors` | `AWS/Lambda Errors` of the off-server check | Level, `Sum` at 1 or more, 2 of 3 five-minute periods | 2 of 3 runs. Each section that fails throws at the end of the run, after the others publish | Ignore: `watch-no-invocations` |
| `watch-no-invocations` | `AWS/Lambda Invocations` of the off-server check | Silence | 15 minutes | Breaching |
| `delivery-test` | A manual state change | None | Every deploy of the alarm stack: done only when a person sees it in Slack | None |

A metric the writer can't place writes no line, and CloudWatch never sees it. The compiler rules
out the cases that matter: a name the catalog doesn't declare, and a metric written in the wrong
scope, such as a network-scoped one through the root with no `network` (the spine's AD-3). So
there is no alarm on the writer's `metric_issue` warn log; it stays readable in Logs Insights for a
label value that can't be a dimension.

`EMFDisabledErrors` gets no alarm: a one-off check, when the alarm stack first goes on, that it is 0
on the shared account.

The metrics log group is kept 30 days, like the app group (decision 18): Logs Insights reads the log
fields from it, and the weekly fee review needs a week of it.

## Metrics with no alarm

- `settlement_uncertain_total`: transient, and `pending` covers one that stays.
- `settlement_hook_failures_total`, `settlement_already_settled_total`,
  `settlement_nonce_reuse_total` (forged bodies raise it), `lease_changes_total` (moves on every
  deploy).
- `settlement_submit_failures_total` and `settlement_budget_exhausted_total`: a payment that failed
  or ran out of time is its payer's answer; `failure-ours` and `pending` cover what's ours.
- `settlement_reconciled_total`, `settlement_reopened_total`, `settlement_lease_fenced_total`,
  `spend_refused_total`: traffic, read in Logs Insights. A lost lease shows in `uptime`.
- `store_prune_failures_total`: a prune that keeps failing grows the tables, which `disk` sees.
- `balance_read_failures_total`: after one failed read the floor keeps the last reading; reads that
  keep failing show in `balance-stale`.
- The catalog's metrics: discovery fails open, and nothing there costs money.
- `spend_budget_nearing_total` for `payer` and `pay_to`: one buyer or seller near its budget is
  the budget working, not something an operator acts on. They also stay out of the billed
  dimensions, as in #105's README.
- `fee_charged_stroops`: read in the weekly review against the balance's change (decision 13). The
  metric is approximate, so the review takes the database as the source of truth.

## Open

- A single gauge that goes silent while sweeps continue is caught by no alarm: `facilitator-silent`
  reads the sweeps, and a Level alarm keeps its state. Decide in #114 whether one is worth adding.

## Deferred

- The UptoProxy TTL alarm, until `upto` reaches `/settle`: backlog task 0109.
- A cap on a sweep's time, until there are real backlog sizes: backlog task 0110.
- A dashboard and a stuck-alarm digest, until the alarms show they're needed.
- The phone or SMS route, before mainnet (0038).
- The `channel-held` alarm, until 0089's PR.
- An external dead-man's switch for a host outside AWS, which the sibling projects recommend:
  decide before mainnet, with 0038.
