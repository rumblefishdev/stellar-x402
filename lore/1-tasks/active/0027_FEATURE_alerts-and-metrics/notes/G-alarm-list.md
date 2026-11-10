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
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "#114's plan (decisions 23-28): every alarm built in #114, each group absent until its series has data, gauges-silent closes the open item."
  - date: "2026-11-05"
    status: developing
    who: akot
    note: "From the whole-task review: the backup and snapshot alarms leave host for groups of their own (decision 40), and the balance alarms name the fee account and the top-up step (decision 41)."
  - date: "2026-11-05"
    status: developing
    who: akot
    note: "From #113's spine (decisions 43, 44, 46): facilitator-failed and credentials-stale in host, and telemetry-silent reads the disk series too."
  - date: "2026-11-05"
    status: developing
    who: akot
    note: "Karol's review of #114 (decisions 60-67): settlement-expired, submit-failed, hook-failures, uptime-flapping, http-500 at 1, breaker-opened per kind, theft findings straight to SNS from #115, the log-volume ceiling with host, the Count shape folded into Event."
---

# The alarms 0027 builds

`docs/monitoring.md` takes this list over in the last PR, with how each alarm was fired and when.
#114 builds every alarm below (decision 23). A group's alarms are created only once its series has
data, which `make check-series` checks, and none exists without its actions (decision 26), so no
alarm reads OK on a series that doesn't exist yet. The metrics are in [G-metrics](G-metrics.md).

## Shapes

An alarm helper is the only way to make an alarm. Each alarm below names its shape and anything
that differs from the shape's defaults.

| Shape | Rule | Missing data | OK message |
| --- | --- | --- | --- |
| Event | The statistic at or over the threshold in 1 of N periods, so a late point still counts. Default: `Sum`, 1-minute periods, N = 15, at 1 or more. A count over 5 minutes is an Event with 5-minute periods, N = 3 and its threshold; a burst that a period boundary splits counts in two periods: accepted | Not breaching | None: OK proves nothing about the cause |
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
| `uptime-flapping` | The uptime probe's `ready` | Level, `Minimum` below 1, 10 of 30 one-minute periods | Not 1 in 10 of the last 30 minutes, none of them 7 in a row needed: a crash loop that comes up between restarts (`0 0 0 0 0 0 1` repeating never fires `uptime`), a lease that moves, a tunnel that drops. One deploy stays under 10. In the `uptime` group | Breaching: as `uptime` |
| `rpc-stalled` | `rpc_stalled_seconds` | Level, `Maximum`, 5 of 5 one-minute periods | Above 120 s for 5 minutes. `ready` doesn't show a frozen endpoint until 0049. A failover resets the age, by design; a frozen endpoint that still answers never does. Endpoint swaps faster than every 2 minutes can keep the age under 120 s: they show in `rpc_on_fallback` and the `rpc_failover` logs instead | Ignore: `facilitator-silent` |
| `balance-stale` | `balance_reading_age_seconds` | Level, `Maximum`, 1 of 1 one-minute period | Above 300 s, the floor's `maxStaleMs` at the default interval: `/settle` refuses every payment with `facilitator_underfunded`, while `ready` stays 1 and the balance off the server looks fine. The floor reads on a timer, so it fires on a quiet server too. The threshold is tied to `maxStaleMs`: startup logs `balance_stale_threshold_mismatch` when the configured bound isn't 300 s, since the alarm then fires before `/settle` refuses, or after | Ignore: `facilitator-silent` |

## Money and security

From the off-server check, every 5 minutes, so they fire with the server down. Built in #114. The
balance alarms and the check's health are the `watch` group, on once #115's Lambda publishes;
`account-state`, `account-effects` and `backup-secret-read` are `watchSecurity`, on once their
sections do (decision 68), built by task 0127 (decision 71).

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `balance-low` | `spendable_stroops` | Level, `Minimum`, 1 of 1 five-minute period | Below 25 XLM. The description names the fee account (`feeAccounts` in the infra config) and the runbook's top-up step, as ADR 0013 asks | Ignore: `watch-errors`, `watch-no-invocations` |
| `balance-critical` | `spendable_stroops` | Level, `Minimum`, 1 of 1 five-minute period | Below 10 XLM, about a day before the 5 XLM floor | As above |
| `account-state` | `account_state_mismatches` | Level, `Maximum`, 2 of 2 five-minute periods | Signers or any of the four thresholds differ from the declared set, or the account is gone, in 2 reads in a row | As above |
| `account-effects` | `account_effects_unexpected` | Event, `Maximum`, 5-minute periods, N = 3 | Any effect but `account_credited` and `claimable_balance_claimant_created`, which anyone can cause | Not breaching: as above; after a gap the cursor reads what was missed |
| `backup-secret-read` | `backup_secret_reads` | Event, `Maximum`, 5-minute periods, N = 3 | Any read, a drill's too | Not breaching: as above |

