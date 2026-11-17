---
title: "Alarms as early signals: fewer, broader alarms with triage runbooks"
type: generation
status: developing
spawned_from: R-alarm-inventory-and-reductions.md
spawns: []
tags: [monitoring, cloudwatch, prometheus, alarms, runbooks, clickhouse]
links:
  - R-alarm-inventory-and-reductions.md
  - R-cloudwatch-cost-measurement.md
  - S-decision-draft.md
  - ../../../../../docs/monitoring.md
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-16"
    status: developing
    who: claude
    note: >
      Designed across all three projects from the live inventory (155 alarms, 166 custom
      series). Each area plan was challenged by coverage and feasibility reviewers, revised,
      then audited by a completeness critic over three fix rounds. SQL is unverified against
      live data. Backend-agnostic: options A/B/C (self-hosted on ch-prod-01, separate VPS,
      Grafana Cloud) are still open.
  - date: "2026-11-17"
    status: developing
    who: claude
    note: >
      Trimmed to x402 and the account-wide summary after review. Aligned with the ADR 0011
      amendment (option B): Prometheus, Alertmanager and Grafana on the monitoring VM, a
      Prometheus agent on ch-prod-01, the heartbeat as a CloudWatch alarm. The Prices API and
      explorer plans, runbooks and SQL stay in the version before the trim (b99fad33); their
      backlog tasks are in stellar-prices-api#420 and soroban-block-explorer#733.
---

# Alarms as early signals: reduction plan (2026-11-16)

**Sources:** live inventory read on 2026-11-16 with the read-only role (`describe-alarms`, `list-metrics`, `describe-alarm-history` for 30 days), final plans for 5 areas (prices-data, prices-runtime, explorer, x402, cross-cutting) and the skeptics' notes.

**Scope (trimmed 2026-11-17).** This note keeps the design rules of the signals (§2), the
triage tiers T0–T4 (§4), x402's signals and runbooks (§3.3, §4.1) and the account-wide summary
(§1). The other two projects' plans, runbooks and SQL were cut; they stay in the
[version before the trim][pre-trim]. Their findings went to backlog tasks:

