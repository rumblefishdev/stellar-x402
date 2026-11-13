---
title: "Every alarm against what it reads: what can go, and what doesn't carry over"
type: research
status: developing
spawns: []
tags: [monitoring, cloudwatch, grafana, alarms, cost]
links:
  - R-cloudwatch-cost-measurement.md
  - R-logs-cloudwatch-or-loki.md
  - I-grafana-shape.md
  - ../../../../../docs/monitoring.md
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-13"
    status: developing
    who: claude
    note: >
      Inventory read on 2026-11-13 with read-only access. Each claim was checked a second time,
      by reviewers told to refute it, against the code and live CloudWatch.
---

# Every alarm against what it reads

[The measurement](R-cloudwatch-cost-measurement.md) counted what the account pays for. This note
maps each custom metric to the alarms and dashboards that read it, across the three projects, and
checks which can go without losing protection. Read on 2026-11-13 with the read-only role.

## How it was read

- `list-metrics`, `describe-alarms`, `get-dashboard` and 30 days of `describe-alarm-history`, in
  eu-central-1.
- `list-metrics` returns only metrics with a point in the last 14 days. Counters that write only
  when something happens can be missing: the catalog has about 11 such x402 counters with no
  alarm.
- Branches: x402 `develop`, the explorer `master`, the Prices API `develop`. The Prices API deploys
  production from `develop` by hand, and its `master` is 165 commits behind (its task 0343). A
  first pass on its `master` missed deployed alarms.

## The account

|                                            | Prices API | x402 | Explorer | Total |
| ------------------------------------------ | ---------- | ---- | -------- | ----- |
| Custom metrics listed                      | 66         | 55   | 45       | 166   |
| Alarms                                     | 87         | 49   | 19       | 155   |
| Alarms on custom metrics                   | 54         | 43   | 4        | 101   |
| Custom metrics no alarm or dashboard reads | 22         | 18   | 38       | 78    |

- The bill is lower than the listing: about $58 a month at today's inventory, not the $64 ceiling.
  A metric is billed by the hours it has data, and counters that write only on events cost next to
  nothing. October was $42.34, before x402's alarms and before tax.
- Two lines the measurement didn't split:
  - `prices-production-overview` references 59 metrics, over the free 50, so it is billed $3 a
    month.
  - `PutMetricData` calls ran at 1.16M in 30 days, over the free 1M. About 89% come from the
    explorer's indexer, one call per ledger. October's overage was $1.42.

## x402

### What no alarm reads

- **14 `x402-facilitator` series are diagnostics** listed in `docs/monitoring.md`:
  `http_requests_total` per route (6), `balance_read_failures_total`, `catalog_attempts_total`,
  `discovery_unknown_params_total`, `fee_charged_stroops`, `lease_changes_total`,
  `pool_events_total{network}`, `settlement_outcomes_total{result=success}` and
  `settlement_reconciled_total{network}`. About $4.20 a month. Keep them: the move to Prometheus
  replaces the writer anyway, and the Logs Insights recipes and the weekly fee review read the EMF
  line, not the metric.
- **4 `x402-host` series feed alarms that are off until 0026:** `wal_failing`,
  `wal_last_archived_age_seconds`, `backup_age_seconds` and `snapshot_age_seconds`.
  - Three can wait to be written until their job is installed ($0.90 a month). Gate on the
    installed job, not on the stamp, or a job that never succeeds writes nothing and its alarm
    (missing data ignored) stays quiet.
  - The OpenBao snapshot timer is already installed, yet `snapshot_age_seconds` still reads the
    1e9 sentinel. 0026 should check why before `snapshot-age` is turned on.

### Adding pubnet

The alarms in `availability.ts`, `cost-silence.ts`, `money.ts` and `settlement.ts` are made per
network. One more network adds 26 alarms reading 33 alarm metrics (about $3.30 a month) and about
30 custom series ($9 to $13 a month at most, by hours with data). In Grafana `network` is a label
and the rule count stays. `balance-low` and `balance-critical` stay in CloudWatch with
`x402-watch`, so each network still adds 2 alarms there.

### What collapses in Grafana

- **The 11 Event alarms → 1 rule.** `commit-unmatched`, `failure-ours`, `history-gone`,
  `hook-failures`, `http-500`, `landed-after-expired`, `refused-after-verify`,
  `settlement-expired`, `signer-failures`, `store-outage` and `submit-failed` become one rule over
  one counter family, e.g. `increase(x402_events_total[15m]) > 0`, with every closed label value
  pre-set to 0. With the breakers, `facilitator-failed`, `watchdog-restart` and the undeployed
  `verify-rpc-unavailable`, up to 17 → 1.
- **The 3 breaker alarms stay split** by the `breaker` label, as instances of that rule: one series
  let a payer breaker hide a `pay_to` or asset one (0027 decision 63).
- **One rule per check, `network` a label.** Pubnet adds no rules.
- **`disk-root` (> 80%) and `audit-disk` (≥ 90%) → 1 rule with 2 severities.** Both read
  `disk_used_percent{path=/}`. That root filesystem (`/dev/md1` on ch-prod-01) holds ClickHouse's
  `/srv/clickhouse-data`, and the Prices API's `ch-disk-free` watches the same disk, about 1 pp
  apart. A shared rule notifies both teams.
- **`wal-stale`, `backup-age`, `snapshot-age` and 0118's stamp age → 1 rule** over an age family,
  with a limit per check. It needs a last-success timestamp per check: the textfile collector
  re-reads the last file, so a stopped probe freezes healthy values.

### What doesn't carry over as it is

- **`gauges-silent` is not `up == 0`.** It catches a gauge whose read keeps throwing while the
  process runs. With prom-client a throwing `collect()` fails the whole scrape, and a skipped
  `set()` keeps the last value, so neither gives absence. Export a last-successful-read timestamp
  per gauge and alert on its age.