`account-state` and `account-effects` are one alarm each across all accounts. While a rotation or a
channel setup holds one in ALARM, a theft on another account sends nothing new. Per-account
dimensions would cost about $15 a month at 50 channels, so we accept this. Root on the server can
hold either in ALARM the same way with a forged point every 15 minutes, so #115's check also posts
each finding to the topic itself, one message per finding; the two alarms stay as the backstop for
a check that can't publish (decision 64).

## Protocol

From the off-server check's protocol section, every 5 minutes, for each network in
`watch.protocol` (testnet and mainnet), served or not, so an upgrade is seen before it reaches a
network we serve. Each alarm has its own threshold per network in the infra config: `expected`,
the protocol we have checked, and `supported`, the highest Core version we have checked the SDK
and the RPC against, never below `expected`. Each is raised
in a PR once acted on, so each re-arms for the next version on its own. In the `protocol` group
(decision 70).

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `protocol-changed` | `protocol_version` | Level, `Maximum`, 2 of 2 five-minute periods | Above `expected`: the network upgraded. On 2026-11-03 testnet's move to 30 left an older SDK unable to read ledgers, found only by chance | Ignore: `watch-errors`, `watch-no-invocations` |
| `protocol-upgrade-coming` | `protocol_supported_version` | Level, `Maximum`, 2 of 2 five-minute periods | The Stellar Core behind the network's Horizon (SDF's fleet) supports a version above `supported`: the validators can vote the upgrade once enough of them run it. On 2026-11-06 mainnet ran 29 with Core supporting 30; `supported` is 30 since 2026-11-09, the version testnet runs. Two periods, since Horizon nodes behind the balancer differ during a rolling upgrade | As above |

## Settlement

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `pending` | `settlement_oldest_open_seconds` | Level, `Maximum`, 3 of 3 one-minute periods | Above 900 s: past the 750 s a record can last at the cap. The age is computed at the read, from the oldest record the latest sweep left open. A sweep that hangs after one that ended with nothing open reads 0 for as long as it hangs: `sweeps-stopped` catches a hung sweep after 5 minutes, not `pending`. Before a process's first listing there is no point (decision 56), so it keeps its state; if the listing keeps failing, `sweeps-stopped` fires after 5 minutes and `gauges-silent` after 15. `history_gone` records are left out, but that set is in memory: after a restart a record counts again until a sweep reads its history, so while that read fails `pending` can fire on it | Ignore: `facilitator-silent` |
| `channel-held` | `channel_longest_hold_seconds` (0089) | Level, `Maximum`, 1 of 1 one-minute period | Above 300 s. A default channel holds up to about 426 s. 0027 owns this alarm; 0089 builds the gauge in its own PR, on #112's port, and the alarm goes on with that PR | Ignore: as above |
| `queue-waiting` | `pool_queued` | Level, `Minimum`, 3 of 3 one-minute periods | Above 0 for 3 minutes: `/settle` is waiting for a channel. Reads the sampled `Values` | Ignore: as above |
| `channel-quarantined` | `pool_quarantined` | Level, `Maximum`, 1 of 1 one-minute period | 1 or more; a restart puts the channels back | Ignore: as above |
| `breaker-opened` | `spend_breaker_opened_total`, one alarm per `breaker`: `payer`, `pay_to`, `asset` | Event | Any breaker of that kind. One series for all three let payer breakers opened with fresh accounts hold the alarm in ALARM, so a `pay_to` or `asset` one sent nothing | Not breaching: `facilitator-silent` |
| `budget-nearing` | `spend_budget_nearing_total`: one series for `asset`, `other` and `global`, with no `budget` dimension | Event, 5-minute periods, N = 4, so its 15-minute repeat doesn't flap | Any. `global` alone can't reach 80% on the defaults | Not breaching: as above |
| `store-outage` | `settlement_record_failures_total` plus `spend_store_failures_total`, by metric math | Event | 1 or more. The only alarm that stays metric math | Not breaching: as above |
| `refused-after-verify` | `settlement_refused_after_verify_total` for `stage="pool"` | Event | 1 or more | Not breaching: as above |
| `history-gone` | `settlement_history_gone_total` | Event | 1 or more; an operator closes the record (runbook). A key is reported once per process, so after each restart or deploy every record still open with its history gone is reported again, in one message: read the log for each record. Match the `settlementKey` in the `settlement_history_gone` log against the records already being handled, and close them to stop the repeats | Not breaching: as above |
| `landed-after-expired` | `settlement_landed_after_expired_total` | Event | 1 or more | Not breaching: as above |
| `sweeps-stopped` | `settlement_sweeps_total{outcome:"listed"}`, per network | Level, `Sum` below 1, 5 of 5 one-minute periods | No sweep listed the records for 5 minutes. A live process with failing or hung sweeps writes 0 | Ignore: as above |
| `http-500` | `http_requests_total`, the `[status]` set at `500`: no `route`, no `network` | Event | 1 or more: `onError` takes an error it doesn't know as ours, so the first one is worth a look; a burst sends one message. A lease or drain 503 isn't counted | Not breaching: as above |
| `settlement-expired` | `settlement_reconciled_total` for `state="expired"` | Event | 1 or more: a payment that never landed by its bound. Neither `failure-ours` (needs a fee) nor `pending` (needs a record past 750 s) sees it | Not breaching: as above |
| `submit-failed` | `settlement_submit_failures_total` | Event | 1 or more: an `unexpected_settle_error` with nothing sent, answered with status 200, so `http-500` doesn't see it | Not breaching: as above |
| `hook-failures` | `settlement_hook_failures_total` | Event | 1 or more: a hook that threw, so the fee count or a breaker may have missed a settlement | Not breaching: as above |
| `signer-failures` | `signer_failures_total` | Event | 1 or more. On a quiet server one failed payment may be all there is, and nothing else sees a signer that fails while OpenBao looks healthy (a restored snapshot, a changed key policy). The check after start counts each retry, and the alarm sends one message for them | Not breaching: as above |
| `rpc-on-fallback` | `rpc_on_fallback` | Level, `Minimum`, 15 of 15 one-minute periods | 1 for 15 minutes; its OK reads as the recovery. Reads the sampled `Values` | Ignore: as above |
| `pool-health` | `pool_events_total` for `type="sequence-resync"` | Event, 5-minute periods, N = 3, at 5 or more | 5 or more in 5 minutes | Not breaching: as above |
| `failure-ours` | `spend_failure_attributed_total` for `fault="ours"` | Event | 1 or more | Not breaching: as above |
| `commit-unmatched` | `spend_commit_unmatched_total` | Event | 1 or more | Not breaching: as above |