- **Prices API:** [stellar-prices-api#420](https://github.com/rumblefishdev/stellar-prices-api/pull/420),
  backlog tasks 0344–0347 and an update to 0093.
- **Explorer:** [soroban-block-explorer#733](https://github.com/rumblefishdev/soroban-block-explorer/pull/733),
  backlog tasks 0671–0674.
- Every alarm against what it reads, for all three:
  [R-alarm-inventory-and-reductions.md](R-alarm-inventory-and-reductions.md).

**The stack (ADR 0011, amended 2026-11-17, option B).**

- Prometheus, Alertmanager and Grafana run on the monitoring VM `monitoring-hel1-01` (Hetzner
  Cloud CPX12, Helsinki).
- ch-prod-01 runs only a Prometheus agent (agent mode). It scrapes and sends the samples to the
  VM with `remote_write` over mTLS. It has no query API.
- Alertmanager posts to Slack. Grafana shows dashboards only, behind Cloudflare Access.
- CloudWatch keeps the logs, x402-watch, the uptime probe, the certificate, credentials and
  log-delivery alarms, the audit-disk alarm (90%, off-host) and the heartbeat.
- No transition period: the switch (0139) is one change, and every rule is drilled right after it.
- The Prices API keeps its old alarms until Milestone 2 acceptance, except for its own fixes in
  stellar-prices-api#420 (0344–0347), which change some of them before it. The explorer joins
  only after it supersedes its ADR 0054.

**Rules:**
- I count each alarm once. x402's 49 alarms: Appendix A. x402's 55 series: Appendix B. The Prices API and explorer mappings are in the [version before the trim][pre-trim].
- All SQL queries are **unverified-against-live-data**. I wrote them from the schemas and did not run them.
- Schema of `default.*` and `testnet.*` (chain tables): `crates/db-clickhouse/schema/init.sql` (soroban-block-explorer 5b7bd304).
- **New x402 resources (proposed, they do not exist today).** Checked read-only on 2026-11-16: `lambda list-functions`, `sns list-topics`, `ssm describe-parameters`, `logs describe-log-groups`. Runbooks that use them work only after deployment. I mark them *(proposed)*.
  - SSM: `/x402/production/watch-findings-state`.
  - SNS: `x402-production-monitoring-heartbeat` (the heartbeat, ADR 0011), `x402-production-phone` (D11).
  - Metric: `x402-watch` `findings`.
  - Alarms: CW2 `watch-blind`, CW3 `watch-findings`, CW4 `watch-security`, the heartbeat alarm `x402-production-monitoring-heartbeat`, `log-delivery` (successor of `telemetry-silent`), and on pubnet `x402-production-phone-delivery-failed` and `x402-production-sms-spend` (D25).
  - x402-watch finding `section_failed{section,network}` (D24).
- No number comes from outside the inventory, the code or the plans. Where something was not checked, I write "not checked".

**TL;DR**
- **Account-wide CloudWatch alarms: 155 → 29**, plus 3 Prometheus rules for x402 on the monitoring VM. This is the state after the 0139 switch and the explorer's sidecar gate. **Before 0139: ~62** (§1.1).
- **Custom metric series: 166 → 29**, plus 8 Prices series kept conditionally until their events ([before the trim][pre-trim]). Until then, 37. **Before 0139: ~103** (with Container Insights and those 8).
- **CloudWatch cost (billing per metric in an alarm): ~$62.80 → ~$9.60 /month.** Plus ~$4–5 of side costs (GetMetricData, Logs Insights). With the 8 conditional series ~$12.00; before 0139 ~$35.90 (§1.2).
- **x402 after 0139:** 11 CloudWatch alarms (`balance-low`, `balance-critical`, `watch-blind`, `watch-findings`, `uptime`, `uptime-flapping`, `certificate`, `credentials-stale`, `log-delivery`, `audit-disk`, the heartbeat), 3 Prometheus rules (P1–P3) and 6 series. About $3.00 a month at the §1.2 rates (§1.2).
- **x402 runbooks (§4.1): 9 headings, plus CW4 (disabled), the heartbeat and the phone delivery alarms (D25).** With the log-path and `audit-disk` headings, they cover x402's 11 CloudWatch alarms and 3 Prometheus rules. Pubnet adds 5 alarms (§1.1); the balance, CW4 and `phone-delivery` headings cover them.
- **Decisions to make: §6.** x402 money routes (ADR 0011): §3.3. **The phone route does not exist yet** (no SNS topic), so D11 blocks pubnet. Pubnet is also blocked by D21 (CW4 enabled on the phone), D22 (by default waits for 0139), D24 (CW2 does not latch across networks), D25 (SMS delivery alarms; today an SMS limit of $1/month and sandbox), D26 (source of the pubnet fee account) and D30 (x402-watch reads pubnet).

---

## 1. Results in numbers

### 1.1 Alarms and series

| Project | Alarms before | Alarms after (CloudWatch) | Custom series before | Custom series after |
|---|---|---|---|---|
| Prices API (data + runtime) | 87 | **13** | 66 | **16** |
| Explorer (prod + testnet) | 19 | **5** | 45 | **7** |
| x402 | 49 | **11** (+3 Prometheus rules) | 55 | **6** |
| **Total** | **155** | **29** (+3) | **166** | **29** |
| *Until 0242 closes and M2 acceptance (8 conditional Prices)* | | *29* (+3) | | *37* (24 + 7 + 6) |
| *State before 0139, sidecar gate open* | | *~62* (13 + 6 + 43) | | *~103* (24 + 45 + 34) |
| *State before 0139, after the sidecar gate* | | *~61* (13 + 5 + 43) | | *~65* (24 + 7 + 34) |
| *With x402 pubnet, after 0139 (D21, D25)* | | *34* (+3) | | *31* (29 + 2) |

x402 pubnet (after 0139) adds 5 alarms and 2 series:
- alarms: `balance-low-pubnet`, `balance-critical-pubnet`, CW4 `watch-security` (enabled, D21) and 2 phone route delivery alarms (D25);
- series: `x402-watch/spendable_stroops{network=stellar:pubnet}` and `x402-watch/security_findings` (CW4, "FUTURE" in the x402 plan). The D25 alarms read AWS/SNS metrics, not custom ones.
- Prometheus rules unchanged (+3): pubnet is a `network` label, not a new rule.

State before 0139 (Prices counted with the 8 conditional series, 16 + 8 = 24, because 0242 and M2 acceptance are not closed):
- x402 then keeps 43 alarms: 10 target CW alarms (all but the heartbeat, which comes with the VM) and 33 old alarms behind P1 (19), P2 (5) and P3 (9). P1–P3 have nowhere to run without Prometheus.
- x402 keeps 34 series: 6 target series and 28 series read by those 33 alarms. They move to Prometheus only in 0139 (in App. B: "conditionally, until 0139").
- Upper bound: +18 x402 series with fate drop (App. B), if they do not disappear from EMF before 0139. Then ~121 with CI.
- Explorer until the sidecar gate: 6 alarms (5 target ones and `production-galexie-ephemeral-storage`) and 38 Container Insights series.

Where these numbers come from:
- **Prices API 13 alarms and 16 series (+8 conditional), explorer 5 alarms and 7 series:** the per-signal breakdown is in the [version before the trim][pre-trim] (§3.1, §3.2, Appendices A and B). They are a plan: stellar-prices-api#420 and soroban-block-explorer#733 take only part of it, and differ in places (Oskar's review of #420, 2026-11-17).
- **x402 11 CW:** `balance-low`, `balance-critical`, `watch-blind`, `watch-findings`, `uptime`, `uptime-flapping`, `certificate`, `credentials-stale`, `log-delivery`, `audit-disk` and the heartbeat `x402-production-monitoring-heartbeat` *(proposed)*. `log-delivery` and the heartbeat read AWS/Logs and AWS/SNS metrics, not custom ones.
- **x402 3 Prometheus rules (on the VM):** `x402-settlement`, `x402-money`, `x402-runtime`.
- **x402 series 6:** `ready`, `spendable_stroops`, `findings` (new), `disk_used_percent`, `certificate_days_left` and `credentials_age_seconds`. Unconditionally only after 0139. Before that 34 (see above).
- **Not counted:** the infrastructure rules on the VM from ADR 0011: the Watchdog, the failed-notification rule and the rule for ch-prod-01's agent gone quiet. They are not among P1–P3.

Noise today (inventory):
- In total 251 `alarm_transitions_30d` transitions (per the explorer skeptic, the counter also includes ALARM→OK).
- 99 of the 155 alarms had 0 transitions in 30 days.
- Loudest: `prices-production-ledger-processor-unregistered-pool` 80, `production-ingestion-backlog-age` 14, `production-galexie-ingestion-lag` 14.
- Currently in ALARM: `prices-production-coverage-sweep-unclassified`, `prices-production-ledger-processor-unregistered-pool`, `production-enrichment-dlq-depth`, `testnet-enrichment-dlq-depth`.

### 1.2 CloudWatch cost / month

Rates: $0.30 per series-month (billed by the hours a series has data), $0.10 per **metric in an alarm** (a metric-math alarm pays for each metric), after 10 free. AWS-native alarms stay in CloudWatch.

| | Before | After | *Before 0139 (sidecar open)* |
|---|---|---|---|
| Metrics in alarms | 170 → (170−10)×$0.10 = **$16.00** | ~49 → (49−10)×$0.10 = **$3.90** | *~90 → ~$8.00* |
| Custom series | (166−10)×$0.30 = **$46.80** | (29−10)×$0.30 = **$5.70** | *(103−10)×$0.30 = $27.90* |
| **Total** | **$62.80** | **$9.60** | *~$35.90* |

Caveats:
- 170 metrics counted from `MetricMath` in the inventory. After: ~49 (prices-data 6, prices-runtime ~24, explorer 7, x402 12).
- After, with the 8 conditional series: (37−10)×$0.30 = $8.10 + $3.90 = **~$12.00**. No target alarm reads them, so metrics in alarms are unchanged.
- Before 0139: 103 series (24 Prices with the conditional ones, 45 explorer, 34 x402). 48 (the 49 without the heartbeat) + 40 metrics of the 33 old x402 alarms + 2 `galexie-ephemeral-storage` metrics = ~90. Estimate.
- On a "$0.10 per alarm" basis it would come out to $61.30 → $7.60. I do not use that number.
- **x402 alone after 0139:** 12 metrics in alarms × $0.10 + 6 series × $0.30 = **~$3.00 /month**. The account is past the 10 free, so each x402 metric pays the full rate. This assumes each series has data every hour; logs and the x402-watch findings side cost (about $0.43) come on top.
- **Explorer task 0673 removes 38 Container Insights series anyway.** The fair "after 0673" baseline is 128 series, about $51.40/month (per metric). This plan goes down from it to $9.60.
- **New side costs (estimates from the plans, not measured):** ~$4–5 /month on top of $9.60. Of these, x402-watch findings cost about $0.43. The rest is the explorer evaluators' GetMetricData and the Prices API's Logs Insights scan and notifier (their PRs).
- **Variants that depend on gates:**
  - Explorer has 6 alarms until the sidecar gate and keeps Container Insights.
  - Pubnet for x402 (after 0139) adds 5 alarms (balance-low and balance-critical `-pubnet`, CW4 `watch-security` per D21, 2 D25 alarms) and 2 series (`spendable_stroops{pubnet}`, `security_findings`). That is +5 metrics in alarms and +2 series, about +$1.10 /month.
  - Pubnet before 0139 (variant D22) would require about 26 `-pubnet` copies, plus CW4 and 2 D25 alarms.

---

## 2. Pattern

### 2.1 Signal
- One alarm per area. Its value is a **number or a set of named causes**, not a single threshold value.
- The cause names (check_id, bit, label `cause`) tell the agent which runbook step to start from.
- Only these stay separate:
  - money signals on mainnet (ADR 0011: breaker, low balance, pending) and security signals (ADR 0013 via ADR 0011: theft, backup secret read). Their phone route is **designed, but does not exist**: there is no phone topic today (D11). Condition assignment: §3.3, table "Money routes";
  - signals that must work when ch-prod-01, the monitoring VM or an evaluator is dead (DLQ, dead-man's, the heartbeat, uptime).
- To phone (pubnet) in the x402 plan: P2, balance-low/critical, CW2 `watch-blind`, the heartbeat alarm (the plan had it as a CW3 finding, `monitoring_deadman`), the `audit-disk` alarm, and CW4 (security route; CW4 must be enabled before pubnet, D21).
- Outside the plan, default in this report (§6): sweeps_stopped, check_error for pending, landed_after_expired, commit_unmatched (D1), P2 blindness (D2), `log-delivery` (D3) and the per-network `section_failed{section,network}` from x402-watch (D24) also go to phone on pubnet.
- Silence of the phone route itself (failed delivery, exhausted SMS limit) goes to Slack (D25). Full route table: §3.3.

### 2.2 Anti-latching: how a new cause gets through when the alarm is already in ALARM

| Area | Mechanism | Where the state is | Known limit |
|---|---|---|---|
| x402 CloudWatch | x402-watch (off-server) holds named findings and publishes each new one to SNS itself | SSM `/x402/production/watch-findings-state` *(proposed)* | Broader IAM for the watch Lambda (D19) |
| x402 CW2 `watch-blind` | Today: MAX(Invocations<1, Errors>=1), and `runBalance` throws on every failed network, so flaky testnet RPC holds CW2 in ALARM and a pubnet section failure gives no new message (`docs/monitoring.md`: "While this alarm stays in ALARM, a failure of the other section sends no new message"). `balance-*-pubnet` (TreatMissingData ignore) then hold the old state. Default (D24): a failed section does not throw, the Lambda publishes the finding `section_failed{section,network}` like any other finding (pubnet: phone). CW2 catches only a dead or crashing Lambda | Like CW3: SSM `/x402/production/watch-findings-state` *(proposed)* | Lambda down entirely while CW2 is already in ALARM: no new message, but then both networks are blind at once and the page has already gone out |
| x402 Prometheus (VM) | Alertmanager on the monitoring VM, `group_interval 5m`. `group_by`: P1 `[alertname, network]`, P2 `[alertname, network, cause, breaker]`, P3 `[alertname, cause]` (as in the x402 plan) | Alertmanager | Events counted just before a crash are lost in the counter (accepted, triage reads the logs) |

- The Prices API and the explorer build their own mechanisms: an evaluator with state in SSM,
  the `alert-notifier` Lambda, and `*-new-cause` edge alarms. They are in their PRs. Four
  mechanisms in all, with x402-watch's findings: D15.
- The heartbeat is not a re-notify mechanism. The Watchdog route has its own `group_interval 1m`
  and `repeat_interval 1m`, so Alertmanager sends it to SNS every minute (§3.3).

Plus two mechanisms taken from cross-cutting:
- **P6, daily digest of hanging alarms:** already exists in the Prices API (`packages/mtls-notafter-probe/src/alarm_digest.rs`, task 0214). Change: a list of prefixes instead of `prices-{env}-`.
- **P7, daily sweep of new error signatures (agent, read-only):**
  - `--log-group-names` does not accept wildcards. First a list of groups from `describe-log-groups`. 2026-11-16: 24 existing groups match the prefixes below, including `/ecs/production/galexie-live` and `/x402/production/metrics`. After the proposed Lambdas are deployed, 4 more are added (`prices-production-data-health-evaluator` and `-alert-notifier` via the prefix `prices-production-`, and both `*-explorer-signal-evaluator`), 28 in total. The start-query limit is 50.
  - Log format of `/ecs/production/galexie-live` (JSON or `level=error` in text): not checked, hence `level=error` in the regex.
  - `/x402/production/app` logs `level` in lowercase ("error"), the Prices and explorer Lambdas in uppercase ("ERROR").
  ```
  G=$(for p in /aws/lambda/prices-production- /aws/lambda/production-soroban-explorer- /aws/lambda/testnet-soroban-explorer- /aws/lambda/production-explorer-signal-evaluator /aws/lambda/testnet-explorer-signal-evaluator /aws/lambda/production-galexie-protocol-watch /aws/lambda/x402-production- /ecs/production/galexie-live /x402/production/app /x402/production/metrics; do aws logs describe-log-groups --profile soroban-readonly --region eu-central-1 --log-group-name-prefix $p --query 'logGroups[].logGroupName' --output text; done | tr '\t' ' ')
  Q='filter level in ["ERROR","error"] or @message like /Task timed out|Runtime\.ExitError|panicked|watch_section_failed|level=error/ | fields @timestamp, @log, coalesce(fields.message, event, msg) as sig | stats count(*) as n, earliest(@timestamp) as first by @log, sig | limit 10000'
  NOW_S=$(date +%s)
  for W in "$((NOW_S-86400)) $NOW_S" "$((NOW_S-691200)) $((NOW_S-86400))"; do
    set -- $W
    QID=$(aws logs start-query --profile soroban-readonly --region eu-central-1 --log-group-names $G --start-time $1 --end-time $2 --query-string "$Q" --query queryId --output text)
    sleep 20
    aws logs get-query-results --profile soroban-readonly --region eu-central-1 --query-id "$QID" --output json > "${WORKDIR}/p7-$1.json"
  done
  # report the (@log, sig) pairs found only in the now-24h..now window (the first file); status Running → repeat get-query-results
  ```
  Bash: `$G` and `$W` stay unquoted on purpose, so they split into words. In zsh (macOS), write `${=G}` and `${=W}`.

### 2.3 Silence = failure
- Every producer that can die has a silence deadline or a separate native dead-man. For x402:
  - CW2 `watch-blind` (x402-watch itself) and `log-delivery` (the CloudWatch agent on ch-prod-01);
  - the heartbeat alarm in CloudWatch: Prometheus, Alertmanager or the monitoring VM gone quiet (ADR 0011);
  - the rule on the VM for ch-prod-01's agent gone quiet (ADR 0011);
  - P2 `x402-money`: a separate silence clause in §3.3;
  - a single x402-watch section for one network: the finding `section_failed{section,network}` (D24), because CW2 may already be in ALARM;
  - the phone route itself (pubnet): 2 delivery alarms to Slack and a weekly SMS drill (D25).
- The Prices API's and the explorer's dead-man's, and the Prices API's disclosed blind spot (a fully dark API), are in their PRs.
- A read that failed is `not_run` or `check_error`, never a healthy 0.
- What watches ch-prod-01 is computed off it: the uptime probe, x402-watch and the Lambda evaluators in AWS, and Prometheus on the VM. What watches the VM is in AWS: the heartbeat alarm.

### 2.4 Runbook format for the agent (skeleton from cross-cutting)
```
runbook: <signal id>
inputs: alarm_name; t0 = StateTransitionedTimestamp (not StateUpdatedTimestamp); reason = StateReasonData
guard: AWS only describe/list/get/filter with --profile soroban-readonly --region eu-central-1; ClickHouse only SELECT;
       never receive-message / redrive / purge / writes over SSH; Code 497 → record ACCESS_DENIED and go on on the AWS side;
       CH timeout → cause CH_UNREACHABLE; a step with kind=other/HUMAN-ONLY → hand over to a human
steps: { id, ask (yes/no), kind, run (exact command with ${vars}), parse, branch: [{when, then: cause:<ID> | goto:<step>}], tells_apart }
exit: one cause, or UNKNOWN with the collected results → escalate to the topic owners
record: alarm, term/contributor, t0, cause, evidence → incident note
```
P0, preflight before every runbook:
```
aws cloudwatch describe-alarms --state-value ALARM --profile soroban-readonly --region eu-central-1 --query 'MetricAlarms[].[AlarmName,StateTransitionedTimestamp]' --output text
-- ClickHouse:
SELECT version(), uptime(), now();
SELECT user, exception_code, count() n, any(left(exception,160)) sample FROM system.query_log WHERE event_time > now() - INTERVAL 30 MINUTE AND exception_code != 0 GROUP BY user, exception_code ORDER BY n DESC LIMIT 20;
aws cloudformation list-stacks --stack-status-filter UPDATE_COMPLETE CREATE_COMPLETE UPDATE_ROLLBACK_COMPLETE --profile soroban-readonly --region eu-central-1 --query 'StackSummaries[].[StackName,LastUpdatedTime]' --output text
```

### 2.5 Checks at the switch
- **No shadow period** (decided 2026-11-17): the new signals replace the old alarms in one change, with no period of both. The checks below run right after that change, and a signal that fails one is fixed forward.
- **Two simultaneous failures test:** one page plus one "NEW cause" post, then a separate "cleared".
- **Metric-math drills:**
  - DR2: FILL on a fully empty series and on a period being filled, DIFF at N=1;
  - DR3: operators and REPEAT in the expression, 10-metric limit;
  - DR4: each signal with a stopped producer (for the heartbeat: Alertmanager stopped on the VM).
  - (DR prefix, so as not to confuse with decisions D1–D30 in §6.)
- **ADR 0011:** a deploy of the alarms is done only when a test alarm reaches Slack and a person sees it. Since 0139 that takes two tests: one alert from Alertmanager and one alarm from CloudWatch.

### 2.6 Resolving overlaps (how I count)
- The overlaps between the Prices API's data and runtime plans are resolved in stellar-prices-api#420.
- **cross-cutting vs areas:** the cross-cutting plan covers 60 alarms: 49 in SIG-01..09, 3 kept (`x402-production-watch-no-invocations`, `x402-production-watch-errors`, `production-galexie-protocol-watch`) and 8 rejected (7× `*-duration-near-timeout`, `oracle-no-invocations`). All 60 already have an owner in the area plans. I count them there (x402: App. A; the rest: their PRs).
  - I do not adopt SIG-xx as alarms. The area plans already compose them without dedicated alarms, so it would not reduce anything, and two signal designs on the same metrics would give double pages.
  - I adopt from cross-cutting: P6, P7, the runbook skeleton, the drills and the requirement for an operator ClickHouse user.
  - Routing recommendation from cross-cutting: `production-galexie-readiness` additionally gets the topics `prices-production-ops-alarms` and `x402-production-alarms`, because a stopped Galexie also stops the Prices feed. Adopted by default, decision D17. Does not change the alarm count.

---

## 3. Signals per project

### 3.1 Prices API

The plan (the signals PD-1 to PD-4, PR-SERVE, PR-INGEST, PR-WORKERS-*, PR-RUNTIME-OUTPUTS and
`alert-notifier-health`, the proposed `prices.data_checks` table, the runbooks with their SQL and
the Prices decisions) is in the [version before the trim][pre-trim]. The review's findings are
backlog tasks 0344–0347 and an update to 0093, in
[stellar-prices-api#420](https://github.com/rumblefishdev/stellar-prices-api/pull/420). The old
Prices alarms stay until Milestone 2 acceptance, except for what 0344–0347 change. Summary
numbers: 87 → 13 alarms and 66 → 16 series (+8 conditional), §1.1.

### 3.2 Explorer

The plan (the production and testnet signals `*-explorer-signal` with `*-new-cause`,
`production-galexie-readiness`, the runbooks and the explorer decisions) is in the
[version before the trim][pre-trim]. The review's findings are backlog tasks 0671–0674, in
[soroban-block-explorer#733](https://github.com/rumblefishdev/soroban-block-explorer/pull/733).
The explorer joins only after it supersedes its ADR 0054. Summary numbers: 19 → 5 alarms and
45 → 7 series, §1.1.

### 3.3 x402

| Signal | Trigger | Replaces | Custom metric? |
|---|---|---|---|
| CW1 `uptime` | `x402-watch/ready` Min < 1 for 7 of 7 min, breaching (uptime-probe via Cloudflare) | 1 | yes (kept) |
| CW2 `watch-blind` | MAX(Invocations < 1, Errors >= 1) of the watch Lambda, 2 of 3×5 min, breaching. On pubnet it also goes to the phone. By default (D24) a failed network section does not count in Errors, it becomes a `section_failed{section,network}` finding instead (§2.2) | 2 | no |
| CW3 `watch-findings` | Number of held findings in x402-watch: protocol_changed/upgrade_coming, log_flood, upstream_*. Alarm to Slack; the Lambda itself posts every new finding. The plan's findings `monitoring_deadman`, `agent_silent` and `audit_disk` are CloudWatch alarms of their own here (ADR 0011): the heartbeat, `log-delivery` and `audit-disk` (below) | 6 | yes (`findings`, new; replaces 4 protocol series) |
| CW4 `watch-security` | Designed, disabled until decision 68: account_state, account_effects, backup_secret_read. >= 1, 300 s, 1 of 1, TreatMissingData ignore (CW2 guards the Lambda). On pubnet **security route and phone** (plan); the Lambda itself posts every finding (decision 64). Never folded into CW3 | 0 | future |
| P1 `x402-settlement` (Prometheus, VM) | 13 event causes `x402_events_total{cause}` (increase > 0 in 15 min), 8 checks `x402_check_failing{cause}` == 1, `check_error`, openbao | 19 (alarm → cause in App. A) | Prometheus (not billed) |
| P2 `x402-money` (Prometheus, VM; phone on pubnet) | breaker_opened{breaker}, budget_nearing, pending; never inhibited | 5 | Prometheus |
| P3 `x402-runtime` (Prometheus, VM) | 9 causes: facilitator_unscraped, selfcheck_stalled, series_missing, host_probe_stale, disk (80%), disk_series_stale, memory, facilitator_failed, watchdog_restart | 9 (alarm → cause in App. A) | Prometheus (+ node_exporter) |
| Heartbeat `x402-production-monitoring-heartbeat` *(proposed)* | CloudWatch alarm on AWS/SNS `NumberOfMessagesPublished` of the topic `x402-production-monitoring-heartbeat`, missing data breaching. Fed by the always-firing Watchdog rule, which Alertmanager sends to the topic every minute (its route has `group_interval 1m` and `repeat_interval 1m`). Fires when Prometheus, Alertmanager or the VM goes quiet (ADR 0011). To Slack; on pubnet also to the phone | 0 (new) | no (AWS/SNS) |
| `log-delivery` *(proposed)* | AWS/Logs `IncomingLogEvents` of `/x402/production/app`, missing data breaching: the CloudWatch agent, its credentials or the server's way out is down | 1 (`telemetry-silent`) | no (AWS/Logs) |

**Stay separate:**
- `uptime-flapping`, as decided in 0138. After merging, a recurrence within ~23 min after recovery would be invisible.
- `balance-low-testnet` and `balance-critical-testnet`: this is money in the sense of ADR 0011. Critical without low means a sudden drop, i.e. a theft indicator.
- `certificate` (the Roles Anywhere certificate expiring within 30 days) and `credentials-stale`, with `log-delivery` above: they watch the CloudWatch agent's log path, which stays in CloudWatch (ADR 0011). Their series `certificate_days_left` and `credentials_age_seconds` stay in CloudWatch too.
- `audit-disk` (`disk_used_percent{path=/}` Max >= 90): at 90% OpenBao's audit log can't grow and signing stops (ADR 0013), so it stays off the server and pages when the VM can't.

**Rejected from CloudWatch:**
- `settlement_outcomes_total{success}`, `settlement_reconciled_total{network}` (total; `{state=expired}` → P1), `lease_changes_total`, `balance_read_failures_total`, `discovery_unknown_params_total`, `catalog_attempts_total`, `pool_events_total{network}` (total; `{type=sequence-resync}` → P1);
- 6× `http_requests_total` per route;
- `fee_charged_stroops`: moves to Prometheus, ClickHouse is used only for cross-checking;
- 4 backup/snapshot/WAL series: deferred to 0026.
- These 18 series disappear from CloudWatch in 0139, unless they are removed from EMF earlier.

**Dependency:** P1–P3 run on the monitoring VM from the 0139 switch (ADR 0011, option B): the
agent on ch-prod-01 sends the samples, Prometheus on the VM evaluates, Alertmanager delivers.
- Until 0139, the 33 old alarms behind P1–P3 keep running, and the 28 series they read stay in CloudWatch (§1.1, App. B: "conditional, until 0139").
- `x402-production-emf-parsing` and `emf-validation` (AWS/Logs on `/x402/production/metrics`) lose their purpose after 0139: the EMF path goes away. The successor is the P3 cause `series_missing`. Retire them in the same change that removes the `/x402/production/metrics` log group.
- `make fire-test` today uses `emf-validation` as the Slack test. After 0139 a test is needed for each path: a Prometheus rule through Alertmanager, a CW3 self-post, a plain CW alarm, and the heartbeat (Alertmanager stopped).

**Money routes (ADR 0011, pubnet).** Slack is not a pager. Every money and security condition has a phone/SMS route on pubnet.
- **The phone route does not exist today.** `sns list-topics` (2026-11-16): only `x402-production-alarms` and the Prices and explorer topics. Mechanism, numbers, on-call and credentials: D11, D12.
- "phone" below = the proposed topic `x402-production-phone` (D11). All three paths publish to the same topic: AlarmActions of CW alarms, x402-watch self-post and the SNS receiver of Alertmanager on the VM.
- The "security route" from the CW4 plan has no separate resource. By default it is the same `x402-production-phone` (D11); CW4 stays a separate alarm, never in CW3.
- Gates before pubnet launch (all at once):
  - a test message on `x402-production-phone` reaches a human on the phone (like the ADR 0011 rule for Slack);
  - CW4 `watch-security` is **enabled** (group `watchSecurity` in production.json, decision 68) with AlarmActions on `x402-production-phone`, and one test finding (e.g. a read drill of `x402/production/openbao-backup`) reached the phone. Without this the ADR 0013 conditions from the table below have no live route (D21);
  - 0139 deployed (D22). Pre-0139 variant: below;
  - D24 deployed: a pubnet section that fails produces its own finding to the phone, even when CW2 is in ALARM because of testnet;
  - D25: SMS `MonthlySpendLimit` raised (today `1`, i.e. $1/month, `sns get-sms-attributes` 2026-11-16), account moved out of the SMS sandbox (today `IsInSandbox: true`), both delivery alarms active;
  - x402-watch reads pubnet (D30): `stellar:pubnet` is in `feeAccounts` / `WATCH_TARGETS` and at least one datapoint `x402-watch/spendable_stroops{network=stellar:pubnet}` exists. Without this `balance-*-pubnet` (TreatMissingData ignore) stay silent, and the Lambda does not throw, so it fires neither CW2 nor `section_failed`.

| Condition | Where | Route on pubnet | Source |
|---|---|---|---|
| account_state, account_effects (theft, foreign signer) | CW4 + self-post | security route + phone + Slack | plan; enabling before pubnet: **D21** |
| backup_secret_read (read of the OpenBao backup secret, ADR 0013) | CW4 + self-post | security route + phone + Slack | plan; enabling before pubnet: **D21** |
| pending (record open > 900 s) | P2 | phone + Slack | plan |
| breaker_opened {payer, pay_to, asset} | P2 | phone + Slack | plan |
| budget_nearing | P2 | phone + Slack | plan |
| balance-low, balance-critical | CW (kept) | phone + Slack | plan |
| `watch-blind` (blind balance-* and findings) | CW2 | phone + Slack | plan |
| `section_failed{balance\|findings\|security, stellar:pubnet}` (one pubnet section blind while CW2 is already in ALARM) | x402-watch self-post | phone + Slack | **D24** |
| heartbeat (P1–P3 do not evaluate or do not deliver) | CW alarm `x402-production-monitoring-heartbeat` | phone + Slack | plan (there as the CW3 finding `monitoring_deadman`) |
| `audit-disk` 90% (signing stops) | CW alarm `audit-disk` | phone + Slack | plan |
| sweeps_stopped (the only pending guard when the sweep is suspended) | P1 | phone + Slack | **D1** |
| check_error{check=pending} (pending read throws) | P1 | phone + Slack | **D1** |
| landed_after_expired, commit_unmatched | P1 | phone + Slack | **D1** |
| facilitator_unscraped, selfcheck_stalled, series_missing (P2 blind) | P3 | phone + Slack | **D2**, matcher D16 |
| `log-delivery` (the agent silent, so `audit-disk` is blind) | CW alarm `log-delivery` | phone + Slack | **D3** |
| uptime (CW1), openbao (P1) | CW1, P1 | Slack | open (D4) |
| phone route does not deliver (`NumberOfNotificationsFailed`, SMS limit) | 2 CW alarms on AWS/SNS | Slack (the phone is what is broken) + recurring SMS drill | **D25** |

**Implementation after 0139 (Alertmanager routes, rule count unchanged):**
- P2: route `alertname="x402-money"`, `network="stellar:pubnet"` → phone + Slack (plan).
- D1: route `alertname="x402-settlement"`, `network="stellar:pubnet"`, `cause=~"sweeps_stopped|landed_after_expired|commit_unmatched"` or `cause="check_error", check="pending"` → phone + Slack.
- D2, `series_missing`: has the `network` label (`count by (network)`), so the matcher is `alertname="x402-runtime"`, `cause="series_missing"`, `network="stellar:pubnet"`.
- D2, `facilitator_unscraped` and `selfcheck_stalled`: **no `network` label**. One process serves every network (P3 plan), and P3 groups by `[alertname, cause]`. A matcher with `network="stellar:pubnet"` would never fire. Default: route on `alertname="x402-runtime"`, `cause=~"facilitator_unscraped|selfcheck_stalled"` alone, enabled in the same change that adds `stellar:pubnet` to `config.networks` (D16). Then testnet outages also ring the phone, because it is the same process.

**Before 0139 (pubnet on the old CW alarms): alternative variant D22.** By default pubnet waits for 0139 (D22). If it does start before 0139, it gets copies of the testnet alarms with the `-pubnet` suffix (proposed names, like `-testnet` today). AlarmActions = `x402-production-alarms` + `x402-production-phone` for:
- P2: `x402-production-breaker-opened-pubnet-asset`, `-pay-to`, `-payer`, `x402-production-budget-nearing-pubnet`, `x402-production-pending-pubnet`;
- balance: `x402-production-balance-low-pubnet`, `x402-production-balance-critical-pubnet`;
- D1: `x402-production-sweeps-stopped-pubnet`, `x402-production-landed-after-expired-pubnet`, `x402-production-commit-unmatched-pubnet`;
- D2 (P2 blindness before 0139): `x402-production-facilitator-silent-pubnet`, `x402-production-gauges-silent-pubnet`;
- shared across networks: CW2 `watch-blind` (until it exists: `x402-production-watch-errors` and `-watch-no-invocations`);
- `x402-production-audit-disk` (pager-class: at 90% OpenBao refuses, signing stops) and for D3 `log-delivery` (until it exists: `x402-production-telemetry-silent`).
- The gates from D21 (CW4 on the phone), D24 and D25 also apply in this variant. CW4 and the 2 D25 alarms bring it to ~26 `-pubnet` copies.
- The rest of the pubnet P1/P3 copies: only `x402-production-alarms` (Slack).

**P2 silence clause.** P2 runs in Prometheus on the monitoring VM, so its silence must be seen by signals outside P2:
- Prometheus, Alertmanager or the VM does not evaluate or does not deliver: the Watchdog stops reaching SNS, so the heartbeat alarm `x402-production-monitoring-heartbeat` *(proposed)* fires in CloudWatch (missing data breaching) → Slack, and on pubnet the phone (AlarmActions on `x402-production-phone`).
- All of ch-prod-01 is down: the VM's rule for the agent gone quiet (ADR 0011), plus CW1 `uptime`. The heartbeat stays OK, since the VM is alive. Whether that rule also rings the phone on pubnet is open, the same question as D2.
- The facilitator is not scraped or the check loop is stuck: pending keeps the firing state (HOLD), but new causes do not appear. P3 `facilitator_unscraped` / `selfcheck_stalled` (route without `network`, D16) and `series_missing{network}` → phone (D2).
- Before 0139: P2 silence is seen by `facilitator-silent-*` and `gauges-silent-*` (phone on pubnet, above). Before 0139 there is no heartbeat, and nothing on the VM for it to guard.
- Pending read throws: `check_error{check=pending}` → phone (D1).
- Sweep suspended after a sweep with no open records: pending reads 0. The guard is `sweeps_stopped` → phone (D1).
- x402-watch itself does not work: CW2 `watch-blind` → phone. A single pubnet section fails while CW2 is already in ALARM: `section_failed{...,stellar:pubnet}` → phone (D24).
- The phone does not deliver (SMS rejected, spend limit): D25 alarms → Slack. Without them each of the paths above ends in silence.
- Accepted loss: a breaker_opened counted right before a crash. After every restart the agent reads the logs (P2 step 2).

---

## 4. Triage runbooks

Common:
- **T0, session variables (once, before each runbook; bash with GNU coreutils):**
  ```
  WORKDIR=$(mktemp -d); ALARM='<alarm name>'
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  T0=$(aws cloudwatch describe-alarms --alarm-names "${ALARM}" --profile soroban-readonly --region eu-central-1 --query 'MetricAlarms[0].StateTransitionedTimestamp' --output text)
  T0_MINUS_2H=$(date -u -d "@$(( $(date -u -d "${T0}" +%s) - 7200 ))" +%Y-%m-%dT%H:%M:%SZ)
  ```
  macOS (BSD `date`): `date -u -r $(( $(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${T0%%.*}" +%s) - 7200 )) +%Y-%m-%dT%H:%M:%SZ`.
- **T1, reading the terms of a metric-math alarm:**
  ```
  aws cloudwatch describe-alarms --alarm-names ${ALARM} --profile soroban-readonly --region eu-central-1 --query 'MetricAlarms[0].Metrics[?MetricStat]' --output json | jq 'map(.ReturnData=true)' > ${WORKDIR}/q.json && aws cloudwatch get-metric-data --metric-data-queries file://${WORKDIR}/q.json --start-time ${T0_MINUS_2H} --end-time ${NOW} --profile soroban-readonly --region eu-central-1 --query 'MetricDataResults[].[Id,Label,Values[0:8]]' --output json
  ```
- **T2, running a Logs Insights query.** Every logs step names its log group (`-- log group:` or the parenthesis in the heading). `${QUERY}` is the query text from the step.
  ```
  QID=$(aws logs start-query --profile soroban-readonly --region eu-central-1 --log-group-names ${LOG_GROUP} --start-time $(($(date +%s)-${WINDOW_S})) --end-time $(date +%s) --query-string "${QUERY}" --query queryId --output text); sleep 10; aws logs get-query-results --profile soroban-readonly --region eu-central-1 --query-id $QID --output json
  ```
  → `status` = Running: repeat get-query-results. Several groups: several `--log-group-names`.
- **T3, reading Prometheus state (PromQL) for P1–P3, CW1 step 4 and the heartbeat.** Prometheus and Alertmanager run on the monitoring VM (ADR 0011). ch-prod-01 runs only the agent, which has no query API, so nothing is read there.
  - Operator: an SSH tunnel to the VM, then the HTTP APIs on localhost (default ports; 0139 sets them). `monitoring` is the SSH host for `monitoring-hel1-01`.
    ```
    ssh -N -L 9090:localhost:9090 -L 9093:localhost:9093 monitoring &
    curl -sG http://localhost:9090/api/v1/query --data-urlencode "query=${PROMQL}" | jq '.data.result'
    curl -s 'http://localhost:9093/api/v2/alerts?active=true' | jq '.[] | {a:.labels.alertname,c:.labels.cause,n:.labels.network,since:.startsAt}'
    ```
  - Or Grafana (Explore on the Prometheus datasource), behind Cloudflare Access.
  - The agent has no read path yet, so `promql` steps are **HUMAN-ONLY** until D14. The agent moves to the logs step (`/x402/production/app`) and records `PROMETHEUS_UNREADABLE`.
- **T4, entry before 0139 (33 old CW alarms standing in for P1–P3).** Alarm name → cause from App. A, then the alarm's metric with the **full dimension set taken from the alarm itself** (as in T1). Do not type dimensions by hand: many alarms have several, e.g. `breaker-opened-testnet-*` {breaker, network}, `sweeps-stopped-testnet` {network, outcome=listed}, `failure-ours-testnet` {fault, network}, `pool-health-testnet` {network, type}, `refused-after-verify-testnet` {network, stage}, `settlement-expired-testnet` {network, state}, `http-500` {status=500}, `disk-root` {path=/}, `emf-*` {LogGroupName}. A query with an incomplete set returns 0 datapoints.
  ```
  aws cloudwatch describe-alarms --profile soroban-readonly --region eu-central-1 --alarm-name-prefix x402-production- --state-value ALARM --query 'MetricAlarms[].[AlarmName,StateTransitionedTimestamp,Namespace,MetricName,Threshold]' --output text
  aws cloudwatch describe-alarm-history --profile soroban-readonly --region eu-central-1 --alarm-name ${ALARM} --history-item-type StateUpdate --max-records 5 --query 'AlarmHistoryItems[].[Timestamp,HistorySummary]' --output text
  aws cloudwatch describe-alarms --profile soroban-readonly --region eu-central-1 --alarm-names ${ALARM} --query 'MetricAlarms[0]' --output json > ${WORKDIR}/alarm.json
  jq 'if .MetricName then [{Id:"m",ReturnData:true,MetricStat:{Metric:{Namespace:.Namespace,MetricName:.MetricName,Dimensions:(.Dimensions // [])},Period:.Period,Stat:(.Statistic // .ExtendedStatistic)}}] else [.Metrics[] | select(.MetricStat) | .ReturnData=true] end' ${WORKDIR}/alarm.json > ${WORKDIR}/q.json
  aws cloudwatch get-metric-data --profile soroban-readonly --region eu-central-1 --metric-data-queries file://${WORKDIR}/q.json --start-time $(($(date +%s)-7200)) --end-time $(date +%s) --query 'MetricDataResults[].[Id,Label,StatusCode,Timestamps[0:8],Values[0:8]]' --output json
  ```
  → `if` branch: single-metric alarm; `Dimensions` exactly as in the alarm (also `[]` for `x402-host/*` without dimensions). `else` branch: metric-math alarm, each metric from `Metrics[]` with its own dimensions (same as T1).
  → **0 datapoints does not mean "no events"** until you check that a series with this dimension set exists:
  ```
  aws cloudwatch list-metrics --profile soroban-readonly --region eu-central-1 --namespace $(jq -r '.Namespace // ([.Metrics[] | select(.MetricStat)][0].MetricStat.Metric.Namespace)' ${WORKDIR}/alarm.json) --metric-name $(jq -r '.MetricName // ([.Metrics[] | select(.MetricStat)][0].MetricStat.Metric.MetricName)' ${WORKDIR}/alarm.json) --query 'Metrics[].Dimensions' --output json
  ```
  → Metric-math alarm: repeat for each metric from `Metrics[]`. The alarm's set is on the list: no datapoints = no events in the window (for counters) or a silent producer (gauge; check `facilitator-silent-*` / `gauges-silent-*`). The set is not on the list: the series has not been published for ~2 weeks; record `SERIES_ABSENT`, not "0". Then the logs step of the given runbook.
- AWS commands always with `--profile soroban-readonly --region eu-central-1`.

### 4.1 x402

**Network parameters.** Take the network from the alarm: the `network` label (Prometheus), the `network` field of the finding (x402-watch), or the name suffix (`-testnet` / `-pubnet`). An alarm shared across networks (CW1, CW2, CW3 without `network`): run the steps for each network in `WATCH_TARGETS`, pubnet first. The steps below use only these variables; no value is hardcoded.

| Variable | stellar:testnet | stellar:pubnet | Source |
|---|---|---|---|
| `${NET}` | `stellar:testnet` | `stellar:pubnet` | from the alarm (above) |
| `${DB}` | `testnet` | `default` | chain databases, `crates/db-clickhouse/schema/init.sql` |
| `${HORIZON}` | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` | deployed env `WATCH_PROTOCOL` of the `x402-production-watch` Lambda (from `watch.protocol.<net>.horizonUrl` in `infra/envs/production.json`) |
| `${FEE_ACCOUNT}` | `GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP` | none today (pubnet is not in `feeAccounts`) | deployed env `WATCH_TARGETS` of this Lambda, the same account that `balance-*` read (D26) |
| `${PG_SERVICE}` | `postgres-testnet` | `postgres-pubnet` *(proposed, name by analogy; not in `deploy/production/compose.yaml`)* | `deploy/production/compose.yaml` |
| `${CHANNELS_VAR}` | `CHANNELS_TESTNET` | `CHANNELS_PUBNET` *(proposed)* | `/srv/x402/production/.env` on ch-prod-01 |

```
NET=${NET:?from the alarm: stellar:testnet or stellar:pubnet}
L=$(aws lambda get-function-configuration --function-name x402-production-watch --profile soroban-readonly --region eu-central-1 --query 'Environment.Variables' --output json)
FEE_ACCOUNT=$(echo "$L" | jq -r --arg n "$NET" '.WATCH_TARGETS | fromjson | .[] | select(.network==$n) | .feeAccount')
HORIZON=$(echo "$L" | jq -r --arg n "$NET" '.WATCH_PROTOCOL | fromjson | .[] | select(.network==$n) | .horizonUrl')
if [ "$NET" = stellar:pubnet ]; then DB=default; PG_SERVICE=postgres-pubnet; CHANNELS_VAR=CHANNELS_PUBNET; else DB=testnet; PG_SERVICE=postgres-testnet; CHANNELS_VAR=CHANNELS_TESTNET; fi
```
→ Checked 2026-11-16: `WATCH_TARGETS` has only stellar:testnet; `WATCH_PROTOCOL` has testnet and pubnet.
→ Empty `FEE_ACCOUNT`: the watch Lambda does not read this network, so its `balance-*` see nothing either. Record `FEE_ACCOUNT_UNKNOWN`, skip the on-chain steps and escalate. Do not take the account from the repo or from testnet.
→ In SQL: `{fee_account:String}` = `${FEE_ACCOUNT}`; the agent substitutes `${DB}` in the query text before sending.

#### CW1 uptime (and uptime-flapping)
1. **What the probe saw** (`/aws/lambda/x402-production-uptime-probe`).
   ```
   fields @timestamp, ready, reason
   | filter msg = "uptime_probe"
   | stats count() as n by ready, reason, bin(5m)
   | sort bin(5m) desc
   | limit 60
   ```
   → 502/530: tunnel or Cloudflare. "ready is false": no lease. Alternating 1 and 0: flapping. No lines: the probe itself.
2. **Application lifecycle** (`/x402/production/app`).
   ```
   fields @timestamp, event, @message
   | filter event in ["listening","startup_failed","shutdown_started","shutdown_drained","shutdown_deadline","lease_acquired","lease_lost","lease_acquire_failed","lease_released","migrated"]
   | sort @timestamp desc
   | limit 50
   ```
3. **Do settlements still land on-chain?**
   ```sql
   WITH
     (SELECT id FROM ${DB}.accounts FINAL WHERE account_id = {fee_account:String} LIMIT 1) AS fee_id,
     (SELECT max(sequence) - 720 FROM ${DB}.ledgers) AS since
   SELECT toStartOfFiveMinutes(closed_at) AS bucket,
          count() AS settlements, countIf(successful) AS landed_ok, countIf(NOT successful) AS landed_failed,
          sum(fee_charged) AS fee_stroops
   FROM (
     SELECT t.hash AS hash, any(t.successful) AS successful, any(t.fee_charged) AS fee_charged, any(l.closed_at) AS closed_at
     FROM ${DB}.transactions AS t
     INNER JOIN ${DB}.ledgers AS l ON l.sequence = t.ledger_sequence
     WHERE t.ledger_sequence >= since AND l.sequence >= since
       AND t.inner_tx_hash IS NOT NULL
       AND (t.ledger_sequence, t.application_order) IN (
             SELECT ledger_sequence, application_order FROM ${DB}.transaction_participants
             WHERE account_id = fee_id AND ledger_sequence >= since)
     GROUP BY t.hash)
   GROUP BY bucket ORDER BY bucket
   ```
   → They land, but the probe shows 0: the problem is on the external path. 0 where there used to be traffic: the facilitator really is not settling.
4. **On-host causes** (after 0139: T3, HUMAN-ONLY until D14; before 0139: T4).
   ```promql
   ALERTS{alertname=~"x402-(runtime|settlement|money)", alertstate="firing"}
   ```
   → Nothing firing while CW1 is in ALARM: the cause is off the host (Cloudflare, tunnel). No access: P3 step 2 (logs) and `PROMETHEUS_UNREADABLE`.

#### CW2 watch-blind
1. **No runs or failing runs?**
   ```
   S=$(date -u -d '-1 hour' +%FT%TZ 2>/dev/null || date -u -v-1H +%FT%TZ); E=$(date -u +%FT%TZ); for m in Invocations Errors Throttles; do echo "== $m"; aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name $m --dimensions Name=FunctionName,Value=x402-production-watch --statistics Sum --period 300 --start-time $S --end-time $E --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text --profile soroban-readonly --region eu-central-1; done
   ```
2. **Sections** (`/aws/lambda/x402-production-watch`).
   ```
   fields @timestamp, msg, section, network, error
   | filter msg in ["watch_section_failed","watch_protocol","watch_balance","watch_finding"] or @message like /Task timed out|AccessDenied/
   | sort @timestamp desc
   | limit 60
   ```
   → `watch_section_failed` for more than one network or section: each one is a separate cause. Before D24 only the first one paged (CW2 latches), so do step 4 for **each** network, pubnet first.
3. **Schedule and function.**
   ```
   aws scheduler get-schedule --name x402-production-watch --query '[State,ScheduleExpression]' --output text --profile soroban-readonly --region eu-central-1; aws lambda get-function-configuration --function-name x402-production-watch --query '[State,LastUpdateStatus,LastModified]' --output text --profile soroban-readonly --region eu-central-1
   ```
4. **Balance straight from Horizon** (the money alarms are blind during this time).
   ```
   curl -s "${HORIZON}/accounts/${FEE_ACCOUNT}" | jq '([.balances[] | select(.asset_type=="native")][0]) as $n | {spendable_xlm: ([(($n.balance|tonumber) - (2 + .subentry_count + (.num_sponsoring // 0) - (.num_sponsored // 0)) * 0.5 - ($n.selling_liabilities|tonumber)), 0] | max), balance: $n.balance, selling_liabilities: $n.selling_liabilities, subentries: .subentry_count, signers: .signers, thresholds: .thresholds}'
   ```
   → I compute `spendable_xlm` like `spendable_stroops` in `packages/signer-pool/src/balance.ts`: balance − (2 + subentries + sponsoring − sponsored) × 0.5 XLM − selling liabilities, min 0. `.balance` alone overstates it by the reserve.
   → `spendable_xlm` < 25 (`balanceLowStroops` 250000000) or < 10 (`balanceCriticalStroops` 100000000): top-up. Signers changed: CW4 triage.

#### CW3 watch-findings
1. **Sustained findings** (T2, `/aws/lambda/x402-production-watch`, 24 h; the `watch_finding` lines will appear with the new findings section).
   ```
   fields @timestamp, finding, network, state, value
   | filter msg = "watch_finding"
   | stats earliest(@timestamp) as since, latest(state) as now, latest(value) as v by finding, network
   | sort since desc
   ```
2. **log_flood** (T2, 1 h, log group from the finding: `/x402/production/app` or `/x402/production/metrics`).
   ```
   stats count() as n, sum(strlen(@message)) as bytes by @logStream, event
   | sort bytes desc
   | limit 20
   ```
3. **protocol_changed.**
   ```sql
   SELECT 'stellar:testnet' AS network, argMax(protocol_version, sequence) AS protocol, max(sequence) AS ledger, max(closed_at) AS closed
   FROM testnet.ledgers WHERE sequence > (SELECT max(sequence) - 200 FROM testnet.ledgers)
   UNION ALL
   SELECT 'stellar:pubnet', argMax(protocol_version, sequence), max(sequence), max(closed_at)
   FROM default.ledgers WHERE sequence > (SELECT max(sequence) - 200 FROM default.ledgers)
   ```
   → Then P1 step 2. If the logs show no SDK errors, raise `watch.protocol.expected` and `supported` (this is a redeploy of the Watch stack).
4. **upstream** (T2, `/aws/lambda/x402-production-watch`, 72 h).
   ```
   fields @timestamp, msg, section, error, files
   | filter msg in ["watch_upstream","watch_section_failed"] and (section = "upstream" or msg = "watch_upstream")
   | sort @timestamp desc
   | limit 10
   ```

#### Log path: `log-delivery`, `credentials-stale`, `certificate` (kept in CloudWatch)
These three watch the CloudWatch agent's log path, which stays in CloudWatch (ADR 0011):
- `log-delivery` *(proposed, successor of `telemetry-silent`)*: AWS/Logs `IncomingLogEvents` of `/x402/production/app`, missing data breaching.
- `credentials-stale`: `x402-host/credentials_age_seconds` too old: the signing helper's hourly run failed twice.
- `certificate`: `x402-host/certificate_days_left` under 30: the Roles Anywhere certificate the agent ships logs with expires soon.

1. **Is the host alive?**
   ```sql
   SELECT uptime() AS ch_uptime_s, now() AS server_now, version() AS ch_version
   ```
2. **Roles Anywhere, streams and the deployed certificate.** I read the certificate from what AWS saw at the last authentication, not from the copy in the repo.
   ```
   aws rolesanywhere list-subjects --query 'subjects[].[subjectId,x509Subject,lastSeenAt,enabled]' --output text --profile soroban-readonly --region eu-central-1; aws logs describe-log-streams --log-group-name /x402/production/app --order-by LastEventTime --descending --max-items 10 --query 'logStreams[].[logStreamName,lastEventTimestamp]' --output text --profile soroban-readonly --region eu-central-1
   SID=$(aws rolesanywhere list-subjects --profile soroban-readonly --region eu-central-1 --query "subjects[?x509Subject=='CN=x402-cloudwatch-agent-production'].subjectId | [0]" --output text); aws rolesanywhere get-subject --profile soroban-readonly --region eu-central-1 --subject-id $SID --query 'subject.credentials | sort_by(@,&seenAt)[-1].[seenAt,failed]' --output text; aws rolesanywhere get-subject --profile soroban-readonly --region eu-central-1 --subject-id $SID --query 'subject.credentials | sort_by(@,&seenAt)[-1].x509CertificateData' --output text | openssl x509 -noout -enddate -serial
   for m in certificate_days_left credentials_age_seconds; do echo "== $m"; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace x402-host --metric-name $m --start-time $(($(date +%s)-86400)) --end-time $(date +%s) --period 3600 --statistics Minimum --query 'sort_by(Datapoints,&Timestamp)[-3:].[Timestamp,Minimum]' --output text; done
   ```
   → Checked 2026-11-16: `x509CertificateData` is PEM, last used every hour, notAfter 2027-11-05. `lastSeenAt` old: the agent is not authenticating (credentials helper, egress). `failed = True`: cert rejected. notAfter < 30 days: renew.
3. **HUMAN-ONLY: the agent and its signing helper on ch-prod-01.**
   ```
   systemctl status amazon-cloudwatch-agent --no-pager && sudo journalctl -u x402-cloudwatch-credentials -n 20 --no-pager
   ```
   → Renewal and the helper's settings: `docs/runbook.md`, "The CloudWatch agent".

#### audit-disk (kept in CloudWatch)
`x402-host/disk_used_percent{path=/}` Max >= 90, from the CloudWatch agent. At 90% OpenBao's audit log can't grow and signing stops (ADR 0013). P3 `disk` (80%) on the VM fires first.
1. **Who filled the disk.**
   ```sql
   SELECT name, formatReadableSize(free_space) AS free, formatReadableSize(total_space) AS total, round(100 * (1 - free_space / total_space), 1) AS used_pct FROM system.disks;
   SELECT database, formatReadableSize(sum(bytes_on_disk)) AS size, sum(bytes_on_disk) AS b FROM system.parts WHERE active GROUP BY database ORDER BY b DESC;
   ```
   → Growth in CH: the CH owners. CH flat: Postgres WAL, pgBackRest, logs, OpenBao, Docker or TSDB. Urgent, because signing stops at 90%.
2. **No data:** the agent is down and this alarm is blind; follow the log path runbook above (D3).

#### CW4 watch-security (designed, disabled)
1. **Finding** (T2, `/aws/lambda/x402-production-watch`, 24 h).
   ```
   fields @timestamp, finding, network, account, effect, value
   | filter msg = "watch_finding" and finding in ["account_state","account_effects","backup_secret_read"]
   | sort @timestamp desc
   | limit 20
   ```
2. **Account from Horizon (the detector's source, off the server).**
   ```
   A=${FEE_ACCOUNT}; curl -s ${HORIZON}/accounts/$A | jq '{signers,thresholds}'; curl -s "${HORIZON}/accounts/$A/effects?order=desc&limit=30" | jq -r '._embedded.records[] | [.created_at,.type,(.amount // ""),(.account // "")] | @tsv'
   ```
3. **Who read the backup secret.** Filter by resource, not by `EventName`: on 2026-11-16 there were ≥50 `GetSecretValue` in < 24 h from 12 other principals, so the last 20 are ~1 h of other people's reads. `ResourceName` is what the caller passed (name or ARN), so I query both.
   ```
   S=$(date -u -d '-24 hour' +%FT%TZ 2>/dev/null || date -u -v-24H +%FT%TZ); ARN=$(aws secretsmanager describe-secret --secret-id x402/production/openbao-backup --query ARN --output text --profile soroban-readonly --region eu-central-1); for R in x402/production/openbao-backup $ARN; do aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=$R --start-time $S --profile soroban-readonly --region eu-central-1 --query 'Events[].CloudTrailEvent' --output json | jq -r '.[] | fromjson | [.eventTime, .eventName, .userIdentity.arn, .sourceIPAddress] | @tsv'; done
   ```
   → Checked 2026-11-16: the command works, 0 events in 24 h. Skip the `DescribeSecret` from this step.
   → Every `GetSecretValue` is a finding (plan: "someone read" the secret). The only exception is an announced key rotation (ADR 0013); otherwise escalate as a recovery key leak. Window: from t0 − 1 h if t0 is older than 24 h.
4. **Cross-check in CH: triage aid only.** ch-prod-01 is the host the threat model does not trust.
   ```sql
   WITH (SELECT id FROM ${DB}.accounts FINAL WHERE account_id = {fee_account:String} LIMIT 1) AS fee_id
   SELECT
     (SELECT tuple(master_weight, signer_keys, signer_weights, threshold_med, last_updated_ledger)
        FROM ${DB}.account_entry_state FINAL WHERE account_id = fee_id) AS signers,
     (SELECT count() FROM ${DB}.asset_transfers WHERE from_id = fee_id
        AND ledger_sequence >= (SELECT max(sequence) - 17280 FROM ${DB}.ledgers)) AS outflows_24h
   ```

#### P1 x402-settlement
0. **Before 0139:** enter through T4 (alarm `x402-production-*-testnet` or `-pubnet` → cause from App. A; the suffix sets `${NET}`), then step 2.
1. **Causes** (T3; HUMAN-ONLY until D14, the agent goes to step 2).
   ```promql
   ALERTS{alertname="x402-settlement", alertstate="firing"}
   sum by (network, cause) (increase(x402_events_total[1h])) > 0
   x402_check_error == 1
   ```
2. **Every error/warn event**, including those lost by the counter on restart (`/x402/production/app`).
   ```
   fields @timestamp, level, event
   | filter level in ["error", "warn"]
   | stats count() as n, min(@timestamp) as first, max(@timestamp) as last by event
   | sort n desc
   | limit 40
   ```
3. **Network and ingest freshness.**
   ```sql
   SELECT max(sequence) AS ch_last_ledger, max(closed_at) AS ch_last_close,
          dateDiff('second', max(closed_at), now64(3)) AS ch_lag_s,
          argMax(protocol_version, sequence) AS protocol
   FROM ${DB}.ledgers
   WHERE sequence > (SELECT max(sequence) - 200 FROM ${DB}.ledgers)
   ```
4. **Do settlements land:** the same query as CW1 step 3.
5. **Readiness.**
   ```
   curl -s https://x402-facilitator.sorobanscan.com/health
   ```
   → The `listed` field stays true after the first sweep, so stalled sweeps show through `sweeps_stopped`.
6. **HUMAN-ONLY: open records in Postgres.**
   ```
   cd /srv/x402/production && sudo FACILITATOR_IMAGE=unused docker compose exec -T ${PG_SERVICE} psql -U postgres -d x402 -c "SELECT s.key, s.state, s.channel, round((extract(epoch from now())*1000 - s.created_at)/1000) AS age_s, h.hash, h.state AS attempt, h.max_ledger, h.error_code FROM settlements s JOIN settlement_hashes h USING (key) WHERE s.network = '${NET}' AND s.state IN ('claimed','signed','pending') ORDER BY s.created_at, h.seq LIMIT 50"
   ```
7. **Hash in the chain index.**
   ```sql
   SELECT lower(hex(t.hash)) AS tx, t.inner_tx_hash IS NOT NULL AS fee_bump,
          t.ledger_sequence, l.closed_at, t.successful, t.fee_charged
   FROM ${DB}.transactions AS t
   INNER JOIN ${DB}.ledgers AS l ON l.sequence = t.ledger_sequence
   WHERE t.ledger_sequence IN (
           SELECT ledger_sequence FROM ${DB}.transaction_hash_prefix_index
           WHERE hash_prefix = reinterpretAsUInt64(substring(unhex({hash:String}), 1, 8)))
     AND (t.hash = unhex({hash:String}) OR t.inner_tx_hash = unhex({hash:String}))
   LIMIT 1 BY t.hash
   ```
8. **pool_resync / quarantined: is someone else using the channels?** First the channel list.
   - The channel addresses (`${CHANNELS_VAR}`) are not in the repo. They are in `/srv/x402/production/.env` on ch-prod-01 (file 0644, public values; `docs/runbook.md`, "Before the first deploy"; `deploy/production/compose.yaml:33`).
   - HUMAN-ONLY: `grep "^${CHANNELS_VAR}=" /srv/x402/production/.env`. The human pastes the list as `{channels:Array(String)}`.
   - An agent without this list skips step 8 and records `CHANNELS_UNKNOWN`. Path for the agent: D8.
   ```sql
   WITH
     (SELECT id FROM ${DB}.accounts FINAL WHERE account_id = {fee_account:String} LIMIT 1) AS fee_id,
     (SELECT max(sequence) - 720 FROM ${DB}.ledgers) AS since
   SELECT DISTINCT a.account_id AS channel, p.ledger_sequence, p.application_order
   FROM ${DB}.transaction_participants AS p
   INNER JOIN (SELECT id, account_id FROM ${DB}.accounts FINAL WHERE account_id IN {channels:Array(String)}) AS a ON a.id = p.account_id
   WHERE p.ledger_sequence >= since
     AND (p.ledger_sequence, p.application_order) NOT IN (
           SELECT ledger_sequence, application_order FROM ${DB}.transaction_participants
           WHERE account_id = fee_id AND ledger_sequence >= since)
   ORDER BY p.ledger_sequence DESC
   LIMIT 50
   ```
   → Rows returned: a foreign signature or theft (CW4), escalate.
9. **RPC (agent, T2, `/x402/production/app`, 2 h), then OpenBao (HUMAN-ONLY).**
   ```
   fields @timestamp, event
   | filter event in ["rpc_failover","rpc_failback","rpc_exhausted","rpc_probe_failed","latest_ledger_failed","facilitator_balance_stale","balance_read_failed","verify_rpc_unavailable","signer_failed","signer_checked"]
   | stats count() as n by event, bin(5m)
   | sort bin(5m) desc
   # HUMAN-ONLY: cd /srv/x402/openbao && sudo docker compose exec -T openbao bao status
   ```

#### P2 x402-money
0. **Before 0139:** enter through T4 (`breaker-opened-*`, `budget-nearing-*`, `pending-*`), then step 2.
1. **Causes** (T3; HUMAN-ONLY until D14, the agent goes to step 2).
   ```promql
   ALERTS{alertname="x402-money", alertstate="firing"}
   up{job="x402-facilitator"}
   ```
2. **Policy lines** (T2, `/x402/production/app`, 24 h). Always after a facilitator restart.
   ```
   fields @timestamp, event, @message
   | filter event in ["spend_breaker_opened","spend_budget_nearing","spend_limit_reached","spend_failure_ours","facilitator_underfunded"]
   | sort @timestamp desc
   | limit 50
   ```
3. **Breakers: which token fails on-chain.**
   ```sql
   WITH
     (SELECT id FROM ${DB}.accounts FINAL WHERE account_id = {fee_account:String} LIMIT 1) AS fee_id,
     (SELECT max(sequence) - 720 FROM ${DB}.ledgers) AS since
   SELECT sc.contract_id AS token_contract, uniqExact(t.ledger_sequence, t.application_order) AS failed_txs
   FROM ${DB}.transactions AS t
   INNER JOIN ${DB}.transaction_operations AS o
     ON o.ledger_sequence = t.ledger_sequence AND o.application_order = t.application_order
   LEFT JOIN ${DB}.soroban_contracts AS sc ON sc.id = o.contract_id
   WHERE t.ledger_sequence >= since AND o.ledger_sequence >= since AND NOT t.successful
     AND t.inner_tx_hash IS NOT NULL
     AND (t.ledger_sequence, t.application_order) IN (
           SELECT ledger_sequence, application_order FROM ${DB}.transaction_participants
           WHERE account_id = fee_id AND ledger_sequence >= since)
   GROUP BY token_contract ORDER BY failed_txs DESC
   ```
4. **budget_nearing: traffic or a fee spike** (24 h).
   ```sql
   WITH
     (SELECT id FROM ${DB}.accounts FINAL WHERE account_id = {fee_account:String} LIMIT 1) AS fee_id,
     (SELECT max(sequence) - 17280 FROM ${DB}.ledgers) AS since
   SELECT toStartOfHour(closed_at) AS hour, count() AS settlements,
          sum(fee_charged) AS fee_stroops, round(sum(fee_charged) / count()) AS fee_per_tx
   FROM (
     SELECT t.hash AS hash, any(t.fee_charged) AS fee_charged, any(l.closed_at) AS closed_at
     FROM ${DB}.transactions AS t
     INNER JOIN ${DB}.ledgers AS l ON l.sequence = t.ledger_sequence
     WHERE t.ledger_sequence >= since AND l.sequence >= since AND t.inner_tx_hash IS NOT NULL
       AND (t.ledger_sequence, t.application_order) IN (
             SELECT ledger_sequence, application_order FROM ${DB}.transaction_participants
             WHERE account_id = fee_id AND ledger_sequence >= since)
     GROUP BY t.hash)
   GROUP BY hour ORDER BY hour
   ```
5. **pending:** HUMAN-ONLY P1 step 6, then P1 step 7 (agent) for each hash.
6. **Rule out drain or theft (off-server).**
   ```
   A=${FEE_ACCOUNT}; curl -s "${HORIZON}/accounts/$A/effects?order=desc&limit=50" | jq -r '._embedded.records[] | [.created_at,.type,(.amount // "")] | @tsv' | cut -f2,3 | sort | uniq -c | sort -rn | head
   ```

#### P3 x402-runtime
0. **Before 0139:** enter through T4 (`disk-root`, `memory`, `facilitator-*`, `gauges-silent-*`, `probe-silent`, `watchdog-restart`, `emf-*`), then step 2.
1. **Cause** (T3; HUMAN-ONLY until D14, the agent goes to step 2).
   ```promql
   ALERTS{alertname="x402-runtime", alertstate="firing"}
   up{job="x402-facilitator"}
   time() - x402_selfcheck_timestamp_seconds
   time() - node_textfile_mtime_seconds{file=~".*x402-host.*"}
   time() - x402_host_last_event_timestamp_seconds
   ```
2. **How the process ended** (T2, `/x402/production/app`, 6 h).
   ```
   fields @timestamp, event, @message
   | filter event in ["startup_failed","listening","shutdown_started","shutdown_drained","shutdown_deadline","lease_lost","store_connection_error","migrated"]
   | sort @timestamp desc
   | limit 50
   ```
   → After every restart also run P2 step 2.
3. **Disk:** queries as in `audit-disk` step 1.
4. **Memory: CH or us?**
   ```sql
   SELECT metric, formatReadableSize(value) AS v FROM system.asynchronous_metrics WHERE metric IN ('OSMemoryTotal', 'OSMemoryAvailable', 'MemoryResident')
   ```
   → Small CH resident: our containers (HUMAN-ONLY: `docker stats --no-stream; sudo journalctl -k | grep -i oom`).
5. **HUMAN-ONLY: units.**
   ```
   systemctl list-units 'x402*' && systemctl status x402@production x402-host-probe.timer x402-watchdog@production.timer amazon-cloudwatch-agent --no-pager && sudo journalctl -u x402-watchdog@production -n 20 --no-pager
   ```
   → After 0139, also the Prometheus agent on ch-prod-01 (its unit or container is named in 0139). It stopped: P3 `facilitator_unscraped` and the VM's rule for the agent gone quiet both fire.

#### Heartbeat `x402-production-monitoring-heartbeat` (proposed)
The alarm and its SNS topic are created in 0139 (ADR 0011).
- The always-firing Watchdog rule goes through Alertmanager to the topic every minute. Its route has its own `group_interval 1m` and `repeat_interval 1m`.
- The alarm reads the topic's AWS/SNS `NumberOfMessagesPublished`, with missing data breaching.
- It fires when Prometheus, Alertmanager or the VM goes quiet, or when Alertmanager can't publish to SNS.

1. **Did the Watchdog reach SNS?** (2 h, 1-minute periods.)
   ```
   S=$(date -u -d '-2 hour' +%FT%TZ); E=$(date -u +%FT%TZ); aws cloudwatch get-metric-statistics --namespace AWS/SNS --metric-name NumberOfMessagesPublished --dimensions Name=TopicName,Value=x402-production-monitoring-heartbeat --statistics Sum --period 60 --start-time $S --end-time $E --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text --profile soroban-readonly --region eu-central-1
   aws cloudwatch describe-alarms --alarm-names x402-production-monitoring-heartbeat --query 'MetricAlarms[0].[StateValue,StateReason,Period,EvaluationPeriods,TreatMissingData]' --output text --profile soroban-readonly --region eu-central-1
   ```
   → No points since t0: nothing reached the topic; go to step 2. Points every minute and the alarm still in ALARM: check the alarm's own settings (second command).
2. **HUMAN-ONLY: is the VM up, and does Alertmanager send?** (Service names are set in 0139.)
   ```
   ssh monitoring 'uptime; docker ps --format "{{.Names}} {{.Status}}"'
   ssh -N -L 9093:localhost:9093 monitoring &
   curl -s 'http://localhost:9093/api/v2/alerts?filter=alertname="Watchdog"' | jq '.[] | {state: .status.state, since: .startsAt}'
   ```
   → No SSH: the VM or Hetzner; check the Hetzner Cloud console. No Watchdog alert: Prometheus doesn't evaluate or doesn't reach Alertmanager. Watchdog active: Alertmanager doesn't publish to SNS; read its log for SNS or credential errors (D12).
3. **Meanwhile P1–P3 are blind.** The agent works from the logs: P1 step 2, P2 step 2, P3 step 2. ch-prod-01's agent keeps a few hours of samples in its write-ahead log, so the metrics come back with the VM.

#### balance-low / balance-critical (kept)
Order (`${NET}` from the alarm suffix, parameters from the table above): CW2 step 4 (balance), P2 step 6 (drain), P2 step 4 (burn in 24 h), then `docs/runbook.md` "Topping up the fee account".

#### phone-delivery (D25, pubnet only)
Alarms *(proposed)*, both on `x402-production-alarms` (Slack), because it is the phone that is broken:
- `x402-production-phone-delivery-failed`: AWS/SNS `NumberOfNotificationsFailed`, `TopicName=x402-production-phone`, Sum >= 1 in 5 min, notBreaching.
- `x402-production-sms-spend`: AWS/SNS `SMSMonthToDateSpentUSD` (Maximum) >= 80% of `MonthlySpendLimit`.
- Plus a weekly drill: a test message to `x402-production-phone`, the on-call confirms on Slack. No confirmation = route incident.
1. **Publications and deliveries** (2 h).
   ```
   S=$(date -u -d '-2 hour' +%FT%TZ 2>/dev/null || date -u -v-2H +%FT%TZ); E=$(date -u +%FT%TZ); for m in NumberOfMessagesPublished NumberOfNotificationsDelivered NumberOfNotificationsFailed; do echo "== $m"; aws cloudwatch get-metric-statistics --namespace AWS/SNS --metric-name $m --dimensions Name=TopicName,Value=x402-production-phone --statistics Sum --period 300 --start-time $S --end-time $E --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text --profile soroban-readonly --region eu-central-1; done
   ```
2. **Limit, sandbox, spend.**
   ```
   aws sns get-sms-attributes --attributes MonthlySpendLimit --profile soroban-readonly --region eu-central-1 --output text; aws sns get-sms-sandbox-account-status --profile soroban-readonly --region eu-central-1 --output text; aws cloudwatch get-metric-statistics --namespace AWS/SNS --metric-name SMSMonthToDateSpentUSD --statistics Maximum --period 3600 --start-time $(date -u -d '-1 day' +%FT%TZ 2>/dev/null || date -u -v-1d +%FT%TZ) --end-time $(date -u +%FT%TZ) --query 'sort_by(Datapoints,&Timestamp)[-1].Maximum' --output text --profile soroban-readonly --region eu-central-1
   ```
   → Spend ≥ limit: SMS messages do not go out, every pubnet alarm calls into the void. HUMAN-ONLY: raise the limit (a write outside the readonly profile). `IsInSandbox` True: SMS reaches only verified numbers. State on 2026-11-16: limit `1` ($1), sandbox True.
3. **Subscriptions** (no numbers: do not copy `Endpoint` into the note).
   ```
   aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:eu-central-1:$(aws sts get-caller-identity --query Account --output text --profile soroban-readonly):x402-production-phone --query 'Subscriptions[].[Protocol,SubscriptionArn]' --output text --profile soroban-readonly --region eu-central-1
   ```
   → `PendingConfirmation` or no `sms`: the route has no recipient.
4. **Rejection reason** (only when SMS delivery status logging is enabled, part of D25; group names not checked, hence the listing).
   ```
   aws logs describe-log-groups --log-group-name-prefix sns/eu-central-1/ --query 'logGroups[].logGroupName' --output text --profile soroban-readonly --region eu-central-1
   ```
   → Then T2 on the group with `Failure` in its name, 24 h: `fields @timestamp, status, delivery.providerResponse | sort @timestamp desc | limit 20`. No groups: logging not enabled, record `DELIVERY_LOGS_ABSENT`.

---

## 5. Risks and open questions

### 5.1 Top three risks
1. **Paging depends on new, untested code.**
   - For x402: the findings section in x402-watch (SSM state and self-post), Alertmanager's routes on the VM, and the heartbeat path (Watchdog → Alertmanager → SNS → CloudWatch alarm).
   - Across the account, four re-notify mechanisms are being built (§2.2). Convergence to one: D15 (§6).
   - Not checked: FILL on an empty series and on a period still being filled, DIFF at the start of the range, REPEAT, the 10-metric limit, delivery through Chatbot.
   - Mitigation: drills DR2–DR4 and a test of two simultaneous failures right after the switch (no shadow period, decided 2026-11-17); a signal that fails is fixed forward.
2. **The agent cannot run triage yet.**
   - There is no operator ClickHouse user. Users are defined in XML and access storage is read-only, so `users.xml` must be edited in the ch-prod-01 base setup.
   - Grants needed for x402's steps: SELECT on `default.*`, `testnet.*` and the `system.*` tables, including `query_log`.
   - Prometheus on the VM has no read path for the agent (D14).
   - x402 steps that use Postgres and OpenBao are HUMAN-ONLY, because there is no read-only path.
   - All SQL is unverified.
   - One ch-prod-01 failure pages in three channels at once: Prices, explorer and x402 P1/P3. There is no shared host signal to silence them (D20).
3. **The account-wide numbers are a target, not a state.**
   - The Prices API keeps its old alarms until Milestone 2 acceptance, except for what its 0344–0347 change, and the explorer joins only after it supersedes its ADR 0054 (their PRs).
   - x402 P1–P3 wait for the 0139 switch. Until then the 33 old x402 alarms run (§3.3).

### 5.2 Unresolved skeptic objections (after the final version)

The Prices API and explorer objections are in their PRs. What remains here:

**x402:**
- Broader IAM for the watch Lambda (GetMetricData, SSM, SNS); the plan calls it "the central design choice". Alternative: a separate small Lambda. Decision D19.
- A breaker counted just before a crash is lost. Not checked whether the spend store persists breakers.
- SNS credentials for Alertmanager on the VM (heartbeat and phone): D12.
- Re-baseline the memory threshold for node_exporter.

**Cross-cutting, still valid:**
- `production-galexie-readiness` with the Prices and x402 topics: accepted in §2.6 (D17), no longer open.

### 5.3 Data not in ClickHouse
- **x402:** state of settlements, hashes, the spend store and breakers (Postgres, ADR 0011), OpenBao status, `CHANNELS_TESTNET` configuration.
- **Chain index (explorer's tables):** not checked whether the testnet index covers settlements since genesis 2025-12-18, or whether the fee source of a fee-bump lands in `transaction_participants`.
- **AWS:** Lambda logs (CloudWatch Logs), certificate and credentials age (`x402-host`), host disk outside CH, log delivery (AWS/Logs), the heartbeat (AWS/SNS).

### 5.4 Questions for you (one at a time, in order)
1. D11: what mechanism is behind the phone route (SNS SMS or a pager provider), and who is on call? Without it D1–D3 have nowhere to go.
2. D15: one re-notify mechanism for everything (a Lambda evaluator with state in SSM) or four local ones?
3. D20: should SIG-06 (ch-prod-01 disk, memory and silence) be one platform signal, and who owns it?

---

## 6. Decisions to make

Each one is a design choice. I entered the safest option consistent with ADR 0011 and marked it as the default.

Dropped from this note, since they are the Prices API's: D5, D6, D7, D9, D13, D18, D23, D27,
D28 and D29 (stellar-prices-api#420). Their numbers are not reused.

| # | Decision | Default (in this report) | Alternative |
|---|---|---|---|
| D1 | P1 causes guarding money on pubnet: `sweeps_stopped`, `check_error{check=pending}`, `landed_after_expired`, `commit_unmatched` | phone + Slack (separate route, same P1 rule) | Slack only, as in the x402 plan |
| D2 | P3 causes for which P2 is blind: `facilitator_unscraped`, `selfcheck_stalled`, `series_missing` | phone + Slack on pubnet (matcher: D16) | Slack only |
| D3 | `log-delivery` (the agent is silent, so `audit-disk` cannot see the disk) | pager-class, phone on pubnet | Slack only, as in the plan |
| D4 | CW1 `uptime` and P1 cause `openbao` | Slack (they are not money in the ADR 0011 sense) | phone on pubnet |
| D8 | Channel list for the agent | HUMAN-ONLY read of `/srv/x402/production/.env` | public addresses in SSM (e.g. `/x402/production/channels-testnet`), readable by the agent |
| D10 | `x402-production-emf-parsing`, `emf-validation` | retire together with the log group `/x402/production/metrics` in 0139 | keep until the first P3 `series_missing` drill |
| D11 | x402 phone route (does not exist today) | One new SNS topic `x402-production-phone` as the contract for CW, x402-watch and Alertmanager. Behind it, SNS SMS to at least 2 numbers with on-call rotation; numbers only in subscriptions, not in the repo. Pubnet does not start without a test SMS received by a human. Checked 2026-11-16: `MonthlySpendLimit` = 1 ($1/month), `IsInSandbox` = true; handled in D25 | A pager provider (e.g. PagerDuty, Opsgenie) through an HTTPS subscription to this topic: acknowledgements and escalation, but a new vendor |
| D12 | SNS credentials for Alertmanager on the monitoring VM (heartbeat, phone, the failed-notification route to Slack) | The VM's own Roles Anywhere certificate, permission only `sns:Publish` on the 3 topics. No static keys | a static key limited to `sns:Publish` |
| D14 | PromQL/Alertmanager read by the agent (T3) | HUMAN-ONLY: the operator reads Prometheus and Alertmanager on the VM over an SSH tunnel or through Grafana behind Cloudflare Access; the agent starts from the `/x402/production/app` logs | a read-only path for the agent, e.g. a Cloudflare Access service token for Grafana's datasource proxy |
| D15 | Four re-notify mechanisms (§2.2) | Four local ones, as in the plans; we assess convergence after the first month | One Lambda evaluator with state in SSM for all areas |
| D16 | D2 route matcher for `facilitator_unscraped` and `selfcheck_stalled` (no `network` label) | Route on `alertname` + `cause` only, enabled together with `stellar:pubnet` in `config.networks`; testnet outages also call | Add a `network` label to these causes (one instance per network) and match `network="stellar:pubnet"` |
| D17 | `production-galexie-readiness`: extra topics | Yes: AlarmActions also to `prices-production-ops-alarms` and `x402-production-alarms` | explorer topic only |
| D19 | Watch Lambda IAM (GetMetricData, SSM, SNS to Slack and phone) | As in the plan: extend the `x402-production-watch` role, scoped to one SSM parameter and two topics; CW2 guards silence | A separate small Lambda on the same schedule (smaller IAM reach, but a new producer without a dead-man) |
| D20 | SIG-06: shared ch-prod-01 host signal | No shared signal; each area keeps its own (PD-1 disk, explorer bits, P3 and `audit-disk`) | One platform signal owned by the ch-prod-01 base setup owner, silencing pages in three channels |
| D21 | CW4 `watch-security` (account_state, account_effects, backup_secret_read) is disabled until decision 68, and the pubnet gate required only a test SMS | Pubnet does not start until CW4 is enabled with AlarmActions to `x402-production-phone` and one test finding has reached the phone. Applies to both D22 options | Pubnet start with CW4 disabled; theft and backup secret reads (ADR 0013) are visible only in CW2/P2 triage |
| D22 | Pubnet before 0139, on `-pubnet` copies of the old CW alarms (§3.3, ~26 alarms) | Pubnet waits for 0139: only then does P2 run on the VM with the full silence clause (the heartbeat alarm) | Start before 0139 on `-pubnet` copies with the routes from §3.3 "Before 0139" (phone for P2, balance, D1, D2, CW2, `audit-disk`, `telemetry-silent`); without the heartbeat, P2 silence is seen only by `facilitator-silent-pubnet` and `gauges-silent-pubnet` |
| D24 | CW2 `watch-blind` latches across networks and sections: `runBalance` throws on every failed network, and `balance-*` have TreatMissingData ignore. CW2 in ALARM due to flaky testnet RPC hides a later failure of a pubnet section | A failed section does not throw. The Lambda publishes a per-network finding `section_failed{section,network}` (same SSM state and self-post as CW3), pubnet to `x402-production-phone`. CW2 catches only missing runs or a crash of the whole Lambda. Change in `infra/src/watch/balance.ts` (and the findings/security sections) and in `docs/monitoring.md`. No new alarm or series. Pubnet gate | A separate CW2 per network (e.g. series `section_ok{network}`, TreatMissingData breaching): +1 alarm and +1 series per network, no change to findings semantics |
| D25 | Silent delivery failure on the phone route: default SMS limit $1/month, sandbox, SMS test only once at the pubnet gate. Once the limit is used up, SMS messages do not arrive and nothing sees it | 2 alarms to Slack (`x402-production-alarms`): `x402-production-phone-delivery-failed` (`NumberOfNotificationsFailed` >= 1, `TopicName=x402-production-phone`) and `x402-production-sms-spend` (`SMSMonthToDateSpentUSD` >= 80% of the limit). Before pubnet: limit raised, account out of sandbox, SMS delivery status logging enabled. Weekly SMS drill with confirmation on Slack. Whether a used-up limit counts in `NumberOfNotificationsFailed`: not checked, hence the second alarm. +2 pubnet alarms (§1.1), runbook `phone-delivery` | Drill only, no alarms; or a pager provider (D11), which reports failed delivery itself |
| D26 | Where runbooks get the pubnet fee account (and Horizon). Today `feeAccounts` has only testnet | The deployed env `WATCH_TARGETS` / `WATCH_PROTOCOL` of the `x402-production-watch` Lambda (`lambda get-function-configuration`, read-only), i.e. exactly the account that `balance-*` read. Empty result = `FEE_ACCOUNT_UNKNOWN`, no guessing (§4.1, parameter table) | A public address in SSM (e.g. `/x402/production/fee-account-pubnet`), like the channel list in D8 |
| D30 | The pubnet gate did not require x402-watch to read pubnet at all. Today `WATCH_TARGETS` (`feeAccounts`) has only testnet; `balance-*-pubnet` have TreatMissingData ignore, and the Lambda without a pubnet target does not throw | Gate (§3.3): `stellar:pubnet` in `feeAccounts`/`WATCH_TARGETS` and at least one datapoint `spendable_stroops{network=stellar:pubnet}` before start | `balance-*-pubnet` with TreatMissingData breaching (silence = alarm) |

---

## Appendix A: x402 alarm mapping (49)

All 49 x402 alarms from the 2026-11-16 inventory, each exactly once (source: the final x402 plan). The "Fate" column: signal id, `keep` or its successor alarm. The Prices API's 87 alarms and the explorer's 19 are mapped in their PRs; all three are read against their metrics in [R-alarm-inventory-and-reductions.md](R-alarm-inventory-and-reductions.md).

| Alarm | Area | Fate | Cause / check_id |
|---|---|---|---|
| `x402-production-uptime` | x402 | CW1 | not serving 7 min |
| `x402-production-watch-errors` | x402 | CW2 | watch Lambda Errors |
| `x402-production-watch-no-invocations` | x402 | CW2 | Invocations < 1 |
| `x402-production-audit-disk` | x402 | keep | kept: off-host, pager-class (ADR 0011, 0013) |
| `x402-production-log-volume-app` | x402 | CW3 | log_flood{/x402/production/app} |
| `x402-production-log-volume-metrics` | x402 | CW3 | log_flood{/x402/production/metrics} (until 0139) |
| `x402-production-protocol-changed-pubnet` | x402 | CW3 | protocol_changed{pubnet} |
| `x402-production-protocol-changed-testnet` | x402 | CW3 | protocol_changed{testnet} |
| `x402-production-protocol-upgrade-coming-pubnet` | x402 | CW3 | protocol_upgrade_coming{pubnet} |
| `x402-production-protocol-upgrade-coming-testnet` | x402 | CW3 | protocol_upgrade_coming{testnet} |
| `x402-production-telemetry-silent` | x402 | log-delivery | successor in CloudWatch: AWS/Logs `IncomingLogEvents` |
| `x402-production-balance-stale-testnet` | x402 | P1 | balance_stale |
| `x402-production-channel-quarantined-testnet` | x402 | P1 | channel_quarantined |
| `x402-production-commit-unmatched-testnet` | x402 | P1 | commit_unmatched (D1) |
| `x402-production-failure-ours-testnet` | x402 | P1 | failure_ours |
| `x402-production-history-gone-testnet` | x402 | P1 | history_gone |
| `x402-production-hook-failures-testnet` | x402 | P1 | hook_failed |
| `x402-production-http-500` | x402 | P1 | http_500 |
| `x402-production-landed-after-expired-testnet` | x402 | P1 | landed_after_expired (D1: phone call on pubnet) |
| `x402-production-openbao-down` | x402 | P1 | openbao (host check) |
| `x402-production-pool-health-testnet` | x402 | P1 | pool_resync |
| `x402-production-queue-waiting-testnet` | x402 | P1 | queue_waiting |
| `x402-production-refused-after-verify-testnet` | x402 | P1 | refused_after_verify |
| `x402-production-rpc-on-fallback-testnet` | x402 | P1 | rpc_on_fallback |
| `x402-production-rpc-stalled-testnet` | x402 | P1 | rpc_stalled |
| `x402-production-settlement-expired-testnet` | x402 | P1 | settlement_expired |
| `x402-production-signer-failures-testnet` | x402 | P1 | signer_failed |
| `x402-production-store-outage-testnet` | x402 | P1 | record_failed, spend_store_failed |
| `x402-production-submit-failed-testnet` | x402 | P1 | submit_failed |
| `x402-production-sweeps-stopped-testnet` | x402 | P1 | sweeps_stopped (D1) |
| `x402-production-breaker-opened-testnet-asset` | x402 | P2 | breaker_opened{asset} |
| `x402-production-breaker-opened-testnet-pay-to` | x402 | P2 | breaker_opened{pay_to} |
| `x402-production-breaker-opened-testnet-payer` | x402 | P2 | breaker_opened{payer} |
| `x402-production-budget-nearing-testnet` | x402 | P2 | budget_nearing |
| `x402-production-pending-testnet` | x402 | P2 | pending |
| `x402-production-certificate` | x402 | keep | kept: log path, CloudWatch (ADR 0011) |
| `x402-production-credentials-stale` | x402 | keep | kept: log path, CloudWatch (ADR 0011) |
| `x402-production-disk-root` | x402 | P3 | disk (80%) |
| `x402-production-emf-parsing` | x402 | P3 | series_missing (successor); moot after 0139 (D10) |
| `x402-production-emf-validation` | x402 | P3 | series_missing (successor); moot after 0139 (D10) |
| `x402-production-facilitator-failed` | x402 | P3 | facilitator_failed |
| `x402-production-facilitator-silent-testnet` | x402 | P3 | facilitator_unscraped (D2) |
| `x402-production-gauges-silent-testnet` | x402 | P3 | selfcheck_stalled / series_missing; P1 check_error (D1 for pending) |
| `x402-production-memory` | x402 | P3 | memory |
| `x402-production-probe-silent` | x402 | P3 | host_probe_stale |
| `x402-production-watchdog-restart` | x402 | P3 | watchdog_restart |
| `x402-production-balance-critical-testnet` | x402 | keep | kept: money, phone call on pubnet |
| `x402-production-balance-low-testnet` | x402 | keep | kept: money, phone call on pubnet |
| `x402-production-uptime-flapping` | x402 | keep | kept: 10 of 30, decision 0138 |

Develop-only (defined on origin/develop, not in the inventory, not counted in the 49):

| Alarm | Where on develop | Fate |
|---|---|---|
| `x402-production-verify-rpc-unavailable` | `settlement.ts`, group `facilitator` (enabled, not deployed) | P1 `verify_rpc_unavailable` |
| `x402-production-channel-held-testnet` | `settlement.ts`, group `channelHeld` (disabled) | P1 `channel_held` |
| `x402-production-upstream-changed` | `upstream.ts`, group `upstream` (disabled) | CW3 `upstream_changed` |
| `x402-production-upstream-silent` | `upstream.ts`, group `upstream` (disabled) | CW3 `upstream_silent` |
| `x402-production-backup-age` | `host.ts`, group `backups` (disabled) | P3 `backup_age`, in 0026 |
| `x402-production-wal-failing` | `host.ts`, group `backups` (disabled) | P3 `wal_failing`, in 0026 |
| `x402-production-wal-stale` | `host.ts`, group `backups` (disabled) | P3 `wal_stale`, in 0026 |
| `x402-production-snapshot-age` | `host.ts`, group `snapshots` (disabled) | P3 `snapshot_age`, in 0026 (fix the 1e9 sentinel first) |
| `x402-production-account-state-testnet` | `money.ts`, group `watchSecurity` (disabled) | CW4 `account_state` |
| `x402-production-account-effects-testnet` | `money.ts`, group `watchSecurity` (disabled) | CW4 `account_effects` |
| `x402-production-backup-secret-read` | `money.ts`, group `watchSecurity` (disabled) | CW4 `backup_secret_read` |

x402 names are built per `factory.ts` (`x402-production-<name>[-<network>]`); checked in `infra/src/lib/alarms/*.ts` on origin/develop 2026-11-16. With pubnet, per-network alarms get a `-pubnet` copy.

Checksum: 49 alarms. P1 19, P3 9, CW3 6, keep 6, P2 5, CW2 2, CW1 1, log-delivery 1.

---

## Appendix B: fate of x402's custom metrics (55)

All 55 x402 series from the inventory. "Replaced" means: the series stops being published, and its condition lives on in the signal. "Conditional" means: the series stays until the given event. The Prices API's 66 series and the explorer's 45 are in their PRs.

kept 5, replaced 32, drop 18; of which 28 conditional.

| Namespace | Series | Dimensions | Fate | Who reads / condition |
|---|---|---|---|---|
| x402-host | `disk_used_percent` | path=/ | kept | `audit-disk` (Max >= 90); disk-root until 0139 |
| x402-watch | `ready` | — | kept | CW1 + flapping |
| x402-watch | `spendable_stroops` | network=stellar:testnet | kept | input to balance-low/critical, off-server |
| x402-facilitator | `balance_reading_age_seconds` | network=stellar:testnet | replaced: P1 `balance_stale` | **conditional, until 0139** (the old alarm reads it) ; also gauges-silent |
| x402-facilitator | `http_requests_total` | status=500 | replaced: P1 `http_500` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `pool_events_total` | network=stellar:testnet, type=sequence-resync | replaced: P1 `pool_resync` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `pool_quarantined` | network=stellar:testnet | replaced: P1 `channel_quarantined` | **conditional, until 0139** (the old alarm reads it) ; also gauges-silent |
| x402-facilitator | `pool_queued` | network=stellar:testnet | replaced: P1 `queue_waiting` | **conditional, until 0139** (the old alarm reads it) ; also gauges-silent |
| x402-facilitator | `rpc_on_fallback` | network=stellar:testnet | replaced: P1 `rpc_on_fallback` | **conditional, until 0139** (the old alarm reads it) ; also gauges-silent |
| x402-facilitator | `rpc_stalled_seconds` | network=stellar:testnet | replaced: P1 `rpc_stalled` | **conditional, until 0139** (the old alarm reads it) ; also gauges-silent |
| x402-facilitator | `settlement_history_gone_total` | network=stellar:testnet | replaced: P1 `history_gone` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `settlement_hook_failures_total` | network=stellar:testnet | replaced: P1 `hook_failed` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `settlement_landed_after_expired_total` | network=stellar:testnet | replaced: P1 `landed_after_expired` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `settlement_oldest_open_seconds` | network=stellar:testnet | replaced: P2 `pending` | **conditional, until 0139** (the old alarm reads it) ; also gauges-silent |
| x402-facilitator | `settlement_reconciled_total` | network=stellar:testnet, state=expired | replaced: P1 `settlement_expired` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `settlement_record_failures_total` | network=stellar:testnet | replaced: P1 `record_failed` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `settlement_refused_after_verify_total` | network=stellar:testnet, stage=pool | replaced: P1 `refused_after_verify` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `settlement_submit_failures_total` | network=stellar:testnet | replaced: P1 `submit_failed` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `settlement_sweeps_total` | network=stellar:testnet, outcome=listed | replaced: P1 `sweeps_stopped` | **conditional, until 0139** (the old alarm reads it) ; also gauges-silent |
| x402-facilitator | `signer_failures_total` | network=stellar:testnet | replaced: P1 `signer_failed` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `spend_breaker_opened_total` | breaker=asset, network=stellar:testnet | replaced: P2 `breaker_opened{asset}` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `spend_breaker_opened_total` | breaker=pay_to, network=stellar:testnet | replaced: P2 `breaker_opened{pay_to}` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `spend_breaker_opened_total` | breaker=payer, network=stellar:testnet | replaced: P2 `breaker_opened{payer}` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `spend_budget_nearing_total` | network=stellar:testnet | replaced: P2 `budget_nearing` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `spend_commit_unmatched_total` | network=stellar:testnet | replaced: P1 `commit_unmatched` | **conditional, until 0139** (the old alarm reads it) |
| x402-facilitator | `spend_failure_attributed_total` | fault=ours, network=stellar:testnet | replaced: P1 `failure_ours` | **conditional, until 0139** (the old alarm reads it) |
| x402-host | `certificate_days_left` | — | kept | `certificate` alarm, CloudWatch (ADR 0011) |
| x402-host | `credentials_age_seconds` | — | kept | `credentials-stale` alarm, CloudWatch (ADR 0011) |
| x402-host | `facilitator_failures_total` | — | replaced: P3 `facilitator_failed` | **conditional, until 0139** (the old alarm reads it) |
| x402-host | `host_probe_heartbeat` | — | replaced: P3 `host_probe_stale` | **conditional, until 0139** (the old alarm reads it) |
| x402-host | `mem_used_percent` | — | replaced: P3 `memory` | **conditional, until 0139** (the old alarm reads it) |
| x402-host | `openbao_up` | — | replaced: P1 `openbao` | **conditional, until 0139** (the old alarm reads it) |
| x402-host | `watchdog_restarts_total` | — | replaced: P3 `watchdog_restart` | **conditional, until 0139** (the old alarm reads it) |
| x402-watch | `protocol_supported_version` | network=stellar:pubnet | replaced: CW3 `findings` | thresholds in the Lambda |
| x402-watch | `protocol_supported_version` | network=stellar:testnet | replaced: CW3 `findings` | thresholds in the Lambda |
| x402-watch | `protocol_version` | network=stellar:pubnet | replaced: CW3 `findings` | thresholds in the Lambda |
| x402-watch | `protocol_version` | network=stellar:testnet | replaced: CW3 `findings` | thresholds in the Lambda |
| x402-facilitator | `balance_read_failures_total` | network=stellar:testnet | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `catalog_attempts_total` | — | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `discovery_unknown_params_total` | — | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `fee_charged_stroops` | network=stellar:testnet | drop from CW | → Prometheus `x402_fee_charged_stroops_total` (weekly fee review) |
| x402-facilitator | `http_requests_total` | route=/discovery | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `http_requests_total` | route=/health | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `http_requests_total` | route=/settle | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `http_requests_total` | route=/supported | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `http_requests_total` | route=/verify | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `http_requests_total` | route=other | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `lease_changes_total` | network=stellar:testnet | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `pool_events_total` | network=stellar:testnet | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `settlement_outcomes_total` | network=stellar:testnet, result=success | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-facilitator | `settlement_reconciled_total` | network=stellar:testnet | drop from CW | diagnostics without an alarm; log/Postgres. Without an EMF change it disappears only in 0139 |
| x402-host | `backup_age_seconds` | — | drop from CW | backups/snapshots groups disabled; they return as P3 causes in 0026 |
| x402-host | `snapshot_age_seconds` | — | drop from CW | backups/snapshots groups disabled; they return as P3 causes in 0026 |
| x402-host | `wal_failing` | — | drop from CW | backups/snapshots groups disabled; they return as P3 causes in 0026 |
| x402-host | `wal_last_archived_age_seconds` | — | drop from CW | backups/snapshots groups disabled; they return as P3 causes in 0026 |

New series account-wide (not in the 166): Prices `FailingChecks`, `FailingCriticalChecks`, `RuntimeChecksFailing`, `PortalSourcesLoadFailed` (empty today); Explorer `ReadinessFailing`, `Bits` ×2, `NewBits` ×2; x402 `findings`. In total 10 new + 19 kept = 29.

[pre-trim]: https://github.com/rumblefishdev/stellar-x402/blob/b99fad33b4c91ad411f958a24c5840e94e5b7858/lore/1-tasks/active/0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/G-alarm-signals-and-triage-runbooks.md