- **`facilitator-silent` maps to `up`** only with No Data set to alerting and a series written
  after start: `up` is 1 during a start that hangs after `listen`.
- **`telemetry-silent` watches the CloudWatch agent's delivery.** The agent stays for the logs
  ([logs](R-logs-cloudwatch-or-loki.md)), so a log-delivery silence alarm stays in CloudWatch
  (`AWS/Logs IncomingLogEvents`, missing data breaching), with `certificate` and
  `credentials-stale`.
- **`probe-silent` needs** `time() - node_textfile_mtime_seconds{file=...}`, with each file written
  through a temporary file and a rename. The probe's one-off events have no textfile form:
  `count` from the watchdog and `stopped` from `ExecStopPost` (`facilitator_failures_total`) need
  counter files kept on disk.
- **The EMF alarms** `emf-parsing`, `emf-validation` and `log-volume-metrics` go with EMF.
  `log-volume-app` stays with the logs.
- **Pull at one point a minute can miss an event** counted just before a crash. The EMF writer's
  `eager-first` mode exists for that (`packages/metrics-catalog/src/index.ts`). `facilitator-failed`
  and `uptime` still see the crash itself.
- **The facilitator has no `/metrics` yet.** Every rule above waits for the Prometheus adapter.

### Checked and kept

- **`uptime` and `uptime-flapping` as one 7-of-30 alarm.** One page instead of two in the
  2026-11-09 drill, but the merged alarm stays in ALARM about 23 minutes after recovery, so a
  relapse in that time pages nothing. Keep both.
- **`wal-failing` dropped for `wal-stale`.** ADR 0011 defines the WAL alarm as both conditions,
  0026's criteria name it, and a lasting failure would page after about 13 minutes instead of 3.
  Keep both.

## Grafana behaviour that shapes the rules

- **Free plan:** "up to 500 free alert rules, with each alert rule having a maximum of 1000 alert
  instances" (Grafana docs, creating a Grafana-managed rule). The count is not a constraint.
- **Repeats:** a notification policy repeats a standing alert every 4 hours by default. Set it on
  purpose; the explorer's ADR 0054 rule 2 forbids reminders. Whether it can be turned off was not
  confirmed.
- **Errors:** keep the default, where an erroring query raises a `DatasourceError` alert. Set to
  Alerting, it fires the rule's own thresholds with value -1. Route `DatasourceError` and
  `DatasourceNoData` to their own policy, grouped by `datasource_uid`, so a ClickHouse outage is one
  thread, not a message per rule.
- **Instances:** an alert instance is its label set. A series missing for 2 evaluations resolves
  its instance, so a network or check that stops writing resolves quietly unless its series are
  pre-set or a missing-data rule watches them.
- **Ladders:** a threshold ladder (the Prices API's 1/100/10000 rungs) becomes one row per counter
  and rung. A single "highest rung" label sends a false "resolved" on each escalation.
- **ClickHouse:** the data source supports mTLS with a client certificate. That certificate lives
  in Grafana, where the Prices API's `mtls-notafter-probe` doesn't watch its expiry.
- **CloudWatch as a data source:** `GetMetricData` is outside the free 1M API requests, so a
  Grafana panel or rule on a CloudWatch metric costs per metric read.

## Decisions the move runs into

- **ADR 0011:** "Grafana Cloud Free for metrics and alerts. $0, but a second vendor whose alert
  rules sit outside our config. CloudWatch is kept." Rules generated from the catalog answer the
  objection; the ADR still needs the amendment.
- **The explorer's ADR 0054** (outside this project):
  - Rule 1: CloudWatch is the alarm engine for AWS-side signals, with no second notifier.
  - Alternative 1, Grafana Cloud: "REJECTED for now — revisit when more than two people are on
    call, or when retention beyond CloudWatch's is required."
  - Alternative 1b, Prometheus and Grafana on the database box: rejected as "Partially inside the
    system it observes". Alloy on ch-prod-01 only ships metrics and alerting runs in Grafana Cloud,
    but the explorer has to supersede the ADR before its alarms move.

## The explorer and the Prices API

Not this project's work (0138's context). The reductions and gaps found there were handed to those
projects on 2026-11-13: the Prices API's backlog tasks 0344–0347 and an update to its 0093
(stellar-prices-api PR #420), and the explorer's backlog tasks 0670–0673.

- **CloudWatch alone saves about $22 a month across the account**, most of it Container Insights on
  the explorer's Galexie cluster ($11.10: 37 billable metrics, read by one alarm).
- **Fewer pages.** One ingestion-stall alarm in the explorer's production gives 2 pages instead of
  9 over 15 replayed days. The Prices API's `ledger-processor-no-invocations` paged behind
  `rollup-freshness-1m` in all 4 stalls since June.
- **Gaps, not reductions:**
  - the Prices API's `CoarseSweepTableFailures` has no alarm, though a failed table doesn't fail
    the Lambda;
  - `sdex-push-freshness` (Tranche-1 AC #5) can't fire again;
  - two Comet pools dropped trades on 2026-11-10, and no task covered them;
  - the explorer's production has no ingestion-stall alarm;
  - nothing alarms on Galexie's memory, which reached 94–97% of its limit from 09-18 to 10-02 and
    ran at 62–83% in the last 30 days;
  - the explorer's enrichment DLQ alarms have sat in ALARM since 2026-11-05, and their messages
    age out around 2026-11-19.
- **Moving their alarms needs work this note doesn't plan.** Their in-process Lambda counters and
  log metric filters have no Grafana source unless rewritten, for example into ClickHouse. Some
  probes compare against files in their repos (`schema/rollups.sql`, `allowlist.toml`).