## Host

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `disk` | `disk_used_percent`, named mounts | Level, `Maximum`, 3 of 3 five-minute periods | Over 80% (decision 73): the warning before `audit-disk`, on the same mount. To our channel: the server's base setup is Stan's, and our WAL and logs are what fills it. Its description names the Prices API's `prices-<env>-ch-disk-free` on the same host's ClickHouse volume (decision 20) | Ignore: `telemetry-silent` |
| `memory` | `mem_used_percent` | Level, `Minimum`, 3 of 3 five-minute periods | Over 90% (decision 72) | As above |
| `audit-disk` | `disk_used_percent`, OpenBao's audit volume | Level, `Maximum`, 3 of 3 five-minute periods | 90% used (decision 73, ADR 0013 amended) | As above |
| `openbao-down` | `openbao_up` | Level, `Minimum`, 3 of 3 one-minute periods | Down, sealed, or its check failing, for 3 minutes | Ignore: `probe-silent` |
| `wal-failing` | `wal_failing` | Level, `Maximum`, 3 of 3 one-minute periods | `last_failed_time` past `last_archived_time`, nothing ever archived, or the check failing | As above |
| `wal-stale` | `wal_last_archived_age_seconds` | Level, `Minimum`, 3 of 3 one-minute periods | The last archived segment older than 10 minutes | As above |
| `backup-age` | `backup_age_seconds` | Level, `Minimum`, 3 of 3 one-minute periods | The last `pgbackrest backup` older than 26 hours, or none | As above |
| `snapshot-age` | `snapshot_age_seconds` | Level, `Minimum`, 3 of 3 one-minute periods | The last OpenBao snapshot older than 26 hours, or none | As above |
| `credentials-stale` | `credentials_age_seconds` | Level, `Minimum`, 3 of 3 one-minute periods | Above 7,500 s: the signing helper's hourly run failed twice, retries included, about 9.5 hours before its 12-hour keys run out (decision 46) | Ignore: `probe-silent` |
| `certificate` | `certificate_days_left` | Level, `Maximum`, 1 of 1 one-hour period | Under 30 days left, or the check failing | As above |
| `watchdog-restart` | `watchdog_restarts_total` | Event | 1 or more | Not breaching: a stopped watchdog leaves a hung facilitator to `uptime` |
| `facilitator-failed` | `facilitator_failures_total`, from `x402@`'s `ExecStopPost` | Event | 1 or more: an end other than `success`, a crash, a failed start, a drain cut short, a `dockerd` crash, or the watchdog's kill of a hung process (with `watchdog-restart`). A crash after `ready` in cycles of a minute or more never reaches `StartLimitBurst` (decision 43) | Not breaching: `telemetry-silent`, since the probe doesn't write it |

A failed host check, or a job that never ran, writes a value past its threshold
([G-metrics](G-metrics.md#host-namespace-x402-host)). So `wal-failing`, `wal-stale` and
`backup-age` are a group of their own, `backups`, and `snapshot-age` is `snapshots`: their jobs come
with 0026, and in `host` they would keep the probe's other alarms off until then (decision 40).
0026 turns each group on once its job runs (decision 71).

## Cost, silence and delivery

| Alarm | Signal | Shape | Fires when | Missing data |
| --- | --- | --- | --- | --- |
| `log-volume` | `AWS/Logs IncomingBytes`, per log group | Level | Above 200 MB in an hour: a coarse ceiling set before any measurement, tightened once the first weeks are read. On with `host` (#113), since an EMF line in our group can name any namespace of the shared account and create custom metrics without limit: this is the only bound on a flood's cost | Ignore: `telemetry-silent` |
| `emf-validation` | `AWS/Logs EMFValidationErrors` for the metrics log group | Event | 1 or more: CloudWatch rejected a line, so its metrics are gone: Event alarms on them read OK, and Level ones keep their last state | Not breaching: written only when a line fails |
| `emf-parsing` | `AWS/Logs EMFParsingErrors` for the metrics log group | Event | 1 or more: a line CloudWatch couldn't parse as EMF | As above |
| `telemetry-silent` | `mem_used_percent` and `disk_used_percent{path="/"}` from the agent: `MIN([FILL(mem, 0), FILL(disk, 0)])` | Silence | 15 minutes of either: agent, credentials or egress, or a config that lost one series (decision 44) | Breaching |
| `facilitator-silent` | `settlement_sweeps_total{outcome:"listed"}`, per network, written every minute once the service has started, 0 included | Silence | 15 minutes. Fires beside `uptime` when the process is down, or when its start hangs or fails, a crash loop included: a start writes the point only once it has started | Breaching |
| `gauges-silent` | The six facilitator gauges' `SampleCount`, and `channel_longest_hold_seconds`'s once `channelHeld` is on, per network, against the sweeps' | Metric math: `(MIN([FILL(g, 0), ...]) < 1) * (FILL(sweeps, 0) >= 1)` at 1, 3 of 3 five-minute periods, with an OK message | A gauge sent no point for 15 minutes while sweeps arrived: its read keeps throwing, and its Level alarm keeps its state (decision 28). Quiet when the whole process is down | Not breaching: the expression always has a value |
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
- `settlement_already_settled_total`, `settlement_nonce_reuse_total` (forged bodies raise it),
  `lease_changes_total` (moves on every deploy).
- `settlement_budget_exhausted_total`: a payment that ran out of time is its payer's answer;
  `pending` covers one of ours that stays open.
- `settlement_reconciled_total` but for `expired`, `settlement_reopened_total`,
  `settlement_lease_fenced_total`, `spend_refused_total`: traffic, read in Logs Insights. A lost
  lease shows in `uptime`.
- `store_prune_failures_total`: a prune that keeps failing grows the tables, which `disk` sees.
- `balance_read_failures_total`: after one failed read the floor keeps the last reading; reads that
  keep failing show in `balance-stale`.
- The catalog's metrics: discovery fails open, and nothing there costs money.
- `spend_budget_nearing_total` for `payer` and `pay_to`: one buyer or seller near its budget is
  the budget working, not something an operator acts on. They also stay out of the billed
  dimensions, as in #105's README.
- `fee_charged_stroops`: read in the weekly review against the balance's change (decision 13). The
  metric is approximate, so the review takes the database as the source of truth.

## Deferred

- The UptoProxy TTL alarm, until `upto` reaches `/settle`: backlog task 0109.
- A cap on a sweep's time, until there are real backlog sizes: backlog task 0110.
- A dashboard and a stuck-alarm digest, until the alarms show they're needed.
- The phone or SMS route, before mainnet (0038).
- The `channel-held` alarm, until 0089's PR.
- An external dead-man's switch for a host outside AWS, which the sibling projects recommend:
  decide before mainnet, with 0038.
