---
title: "Alarms as early signals: fewer, broader alarms with triage runbooks"
type: generation
status: developing
spawned_from: notes/R-alarm-inventory-and-reductions.md
spawns: []
tags: [monitoring, cloudwatch, alarms, runbooks, clickhouse, prices-api, explorer]
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
---

# Alarms as early signals: reduction plan (2026-11-16)

**Sources:** live inventory read on 2026-11-16 with the read-only role (`describe-alarms`, `list-metrics`, `describe-alarm-history` for 30 days), final plans for 5 areas (prices-data, prices-runtime, explorer, x402, cross-cutting) and the skeptics' notes.

**Rules:**
- I count each alarm once. Full mapping of the 155 alarms: Appendix A. Fate of the 166 series: Appendix B.
- All SQL queries are **unverified-against-live-data**. I wrote them from the schemas and did not run them.
- Schemas (origin/develop):
  - `prices.*`: `packages/prices-clickhouse/schema/init.sql` (stellar-prices-api 66724665);
  - `default.*` and `testnet.*` (chain tables): `crates/db-clickhouse/schema/init.sql` (soroban-block-explorer 5b7bd304).
  - `prices.data_checks` **does not exist**. It is a proposed new table (DDL in §3.1).
- **New resources (proposed, they do not exist today).** Checked read-only on 2026-11-16: `lambda list-functions`, `sns list-topics`, `ssm describe-parameters`, `logs describe-log-groups`. Runbooks that use them work only after deployment. I mark them *(proposed)*.
  - Lambdas: `prices-production-data-health-evaluator` (PD-1/PD-3), `prices-production-alert-notifier`, `production-explorer-signal-evaluator`, `testnet-explorer-signal-evaluator`. Their log groups `/aws/lambda/<name>` too.
  - SSM: `/prices/production/data-health/last-verdict`, `/prices/production/data-health/mutes`, `/prices/production/alerting/<alarm-name>` (Prices notifier state, one parameter per PR-* alarm: announced set, `expected`, `last_digest_date`; prefix from the prices-runtime plan), `/x402/production/watch-findings-state`. CDK also writes the per-alarm contributor list to SSM; the plan does not give its name (not checked).
  - SNS: `x402-production-monitoring-heartbeat`, `x402-production-phone` (D11).
  - Metrics: `Prices/DataHealth` `FailingChecks` and `FailingCriticalChecks`, `Prices/Rollup` `RuntimeChecksFailing`, `SorobanBlockExplorer/Signal` `Bits` and `NewBits`, `SorobanBlockExplorer/Galexie` `ReadinessFailing`, `x402-watch` `findings`.
  - Alarms: all new signals from §3 except the kept ones (keep), including the pubnet `x402-production-phone-delivery-failed` and `x402-production-sms-spend` (D25).
  - x402-watch finding `section_failed{section,network}` (D24).
  - Table `prices.data_checks`.
- No number comes from outside the inventory, the code or the plans. Where something was not checked, I write "not checked".

**TL;DR**
- **CloudWatch alarms: 155 → 24**, plus 3 on-host rules for x402 (Prometheus/Grafana). This is the state after the 0139 cut-over and the sidecar gate. **Before 0139: ~60** (§1.1).
- **Custom metric series: 166 → 27**, plus 8 conditionally: `SacContractIdentities` until 0242 closes (D6) and 7 M2 CI gate series until M2 acceptance (D7). Until those events, 35. **Before 0139: ~103** (with Container Insights and those 8).
- **CloudWatch cost (billing per metric in an alarm): ~$62.80 → ~$8.50 /month.** Plus ~$4–5 of side costs (GetMetricData, Logs Insights). With the 8 conditional series ~$10.90; before 0139 ~$35.70 (§1.2).
- **Runbooks: 22 headings (Prices 12, explorer 3, x402 7) + 1 for the disabled CW4 + 1 for the phone delivery alarms (D25). They cover all 27: 24 CW alarms and 3 on-host rules.** The kept `ledger-processor-dlq` has its own heading (§4.1). Pubnet adds 5 alarms (§1.1); the balance, CW4 and `phone-delivery` headings cover them.
- **Decisions to make: §6 (D1–D30).** x402 money routes (ADR 0011): §3.3. **The phone route does not exist yet** (no SNS topic), so D11 blocks pubnet. Pubnet is also blocked by D21 (CW4 enabled on the phone), D22 (by default waits for 0139), D24 (CW2 does not latch across networks), D25 (SMS delivery alarms; today an SMS limit of $1/month and sandbox), D26 (source of the pubnet fee account) and D30 (x402-watch reads pubnet). The old Prices alarms stay until M2 acceptance by the CI gate and the SCF evidence (D7, D27, D28).

---

## 1. Results in numbers

### 1.1 Alarms and series

| Project | Alarms before | Alarms after (CloudWatch) | Custom series before | Custom series after |
|---|---|---|---|---|
| Prices API (data + runtime) | 87 | **13** | 66 | **16** |
| Explorer (prod + testnet) | 19 | **5** | 45 | **7** |
| x402 | 49 | **6** (+3 on-host rules) | 55 | **4** |
| **Total** | **155** | **24** (+3) | **166** | **27** |
| *Until 0242 closes and M2 acceptance (8 conditional Prices)* | | *24* (+3) | | *35* (24 + 7 + 4) |
| *State before 0139, sidecar gate open* | | *~60* (13 + 6 + 41) | | *~103* (24 + 45 + 34) |
| *State before 0139, after the sidecar gate* | | *~59* (13 + 5 + 41) | | *~65* (24 + 7 + 34) |
| *With x402 pubnet, after 0139 (D21, D25)* | | *29* (+3) | | *29* (27 + 2) |

x402 pubnet (after 0139) adds 5 alarms and 2 series:
- alarms: `balance-low-pubnet`, `balance-critical-pubnet`, CW4 `watch-security` (enabled, D21) and 2 phone route delivery alarms (D25);
- series: `x402-watch/spendable_stroops{network=stellar:pubnet}` and `x402-watch/security_findings` (CW4, "FUTURE" in the x402 plan). The D25 alarms read AWS/SNS metrics, not custom ones.
- On-host rules unchanged (+3): pubnet is a `network` label, not a new rule.

State before 0139 (Prices counted with the 8 conditional series, 16 + 8 = 24, because 0242 and M2 acceptance are not closed):
- x402 then keeps 41 alarms: 6 target CW alarms and 35 old alarms behind P1 (19), P2 (5) and P3 (11). P1–P3 have nowhere to run without Prometheus.
- x402 keeps 34 series: 4 target series and 30 series read by those 35 alarms. They move to Prometheus only in 0139 (in App. B: "conditionally, until 0139").
- Upper bound: +18 x402 series with fate drop (App. B), if they do not disappear from EMF before 0139. Then ~121 with CI.
- Explorer until the sidecar gate: 6 alarms (5 target ones and `production-galexie-ephemeral-storage`) and 38 Container Insights series.

Where these numbers come from:
- **Prices 13:**
  - from prices-data: PD-1, PD-2, PD-3, PD-4 and the kept `ledger-processor-dlq` (5);
  - from prices-runtime: PR-SERVE, PR-INGEST, PR-WORKERS-FAILING, PR-PROBES-SILENT, PR-WORKERS-SILENT, PR-RUNTIME-OUTPUTS, the kept `mtls-notafter` and the new `alert-notifier-health` (8).
- **Prices series 16:**
  - prices-data 13: `FailingChecks` and `FailingCriticalChecks` (2 new), `RollupLagSeconds` ×8, `ClickHouseDiskFreePercent`, `EnrichmentRowsEnriched` and `EnrichmentRowsRemainingRecent`;
  - prices-runtime 3: `MinDaysToNotAfter`, the new `RuntimeChecksFailing` and `PortalSourcesLoadFailed`. The last series is empty today, so it will be added as newly billed.
  - Conditionally +1: `SacContractIdentities` stays until 0242 closes, because the 0242 runbook reads it (§6, D6).
  - Conditionally +7: series required by the CI gate `verify-dashboard-synth.mjs` (M2). They go away only after M2 acceptance is confirmed (§6, D7).
- **Explorer 5:** `production-explorer-signal`, `production-explorer-new-cause`, `testnet-explorer-signal`, `testnet-explorer-new-cause`, `production-galexie-readiness`.
- **Explorer series 7:** `IngestionLagSeconds` ×2, `ReadinessFailing`, `Bits` ×2, `NewBits` ×2.
- **x402 6 CW:** `uptime`, `uptime-flapping`, `watch-blind`, `watch-findings`, `balance-low`, `balance-critical`.
- **x402 3 on-host:** `x402-settlement`, `x402-money`, `x402-runtime`.
- **x402 series 4:** `ready`, `spendable_stroops`, `findings` (new) and `disk_used_percent`. Unconditionally only after 0139. Before that 34 (see above).

Noise today (inventory):
- In total 251 `alarm_transitions_30d` transitions (per the explorer skeptic, the counter also includes ALARM→OK).
- 99 of the 155 alarms had 0 transitions in 30 days.
- Loudest: `prices-production-ledger-processor-unregistered-pool` 80, `production-ingestion-backlog-age` 14, `production-galexie-ingestion-lag` 14.
- Currently in ALARM: `prices-production-coverage-sweep-unclassified`, `prices-production-ledger-processor-unregistered-pool`, `production-enrichment-dlq-depth`, `testnet-enrichment-dlq-depth`.

### 1.2 CloudWatch cost / month

Rates: $0.30 per series, $0.10 per **metric in an alarm** (a metric-math alarm pays for each metric), after 10 free. AWS-native alarms stay in CloudWatch.

| | Before | After | *Before 0139 (sidecar open)* |
|---|---|---|---|
| Metrics in alarms | 170 → (170−10)×$0.10 = **$16.00** | ~44 → (44−10)×$0.10 = **$3.40** | *~88 → ~$7.80* |
| Custom series | (166−10)×$0.30 = **$46.80** | (27−10)×$0.30 = **$5.10** | *(103−10)×$0.30 = $27.90* |
| **Total** | **$62.80** | **$8.50** | *~$35.70* |

Caveats:
- 170 metrics counted from `MetricMath` in the inventory. After: ~44 (prices-data 6, prices-runtime ~24, explorer 7, x402 7).
- After, with the 8 conditional series (until 0242 and M2): (35−10)×$0.30 = $7.50 + $3.40 = **~$10.90**. No target alarm reads them, so metrics in alarms are unchanged.
- Before 0139: 103 series (24 Prices with the conditional ones, 45 explorer, 34 x402). 44 + 42 metrics of the 35 old x402 alarms + 2 `galexie-ephemeral-storage` metrics = ~88. Estimate.
- On a "$0.10 per alarm" basis it would come out to $61.30 → $6.50. I do not use that number.
- **Explorer task 0673 removes 38 Container Insights series anyway.** The fair "after 0673" baseline is 128 series, about $51.40/month (per metric). This plan goes down from it to $8.50.
- **New side costs (estimates from the plans, not measured):**
  - GetMetricData for the explorer evaluators about $3.4;
  - findings in x402-watch about $0.43;
  - Logs Insights scan in Prices $0.15–0.35;
  - Prices notifier about $0, but about $0.86 for each alarm hanging the whole month.
  - Total ~$4–5 /month on top of $8.50.
- **Variants that depend on gates and backend:**
  - Explorer has 6 alarms until the sidecar gate and keeps Container Insights.
  - With the Grafana backend, Prices drops to 13 series: FailingChecks, FailingCriticalChecks and RuntimeChecksFailing go away.
  - Pubnet for x402 (after 0139) adds 5 alarms (balance-low and balance-critical `-pubnet`, CW4 `watch-security` per D21, 2 D25 alarms) and 2 series (`spendable_stroops{pubnet}`, `security_findings`). That is +5 metrics in alarms and +2 series, about +$1.10 /month.
  - Pubnet before 0139 (variant D22) would require about 26 `-pubnet` copies, plus CW4 and 2 D25 alarms.

---

## 2. Pattern

### 2.1 Signal
- One alarm per area. Its value is a **number or a set of named causes**, not a single threshold value.
- The cause names (check_id, bit, label `cause`) tell the agent which runbook step to start from.
- Only these stay separate:
  - money signals on mainnet (ADR 0011: breaker, low balance, pending) and security signals (ADR 0013 via ADR 0011: theft, backup secret read). Their phone route is **designed, but does not exist**: there is no phone topic today (D11). Condition assignment: §3.3, table "Money routes";
  - signals that must work when ch-prod-01 or the evaluator is dead (DLQ, dead-man's, uptime).
- To phone (pubnet) in the x402 plan: P2, balance-low/critical, CW2 `watch-blind`, pager-class findings CW3 (`monitoring_deadman`, `audit_disk`) and CW4 (security route; CW4 must be enabled before pubnet, D21).
- Outside the plan, default in this report (§6): sweeps_stopped, check_error for pending, landed_after_expired, commit_unmatched (D1), P2 blindness (D2), agent_silent (D3) and the per-network `section_failed{section,network}` from x402-watch (D24) also go to phone on pubnet.
- Silence of the phone route itself (failed delivery, exhausted SMS limit) goes to Slack (D25). Full route table: §3.3.

### 2.2 Anti-latching: how a new cause gets through when the alarm is already in ALARM

| Area | Mechanism | Where the state is | Known limit |
|---|---|---|---|
| Prices data (PD-1) | Evaluator Lambda publishes one Chatbot message per new check_id | SSM `last-verdict` (survives a CH outage) | When one of several causes clears, CloudWatch sends nothing |
| Prices runtime (PR-*) | Lambda `alert-notifier` compares the cause set (MAX in the alarm window) with the set already announced | SSM `/prices/production/alerting/<alarm-name>` *(proposed)* | On a failed GetMetricData the notifier's health alarm catches the failure; the notifier itself is new code |
| Explorer | Separate edge alarm `*-new-cause` (ALARM actions only) on `NewBits`; the `*-signal` level never flaps | Stateless: the evaluator computes from 120 min of history | A second new cause in the same 5-min period gives no second transition (it is visible in the series) |
| x402 CloudWatch | x402-watch (off-server) holds named findings and publishes each new one to SNS itself | SSM `/x402/production/watch-findings-state` *(proposed)* | Broader IAM for the watch Lambda (D19) |
| x402 CW2 `watch-blind` | Today: MAX(Invocations<1, Errors>=1), and `runBalance` throws on every failed network, so flaky testnet RPC holds CW2 in ALARM and a pubnet section failure gives no new message (`docs/monitoring.md`: "While this alarm stays in ALARM, a failure of the other section sends no new message"). `balance-*-pubnet` (TreatMissingData ignore) then hold the old state. Default (D24): a failed section does not throw, the Lambda publishes the finding `section_failed{section,network}` like any other finding (pubnet: phone). CW2 catches only a dead or crashing Lambda | Like CW3: SSM `/x402/production/watch-findings-state` *(proposed)* | Lambda down entirely while CW2 is already in ALARM: no new message, but then both networks are blind at once and the page has already gone out |
| x402 on-host | Alertmanager, `group_interval 5m`. `group_by`: P1 `[alertname, network]`, P2 `[alertname, network, cause, breaker]`, P3 `[alertname, cause]` (as in the x402 plan) | Alertmanager | Events counted just before a crash are lost in the counter (accepted, triage reads the logs) |

Plus two mechanisms taken from cross-cutting:
- **P6, daily digest of hanging alarms:** already exists in `packages/mtls-notafter-probe/src/alarm_digest.rs` (task 0214). Change: a list of prefixes instead of `prices-{env}-`. In runtime the digest moves to the notifier.
- **P7, daily sweep of new error signatures (agent, read-only):**
  - `--log-group-names` does not accept wildcards. First a list of groups from `describe-log-groups`. 2026-11-16: 24 existing groups match the prefixes below, including `/ecs/production/galexie-live` and `/x402/production/metrics`. After the proposed Lambdas are deployed, 4 more are added (`prices-production-data-health-evaluator` and `-alert-notifier` via the prefix `prices-production-`, and both `*-explorer-signal-evaluator`), 28 in total. The start-query limit is 50.
  - Log format of `/ecs/production/galexie-live` (JSON or `level=error` in text): not checked, hence `level=error` in the regex.
  - `/x402/production/app` logs `level` in lowercase ("error"), the Prices and explorer Lambdas in uppercase ("ERROR").
  ```
  G=$(for p in /aws/lambda/prices-production- /aws/lambda/production-soroban-explorer- /aws/lambda/testnet-soroban-explorer- /aws/lambda/production-explorer-signal-evaluator /aws/lambda/testnet-explorer-signal-evaluator /aws/lambda/production-galexie-protocol-watch /aws/lambda/x402-production- /ecs/production/galexie-live /x402/production/app /x402/production/metrics; do aws logs describe-log-groups --profile soroban-readonly --region eu-central-1 --log-group-name-prefix $p --query 'logGroups[].logGroupName' --output text; done | tr '\t' ' ')
  Q='filter level in ["ERROR","error"] or @message like /Task timed out|Runtime\.ExitError|panicked|watch_section_failed|level=error/ | fields @timestamp, @log, coalesce(fields.message, event, msg) as sig | stats count(*) as n, earliest(@timestamp) as first by @log, sig | limit 10000'
  for W in "$(($(date +%s)-86400)) $(date +%s)" "$(($(date +%s)-691200)) $(($(date +%s)-86400))"; do set -- ${=W}; QID=$(aws logs start-query --profile soroban-readonly --region eu-central-1 --log-group-names ${=G} --start-time $1 --end-time $2 --query-string "$Q" --query queryId --output text); sleep 20; aws logs get-query-results --profile soroban-readonly --region eu-central-1 --query-id $QID --output json > ${WORKDIR}/p7-$1.json; done
  # zgłoś pary (@log, sig) obecne tylko w oknie now-24h..now (pierwszy plik); status Running → powtórz get-query-results
  ```
  `${=G}` is word-split in zsh; in bash a plain unquoted `$G`.

### 2.3 Silence = failure
- Every producer that can die has a silence deadline or a separate native dead-man:
  - PD-3 (Prices evaluator);
  - `alert-notifier-health`;
  - PR-PROBES-SILENT and PR-WORKERS-SILENT;
  - the "no datapoint" bit (breaching) in `*-explorer-signal`;
  - `RuntimeChecksFailing` (PR-RUNTIME-OUTPUTS): missing data breaching, a SQL error publishes 5 (§3.1);
  - x402 `watch-blind`, `monitoring_deadman`, `agent_silent`;
  - P2 `x402-money`: a separate silence clause in §3.3.
  - a single x402-watch section for one network: the finding `section_failed{section,network}` (D24), because CW2 may already be in ALARM;
  - the phone route itself (pubnet): 2 delivery alarms to Slack and a weekly SMS drill (D25).
- **Exception, disclosed blindness: PR-SERVE.** Missing data = notBreaching, because a quiet API (1–7 requests on some days) is not a failure (task 0223). A fully dark API, with no traffic, is not detected, neither today nor after the change. Only an external synthetic probe of `/v1`, independent of ch-prod-01, closes this (prices-runtime plan). Decision D13.
- Two weekly producers have no dead-man in the prices-runtime plan: `coverage-sweep-probe` (`cron(17 5 ? * MON *)`) and the rule `prices-production-backfill-reconcile` (`cron(47 5 ? * MON *)`, `{"check":"reconcile"}` to backfill-freshness-probe, source `backfill_overclaim`). PR-PROBES-SILENT does not see them: the 15-min run keeps backfill-freshness-probe Invocations up. Default (D23): both write a **mandatory** heartbeat (`coverage-sweep:run`, `backfill-reconcile:run`) to the proposed `prices.data_checks`, and PD-1 `producer_silent` watches them with a 7 d cadence (PD-1 step 2).
- A read that failed is `not_run` or `check_error`, never a healthy 0.
- Everything that watches ch-prod-01 is computed in AWS: uptime-probe, x402-watch, the Lambda evaluators.

### 2.4 Runbook format for the agent (skeleton from cross-cutting)
```
runbook: <signal id>
inputs: alarm_name; t0 = StateTransitionedTimestamp (nie StateUpdatedTimestamp); reason = StateReasonData
guard: AWS tylko describe/list/get/filter z --profile soroban-readonly --region eu-central-1; ClickHouse tylko SELECT;
       nigdy receive-message / redrive / purge / zapis po SSH; Code 497 → zapisz ACCESS_DENIED i kontynuuj po stronie AWS;
       timeout CH → cause CH_UNREACHABLE; krok kind=other/HUMAN-ONLY → przekaż człowiekowi
steps: { id, ask (tak/nie), kind, run (dokładna komenda z ${vars}), parse, branch: [{when, then: cause:<ID> | goto:<step>}], tells_apart }
exit: jedna przyczyna albo UNKNOWN z zebranymi wynikami → eskalacja do właścicieli topiców
record: alarm, term/contributor, t0, cause, evidence → notatka incydentu
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
  - DR4: each signal with a stopped producer.
  - (DR prefix, so as not to confuse with decisions D1–D30 in §6.)
- **Rule 5 of ADR 0054:** after each change, one test message passes the whole SNS → Chatbot → Slack chain in every channel.

### 2.6 Resolving overlaps (how I count)
- **prices-data vs prices-runtime:**
  - I count `ledger-processor-lag` in runtime (PR-INGEST).
  - I count the 7 runtime probe alarms in runtime.
  - I count `ClickHouseWriteLatencyMs` once, as dropped (runtime). Prices-data does not count it.
  - I count `EnrichmentRowsEnriched` and `EnrichmentRowsRemainingRecent` once, as kept (data).
  - The runtime condition for dropping `ledger-processor-no-invocations` ("1m freshness with silence = failure") is met by PD-1: `freshness:price_ohlcv_1m`, `producer_silent` and PD-3.
- **cross-cutting vs areas:** the cross-cutting plan covers 60 alarms: 49 in SIG-01..09, 3 kept (`x402-production-watch-no-invocations`, `x402-production-watch-errors`, `production-galexie-protocol-watch`) and 8 rejected (7× `*-duration-near-timeout`, `oracle-no-invocations`). All 60 already have an owner in the area plans. I count them there (App. A).
  - I do not adopt SIG-xx as alarms. The area plans already compose them without dedicated alarms, so it would not reduce anything, and two signal designs on the same metrics would give double pages.
  - I adopt from cross-cutting: the P2' pattern as a fallback for those who do not want a Lambda, P6, P7, the runbook skeleton, the drills and the requirement for an operator ClickHouse user.
  - Routing recommendation from cross-cutting: `production-galexie-readiness` additionally gets the topics `prices-production-ops-alarms` and `x402-production-alarms`, because a stopped Galexie also stops the Prices feed. Adopted by default, decision D17. Does not change the alarm count.
- **PR-RUNTIME-OUTPUTS, final choice:** it stays a separate signal and I count it that way (13 Prices alarms). Moving the 5 checks to PD-1 (fixed checks in `prices.data_checks`, −1 alarm, −1 series) is decision D5 in §6, not part of this plan.

---

## 3. Per project

### 3.1 Prices API

| Signal | Trigger (condition + source) | Replaces alarms | Custom metric? |
|---|---|---|---|
| PD-1 `prices-data-health` | Evaluator every 15 min reads the last run of each producer from `prices.data_checks` (CH, **proposed table**) and a 3-h Logs Insights scan of the ledger-processor. `FailingChecks >= 1` | 48 (+3 develop-only: sac-*), by name with check_id in App. A | yes (`FailingChecks`) |
| PD-2 `prices-data-health-critical` | `FailingCriticalChecks >= 1` (today only mv_drift_critical) | 1 | yes |
| PD-3 `prices-data-health-evaluator-silent` | AWS/Lambda Invocations−Errors of the evaluator < 1, 3×15 min, breaching | 0 (new dead-man) | no |
| PD-4 `ledger-processor-dlq-growing` | `DIFF(FILL(depth,REPEAT)) >= 1` on `prices-ingest-dlq-production`, no OKActions | 2 (dlq-10, dlq-50) | no |
| PR-SERVE | APIGW 5xx >= 5 or handler Errors >= 1 or PortalSourcesLoadFailed >= 1 (5 min) | 3 | yes (portal filter, defaultValue 0) |
| PR-INGEST | Minimum age of the oldest message in `prices-ingest-production` > 120 s or ledger-processor Errors >= 1 | 2 | no |
| PR-WORKERS-FAILING | Errors >= 1 of any of the 9 workers/probes or enrichment Max Duration >= 240 s; 900 s, 1 of 4 | 10 | no |
| PR-PROBES-SILENT | Invocations < 1 for rollup- and backfill-freshness-probe, 3×15 min, breaching | 2 | no |
| PR-WORKERS-SILENT | Invocations < 1 for asset-discovery, enrichment, coarse-sweep, 2×1 h, breaching | 3 | no |
| PR-RUNTIME-OUTPUTS | SQL: age of oracle XLM/USDC data, usd_rate USDC/XLM, supply > limit for 2 runs | 5 (App. A) | yes (`RuntimeChecksFailing`, CloudWatch path only) |
| `alert-notifier-health` (new) | Notifier Invocations < 1 or Errors >= 1, 2×15 min, breaching | 0 | no |

**`prices.data_checks`: proposed new table.** It does not exist in `packages/prices-clickhouse/schema/init.sql`. PD-1 steps 1–2 and the evaluator work only after it is created (out-of-band, like init.sql). DDL from the prices-data plan:
```sql
CREATE TABLE prices.data_checks (
  run_at DateTime DEFAULT now(), run_id UUID, producer LowCardinality(String), check_id String,
  family LowCardinality(String), status Enum8('ok'=0,'failing'=1,'not_run'=2),
  value Float64, threshold Float64, severity LowCardinality(String) DEFAULT 'normal',
  detail String CODEC(ZSTD(3))
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(run_at) ORDER BY (producer, run_at, check_id)
TTL run_at + INTERVAL 35 DAY
```
Until then, PD-1 triage goes through step 4 (probe logs).

**PR-RUNTIME-OUTPUTS: producer and silence.**
- Producer of `RuntimeChecksFailing` (Prices/Rollup, CloudWatch path): `prices-production-rollup-freshness-probe`. It runs the SQL at the start of each run and publishes `sum(failing)`.
- Alarm: Maximum, 900 s, 2 of 2, >= 1, **TreatMissingData breaching**, AlarmActions without OKActions.
- ClickHouse unreachable or SQL error: the probe publishes **5** and logs `runtime checks datasource error`. It never fails the invocation, so it does not latch PR-WORKERS-FAILING.
- Probe dead: no data → breaching after 2 runs. Plus PR-PROBES-SILENT.
- Oracle and supply dead-man (instead of `oracle-no-invocations` and `supply-no-invocations`): the worker stops, so its output goes stale. `oracle_*` fails after 30 min, `usd_rate_*` after 1–3 h, `supply` after 3 h. An empty set gives `max()` = 1970-01-01, i.e. failing.
- Grafana (A/B/C): rule on the ClickHouse datasource, NoData and DatasourceError alert.

**Stay separate:**
- `prices-production-ledger-processor-dlq` (native, >= 1). It must work when CH, the evaluator or ch-prod-01 are down; on 2026-08-13 91 messages landed here.
- `prices-production-mtls-notafter`, with TreatMissingData changed to breaching at 2 of 2 days. It has weeks of lead time and also catches probe silence.

**Rejected (9 alarms):**
- `ledger-processor-no-invocations`: in each of the 3 incidents rollup-freshness-1m was 6–8 min faster (describe-alarm-history).
- `mtls-notafter-probe-no-invocations`.
- `cleanup-errors`: rule DISABLED, no Errors series.
- 6× `*-duration-near-timeout`: asset-discovery, backfill-probe, coarse-sweep, mtls-probe, oracle, rollup-probe. A timeout is an Error, so PR-WORKERS-FAILING catches it. The trend goes into the notifier's daily headroom line.

**Rejected series (drop, 18; labels as in App. B.1):**
- `ClickHouseDiskFreeBytes`, `UnclassifiedSwapContracts`;
- 4 diagnostic CoarseSweep* (`DeadlineHit`, `RowsEnriched`, `TablesSkipped`, `TablesSwept`);
- 9 Enrichment* (4 of them conditional on M2 acceptance, D7);
- `DaysToNotAfter` ×2, `ClickHouseWriteLatencyMs` (conditional, D7);
- ~~`NewFailures`~~ (withdrawn from the first PD version, not counted).

**Replaced by runtime signals (12):**
- 6 → PR-WORKERS-FAILING: `CoarseSweepRuns`, `CoarseSweepFailedRuns`, `CoarseSweepDurationMs`, `CoarseSweepTableFailures`, `OracleRuns`, `OracleFailedRuns` (AWS/Lambda duplicates, task 0347);
- 6 Oracle* → PR-RUNTIME-OUTPUTS: `OracleMeasuredRatesSnapshotted`, `OracleUsdRatesSnapshotted`, `OracleRowsSkipped`, `OracleSymbolsQueried`, `OracleRowsWritten` and `OracleTimestampRejected` (the last two conditional, D7).

**Replaced by PD-1/PD-2 (24 series, no longer published):** 20× Prices/Rollup (AssetId* ×2, Candle* ×2, MvDrift* ×3, MvRefresh* ×4, RollupMismatchBuckets ×6, `SacContractIdentities`, Usdt* ×2), `EarliestOverclaimSeconds` ×2, `UnclassifiedSwapEvents`, `UnregisteredPoolEvents`. Only their alarms and runbooks 0100, 0139, 0142, 0151, 0242, 0286 read them (no dashboard widget). The runbooks must be rewritten to check_id. Exception: `SacContractIdentities` (D6). List: App. B.

This requires changing the CI gate `tools/scripts/verify-dashboard-synth.mjs` (assertions incl. `ClickHouseWriteLatencyMs`, `EnrichmentOracleMiss`, `OracleRowsWritten`, `OracleTimestampRejected`) and the widgets of the `prices-production-overview` dashboard.

### 3.2 Explorer

| Signal | Trigger | Replaces | Custom metric? |
|---|---|---|---|
| EXP-PROD-SIGNAL (`production-explorer-signal` + `production-explorer-new-cause`) | Evaluator every 2 min, GetMetricData from 9 native/EMF inputs, result in the `Bits` bitmask. Level `Bits + IF(FILL(lag,3600)>900, 2048, 0) >= 1`, breaching; edge `NewBits >= 1` | 8 | yes (Bits, NewBits, IngestionLag) |
| EXP-TESTNET-SIGNAL (`testnet-explorer-signal` + `testnet-explorer-new-cause`) | Same, 8 inputs, bits 1/8/16/32/128/1024 | 9 | yes |
| EXP-PROD-GALEXIE-READINESS | Extended `galexie-protocol-watch` every 30 min, bitmask `ReadinessFailing` (new core, xdr, disk, cannot check, memory), 2 of 2 h, breaching | 2 | yes (1 series instead of 38 Container Insights) |

Bits: 1 INDEXER_BEHIND, 2 GALEXIE_SILENT, 4 CATCHUP_STALLED, 8 DLQ_EXPIRING, 16 WORKER_ERRORS, 32 API_5XX, 64 ENRICHMENT_DLQ_GREW (NewBits only), 128 RUNAWAY_WAKEUPS, 1024 EVALUATOR_PARTIAL, 2048 RAW_LAG_BACKSTOP; NewBits ≥ 4096 = readiness.

**Stay separate:** nothing besides these three signals.

**Rejected:**
- A page for a single self-healing indexer error. This reverses the zero-tolerance decision of 2026-08-18.
- The "DLQ not empty" level. What stays is the edge on growth and bit 8 for content older than 10 days.
- `LastProcessedLedgerSequence` ×2, `ChWriteFailures`.
- Container Insights ×38 (drop, as in App. B.2), but only after the sidecar gate.
- The PutMetricData client in the indexer (drop). EMF takes over its role.

**Replaced:** `IndexerFailures` ×2 (production, testnet) → EXP-*-SIGNAL bit 1, as in App. B.2. The series is no longer published; dashboard widget → Logs Insights on `fields.alarm="indexer_failure"`.

### 3.3 x402

| Signal | Trigger | Replaces | Custom metric? |
|---|---|---|---|
| CW1 `uptime` | `x402-watch/ready` Min < 1 for 7 of 7 min, breaching (uptime-probe via Cloudflare) | 1 | yes (kept) |
| CW2 `watch-blind` | MAX(Invocations < 1, Errors >= 1) of the watch Lambda, 2 of 3×5 min, breaching. On pubnet it also goes to the phone. By default (D24) a failed network section does not count in Errors, it becomes a `section_failed{section,network}` finding instead (§2.2) | 2 | no |
| CW3 `watch-findings` | Number of held findings in x402-watch: protocol_changed/upgrade_coming, agent_silent, audit_disk (90%, off-host), log_flood, monitoring_deadman, upstream_*. Alarm to Slack; the Lambda itself posts every new finding, and pager-class ones (`monitoring_deadman`, `audit_disk`) on pubnet also to the phone | 8 | yes (`findings`, new; replaces 4 protocol series) |
| CW4 `watch-security` | Designed, disabled until decision 68: account_state, account_effects, backup_secret_read. >= 1, 300 s, 1 of 1, TreatMissingData ignore (CW2 guards the Lambda). On pubnet **security route and phone** (plan); the Lambda itself posts every finding (decision 64). Never folded into CW3 | 0 | future |
| P1 `x402-settlement` (on-host) | 13 event causes `x402_events_total{cause}` (increase > 0 in 15 min), 8 checks `x402_check_failing{cause}` == 1, `check_error`, openbao | 19 (alarm → cause in App. A) | Prometheus (not billed) |
| P2 `x402-money` (on-host, phone on pubnet) | breaker_opened{breaker}, budget_nearing, pending; never inhibited | 5 | Prometheus |
| P3 `x402-runtime` (on-host) | 11 causes: facilitator_unscraped, selfcheck_stalled, series_missing, host_probe_stale, credentials, certificate, disk (80%), disk_series_stale, memory, facilitator_failed, watchdog_restart | 11 (alarm → cause in App. A) | Prometheus (+ node_exporter) |

**Stay separate:**
- `uptime-flapping`, as decided in 0138. After merging, a recurrence within ~23 min after recovery would be invisible.
- `balance-low-testnet` and `balance-critical-testnet`: this is money in the sense of ADR 0011. Critical without low means a sudden drop, i.e. a theft indicator.

**Rejected from CloudWatch:**
- `settlement_outcomes_total{success}`, `settlement_reconciled_total{network}` (total; `{state=expired}` → P1), `lease_changes_total`, `balance_read_failures_total`, `discovery_unknown_params_total`, `catalog_attempts_total`, `pool_events_total{network}` (total; `{type=sequence-resync}` → P1);
- 6× `http_requests_total` per route;
- `fee_charged_stroops`: moves to Prometheus, ClickHouse is used only for cross-checking;
- 4 backup/snapshot/WAL series: deferred to 0026.
- These 18 series disappear from CloudWatch in 0139, unless they are removed from EMF earlier.

**Dependency:** P1–P3 require the 0139 cut-over (Prometheus + Alloy). Without a chosen backend these 3 rules have nowhere to run.
- Until 0139, the 35 old alarms behind P1–P3 keep running, and the 30 series they read stay in CloudWatch (§1.1, App. B: "conditional, until 0139").
- `x402-production-emf-parsing` and `emf-validation` (AWS/Logs on `/x402/production/metrics`) lose their purpose after 0139: the EMF path goes away. The successor is the P3 cause `series_missing`. Retire them in the same change that removes the `/x402/production/metrics` log group.
- `make fire-test` today uses `emf-validation` as the Slack test. After 0139 a test is needed for each path: on-host rule, CW3 self-post, plain CW alarm.

**Money routes (ADR 0011, pubnet).** Slack is not a pager. Every money and security condition has a phone/SMS route on pubnet.
- **The phone route does not exist today.** `sns list-topics` (2026-11-16): only `x402-production-alarms` and the Prices and explorer topics. Mechanism, numbers, on-call and credentials: D11, D12.
- "phone" below = the proposed topic `x402-production-phone` (D11). All three paths publish to the same topic: AlarmActions of CW alarms, x402-watch self-post and the SNS receiver of Alertmanager/Grafana.
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
| `monitoring_deadman` (P1–P3 do not evaluate or do not deliver) | CW3 self-post | phone + Slack | plan |
| `audit_disk` 90% (signing stops) | CW3 self-post | phone + Slack | plan |
| sweeps_stopped (the only pending guard when the sweep is suspended) | P1 | phone + Slack | **D1** |
| check_error{check=pending} (pending read throws) | P1 | phone + Slack | **D1** |
| landed_after_expired, commit_unmatched | P1 | phone + Slack | **D1** |
| facilitator_unscraped, selfcheck_stalled, series_missing (P2 blind) | P3 | phone + Slack | **D2**, matcher D16 |
| agent_silent (blind audit_disk) | CW3 self-post | phone + Slack | **D3** |
| uptime (CW1), openbao (P1) | CW1, P1 | Slack | open (D4) |
| phone route does not deliver (`NumberOfNotificationsFailed`, SMS limit) | 2 CW alarms on AWS/SNS | Slack (the phone is what is broken) + recurring SMS drill | **D25** |

**Implementation after 0139 (Alertmanager routes or Grafana policies, rule count unchanged):**
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
- until CW3: `x402-production-audit-disk` (pager-class: at 90% OpenBao refuses, signing stops) and for D3 `x402-production-telemetry-silent`. After CW3 their role is taken over by the self-post of the `audit_disk` / `agent_silent` findings to the phone.
- The gates from D21 (CW4 on the phone), D24 and D25 also apply in this variant. CW4 and the 2 D25 alarms bring it to ~26 `-pubnet` copies.
- The rest of the pubnet P1/P3 copies: only `x402-production-alarms` (Slack).

**P2 silence clause.** P2 runs on-host, so its silence must be seen by signals outside P2:
- Prometheus/Alertmanager (A), VPS (B) or Grafana Cloud (C) does not evaluate or does not deliver: no heartbeat on the *(proposed)* `x402-production-monitoring-heartbeat` → CW3 `monitoring_deadman` → phone (from AWS, x402-watch self-post).
- All of ch-prod-01 is down: the same `monitoring_deadman`, plus CW1 `uptime`.
- The facilitator is not scraped or the check loop is stuck: pending keeps the firing state (HOLD), but new causes do not appear. P3 `facilitator_unscraped` / `selfcheck_stalled` (route without `network`, D16) and `series_missing{network}` → phone (D2).
- Before 0139: P2 silence is seen by `facilitator-silent-*` and `gauges-silent-*` (phone on pubnet, above). Before 0139 `monitoring_deadman` has nothing to guard.
- Pending read throws: `check_error{check=pending}` → phone (D1).
- Sweep suspended after a sweep with no open records: pending reads 0. The guard is `sweeps_stopped` → phone (D1).
- x402-watch itself (the deadman evaluator) does not work: CW2 `watch-blind` → phone. A single pubnet section fails while CW2 is already in ALARM: `section_failed{...,stellar:pubnet}` → phone (D24).
- The phone does not deliver (SMS rejected, spend limit): D25 alarms → Slack. Without them each of the paths above ends in silence.
- Accepted loss: a breaker_opened counted right before a crash. After every restart the agent reads the logs (P2 step 2).

---

## 4. Triage runbooks

Common:
- **T0, session variables (once, before each runbook; zsh shell, hence `${=X}` for word splitting):**
  ```
  WORKDIR=$(mktemp -d); ALARM='<nazwa alarmu>'
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  T0=$(aws cloudwatch describe-alarms --alarm-names ${ALARM} --profile soroban-readonly --region eu-central-1 --query 'MetricAlarms[0].StateTransitionedTimestamp' --output text)
  T0_MINUS_2H=$(date -u -r $(( $(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${T0%%.*}" +%s) - 7200 )) +%Y-%m-%dT%H:%M:%SZ)
  ```
  `date -j -f` / `-r` is macOS syntax; on Linux use `date -u -d "$T0 - 2 hours" +%Y-%m-%dT%H:%M:%SZ`.
- **T1, reading the terms of a metric-math alarm:**
  ```
  aws cloudwatch describe-alarms --alarm-names ${ALARM} --profile soroban-readonly --region eu-central-1 --query 'MetricAlarms[0].Metrics[?MetricStat]' --output json | jq 'map(.ReturnData=true)' > ${WORKDIR}/q.json && aws cloudwatch get-metric-data --metric-data-queries file://${WORKDIR}/q.json --start-time ${T0_MINUS_2H} --end-time ${NOW} --profile soroban-readonly --region eu-central-1 --query 'MetricDataResults[].[Id,Label,Values[0:8]]' --output json
  ```
- **T2, running a Logs Insights query.** Every logs step names its log group (`-- log group:` or the parenthesis in the heading). `${QUERY}` is the query text from the step.
  ```
  QID=$(aws logs start-query --profile soroban-readonly --region eu-central-1 --log-group-names ${LOG_GROUP} --start-time $(($(date +%s)-${WINDOW_S})) --end-time $(date +%s) --query-string "${QUERY}" --query queryId --output text); sleep 10; aws logs get-query-results --profile soroban-readonly --region eu-central-1 --query-id $QID --output json
  ```
  → `status` = Running: repeat get-query-results. Several groups: several `--log-group-names`.
- **T3, reading on-host state (PromQL) for P1–P3 and CW1 step 4.** There is no endpoint for the agent today: 0139 has not chosen a backend or exposed an API. Until then, `promql` steps are **HUMAN-ONLY**. The agent moves to the logs step (`/x402/production/app`) and records `ONHOST_UNREADABLE`.
  - A (Prometheus + Alertmanager on ch-prod-01; default ports, not configured): HUMAN-ONLY over SSH, `curl -sG http://127.0.0.1:9090/api/v1/query --data-urlencode "query=${PROMQL}" | jq '.data.result'` and `curl -s 'http://127.0.0.1:9093/api/v2/alerts?active=true' | jq '.[] | {a:.labels.alertname,c:.labels.cause,n:.labels.network,since:.startsAt}'`.
  - B (VPS): the same two APIs on the VPS; 0139 will define auth.
  - C (Grafana Cloud): `curl -s -H "Authorization: Bearer ${GRAFANA_SA_TOKEN}" https://${STACK}.grafana.net/api/alertmanager/grafana/api/v2/alerts` (from the x402 plan) and `.../api/datasources/proxy/uid/${PROM_UID}/api/v1/query`. No read-only token for the agent exists.
  - Agent path after 0139: D14.
- **T4, entry before 0139 (35 old CW alarms standing in for P1–P3).** Alarm name → cause from App. A.3, then the alarm's metric with the **full dimension set taken from the alarm itself** (as in T1). Do not type dimensions by hand: many alarms have several, e.g. `breaker-opened-testnet-*` {breaker, network}, `sweeps-stopped-testnet` {network, outcome=listed}, `failure-ours-testnet` {fault, network}, `pool-health-testnet` {network, type}, `refused-after-verify-testnet` {network, stage}, `settlement-expired-testnet` {network, state}, `http-500` {status=500}, `disk-root` {path=/}, `emf-*` {LogGroupName}. A query with an incomplete set returns 0 datapoints.
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

### 4.1 Prices

#### PD-1 prices-data-health

0. **Agent permissions.** Identity with SELECT on `prices.*`, `system.view_refreshes`, `system.tables`, `system.parts`, `default.ledgers`, `default.soroban_contracts`.
   - `prices_writer` gets Code 497 on `view_refreshes`.
   - The grant on `default.ledgers` is not documented (not checked).
   ```sql
   SHOW GRANTS;
   ```
   → A missing grant gives ACCESS_DENIED, and that is not a finding in the data. If the query itself fails: CH or the mTLS cert is down; escalate as a host incident and take the verdict from SSM (step 3).

1. **Evaluator verdict.** Entry for every PD-1 and every "new cause" message. Steps 1–2 require the `prices.data_checks` table (proposed, §3.1). When it is missing (Code 60, UNKNOWN_TABLE): step 3, then step 4.
   ```sql
   WITH (SELECT argMax(run_id, run_at) FROM prices.data_checks WHERE producer = 'evaluator' AND check_id = 'evaluator:run' AND run_at >= now() - INTERVAL 1 DAY) AS last_eval
   SELECT run_at, check_id, family, severity, toString(status) AS status, value, threshold, detail FROM prices.data_checks WHERE producer = 'evaluator' AND run_id = last_eval AND run_at >= now() - INTERVAL 1 DAY ORDER BY check_id = 'evaluator:run' DESC, severity = 'critical' DESC, family, check_id;
   -- widok surowy (bez holdów i mute'ów):
   SELECT c.producer, c.check_id, c.family, c.severity, toString(c.status) AS status, c.value, c.threshold, c.detail, c.run_at FROM prices.data_checks AS c INNER JOIN (SELECT producer, argMax(run_id, run_at) AS run_id FROM prices.data_checks WHERE check_id = concat(producer, ':run') AND run_at >= now() - INTERVAL 8 DAY GROUP BY producer) AS l ON c.producer = l.producer AND c.run_id = l.run_id WHERE c.run_at >= now() - INTERVAL 8 DAY AND c.status != 'ok' ORDER BY c.severity = 'critical' DESC, c.family, c.check_id
   ```
   → family points to the next step:
   - freshness: 5–6
   - mv_refresh: 7
   - mismatch: 8
   - disk: 9
   - mv_drift: 10
   - usd: 11
   - zero_invariant / ohlc_band: 12
   - asset_id / sac: 13
   - ingest_*: 14–16
   - enrichment: 17
   - coverage: 18
   - backfill: 19
   - producer_silent: 2
   - mute_expired: 3
   - clickhouse_unreachable / state_write_failed: step 9 and a host incident.

   A check failing in the raw view but absent from the verdict is covered by a hold or a mute.

2. **producer_silent.** Which producer stopped.
   ```sql
   SELECT producer, max(run_at) AS last_run, dateDiff('minute', max(run_at), now()) AS minutes_since, argMax(toString(status), run_at) AS last_heartbeat_status FROM prices.data_checks WHERE check_id = concat(producer, ':run') AND run_at >= now() - INTERVAL 8 DAY GROUP BY producer ORDER BY minutes_since DESC
   ```
   → Cadences: 15 min for evaluator, probes and ingest-log-scan; 60 min for enrichment-worker; 7 d for `coverage-sweep` (Mon 05:17 UTC) and `backfill-reconcile` (Mon 05:47 UTC, rule `prices-production-backfill-reconcile`). Both weekly heartbeats are mandatory (D23).
   - No `backfill-reconcile` or `coverage-sweep` row in the result (no run in 8 d) is also `producer_silent`, not "healthy".
   - Stale `backfill-reconcile`: `aws events describe-rule --profile soroban-readonly --region eu-central-1 --name prices-production-backfill-reconcile --query '[State,ScheduleExpression]' --output text` and `aws events list-targets-by-rule --profile soroban-readonly --region eu-central-1 --rule prices-production-backfill-reconcile --query 'Targets[].[Arn,Input]' --output text` (expected `ENABLED` and `{"check":"reconcile"}`).
   - A stale producer means a Lambda is down (see PR-WORKERS-*), not necessarily bad data.
   - `not_run` means an interrupted run; read the Lambda errors.

3. **Mutes and the last verdict (works without CH).** Both SSM parameters are *(proposed)*; today `ParameterNotFound`.
   ```
   aws ssm get-parameter --profile soroban-readonly --region eu-central-1 --name /prices/production/data-health/last-verdict --query Parameter.Value --output text
   aws ssm get-parameter --profile soroban-readonly --region eu-central-1 --name /prices/production/data-health/mutes --query Parameter.Value --output text
   ```
   → `mute_expired` means the mute's task is not finished: reopen it, do not silently extend the mute. Enter a known, long-running cause into mutes, with an expiry date and the task number.

4. **Equivalent of step 1 before `data_checks` is deployed** (log group `/aws/lambda/prices-production-rollup-freshness-probe`).
   ```
   fields @timestamp, fields.checks_failed, fields.tiers, fields.current_prices_age_seconds, fields.current_prices_rows, fields.disk_free_percent, fields.usd_peg_applied, fields.usd_stranded, fields.zero_invariant_violations, fields.asset_identities, fields.asset_ids, fields.asset_id_orphan_candles, fields.mv_drift_critical, fields.mv_drift, fields.mv_visible_objects, fields.mv_detail, fields.mv_refresh_waiting, fields.mv_refresh_disabled, fields.mv_refresh_failing, fields.mv_refresh_failing_views, fields.mv_refresh_unreadable, fields.ohlc_band_violations, fields.ohlc_band_detail, fields.rollup_mismatch
   | filter fields.message = 'rollup-freshness-probe run complete'
   | sort @timestamp desc | limit 4
   -- potem: filter @message like /probe check\(s\) failed/ | fields @timestamp, @message | sort @timestamp desc | limit 5
   ```
   → A "failed/unreadable" reading is a check that did not run, not 0. The field format was verified in the original plan, not re-checked here.

5. **freshness:\*.** Age of the tiers and of `current_prices`.
   ```sql
   SELECT * FROM (
    SELECT 'price_ohlcv_1m' AS t, 900 AS bound_s, toInt64(toUnixTimestamp(now()) - toUnixTimestamp(max(timestamp))) AS lag_s FROM prices.price_ohlcv_1m HAVING count() > 0
    UNION ALL SELECT 'price_ohlcv_15m', 3600, toInt64(toUnixTimestamp(now()) - toUnixTimestamp(max(timestamp))) FROM prices.price_ohlcv_15m HAVING count() > 0
    UNION ALL SELECT 'price_ohlcv_1h', 10800, toInt64(toUnixTimestamp(now()) - toUnixTimestamp(max(timestamp))) FROM prices.price_ohlcv_1h HAVING count() > 0
    UNION ALL SELECT 'price_ohlcv_4h', 43200, toInt64(toUnixTimestamp(now()) - toUnixTimestamp(max(timestamp))) FROM prices.price_ohlcv_4h HAVING count() > 0
    UNION ALL SELECT 'price_ohlcv_1d', 172800, toInt64(toUnixTimestamp(now()) - toUnixTimestamp(max(timestamp))) FROM prices.price_ohlcv_1d HAVING count() > 0
    UNION ALL SELECT 'price_ohlcv_1w', 864000, toInt64(toUnixTimestamp(now()) - toUnixTimestamp(max(timestamp))) FROM prices.price_ohlcv_1w HAVING count() > 0
    UNION ALL SELECT 'price_ohlcv_1M', 3888000, toInt64(toUnixTimestamp(now()) - toUnixTimestamp(max(timestamp))) FROM prices.price_ohlcv_1M HAVING count() > 0
    UNION ALL SELECT 'current_prices', 900, toInt64(toUnixTimestamp(now()) - toUnixTimestamp(max(updated_at))) FROM prices.current_prices
   ) ORDER BY lag_s > bound_s DESC, t
   ```
   → The thresholds in the query are examples; the real ones are in `config.opsAlarms`. The culprit is the finest stale tier.
   - 1m stale: step 6.
   - 1m fresh, higher tier stale: MV chain (step 7).
   - Tier missing from the result: the tier is empty.
   - `current_prices` stale with 1m fresh: `mv_current_prices`.

6. **1m stale: explorer upstream or the Prices processor?**
   ```sql
   SELECT 'be_ledgers' AS src, toString(max(sequence)) AS ledger, dateDiff('second', max(closed_at), now()) AS age_s FROM default.ledgers WHERE sequence >= (SELECT max(sequence) FROM default.ledgers) - 1000
   UNION ALL
   SELECT concat('prices_cursor:', id), toString(ledger), dateDiff('second', updated_at, now()) FROM prices.ingest_cursor FINAL
   ```
   → Old explorer tip: upstream stall, a matter for the explorer. Fresh explorer and old cursor: ledger-processor (PR-INGEST, PD-4). Fresh cursor and old 1m: drops (step 14) or write errors.

7. **mv_refresh.**
   ```sql
   SELECT view, toString(status) AS status, last_success_time, next_refresh_time, leftUTF8(exception, 300) AS exception FROM system.view_refreshes WHERE database = 'prices' ORDER BY view
   ```
   → Disabled: a forgotten SYSTEM STOP VIEW (runbook 0286). WaitingForDependencies: go down the chain. Exception or old last_success: step 10. All Scheduled: the input is stale (step 6). No rows: the views are gone or the identity cannot see them.

8. **mismatch.** Closed buckets that do not match, and backfill.
   ```sql
   SELECT s.ts, s.asset_id, s.quote_asset_id, s.source, s.tc AS src_trades, d.trade_count AS tgt_trades, s.vb AS src_vol, d.volume_base AS tgt_vol FROM (SELECT toStartOfInterval(timestamp, INTERVAL 15 MINUTE) AS ts, asset_id, quote_asset_id, source, sum(trade_count) AS tc, sum(volume_base) AS vb FROM prices.price_ohlcv_1m FINAL WHERE timestamp >= now() - INTERVAL 7 DAY GROUP BY ts, asset_id, quote_asset_id, source HAVING ts + INTERVAL 15 MINUTE <= now() - INTERVAL 2 HOUR) AS s LEFT JOIN (SELECT timestamp AS ts, asset_id, quote_asset_id, source, trade_count, volume_base FROM prices.price_ohlcv_15m FINAL WHERE timestamp >= now() - INTERVAL 7 DAY) AS d USING (ts, asset_id, quote_asset_id, source) WHERE d.trade_count IS NULL OR d.trade_count != s.tc OR d.volume_base != s.vb ORDER BY s.ts DESC LIMIT 50 SETTINGS join_use_nulls = 1;
   SELECT task_name, toString(status) AS status, current_ledger, target_ledger, last_push_at, updated_at FROM prices.backfill_progress FINAL ORDER BY updated_at DESC
   ```
   → The query is only an approximation of `reconcile_mismatch_select`. Tier pairs: 1m→15m→1h→4h→1d, 1d→1w, 1d→1M.
   - Only 15m: a hole in 1m (step 14, PD-4).
   - A higher tier alone: `mv_reconcile_<src>_to_<dst>`.
   - A running backfill: mute with an expiry date.
   - Older than 7 d: runbook 0142.

9. **disk / clickhouse_unreachable / state_write_failed.**
   ```sql
   SELECT filesystemAvailable() AS available_bytes, filesystemCapacity() AS capacity_bytes, round(100 * filesystemAvailable() / filesystemCapacity(), 1) AS free_pct;
   SELECT database, formatReadableSize(sum(bytes_on_disk)) AS size, sum(bytes_on_disk) AS b FROM system.parts WHERE active GROUP BY database ORDER BY b DESC
   ```
   → The volume is shared. Growth in the explorer databases means escalation to the explorer. A full disk explains state_write_failed, a DLQ wave (Code 243) and freshness all at once.

10. **mv_drift / mv_drift_critical.**
    ```sql
    SELECT count() AS visible_prices_objects FROM system.tables WHERE database = 'prices';
    SELECT name, position(create_table_query, ' APPEND') > 0 AS has_append, leftUTF8(create_table_query, 200) AS head FROM system.tables WHERE database = 'prices' AND engine = 'MaterializedView' AND (name LIKE 'mv_ohlcv_%' OR name LIKE 'mv_reconcile_%') ORDER BY name
    -- diff: cargo run -p prices-clickhouse --bin prices-clickhouse-drift -- --verbose
    ```
    → 0 objects: narrowed grant. `has_append = 0` on a rollup MV: CRITICAL (PD-2).

11. **usd_peg_applied / usd_stranded.**
    ```sql
    SELECT 'peg_applied_1m_48h' AS k, source, countIf(close_usd > 0 AND abs(close_usd / close - 1) < 0.02) AS bad, count() AS scanned FROM prices.price_ohlcv_1m FINAL WHERE quote_asset_id IN (SELECT asset_id FROM prices.assets FINAL WHERE asset_code = 'USDT' AND issuer_address = 'GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQIAPW53XBRJVN6ZJVTG6V') AND close > 0 AND timestamp >= now() - INTERVAL 2 DAY GROUP BY source
    UNION ALL
    SELECT 'stranded_1h_7d', source, countIf(close_usd = 0 AND close > 0.00000000000005 AND timestamp < now() - INTERVAL 2 DAY), count() FROM prices.price_ohlcv_1h FINAL WHERE quote_asset_id IN (SELECT asset_id FROM prices.assets FINAL WHERE asset_code = 'USDT' AND issuer_address = 'GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQIAPW53XBRJVN6ZJVTG6V') AND close > 0 AND timestamp >= now() - INTERVAL 7 DAY GROUP BY source
    ORDER BY k, bad DESC
    ```
    → peg > 0: enrichment applies the peg to USDT again. stranded > 0: the pivot does not price a leg (class 0209). No rows: `not_run`, not healthy.

12. **zero_invariant / ohlc_band.**
    ```sql
    SELECT source, countIf(pf_trade_count = 0 AND close != 0) AS no_fill_but_price, countIf(close_usd > 0 AND close = 0) AS usd_without_close, countIf(pf_trade_count > 0 AND close = 0) AS fills_without_price, countIf(pf_trade_count > 0 AND open > 0 AND high > 0 AND low > 0 AND close > 0 AND (low > least(open, close) OR high < greatest(open, close) OR low > high)) AS band, countIf(pf_trade_count > 0 AND (open <= 0 OR high <= 0 OR low <= 0 OR close <= 0)) AS nonpositive, count() AS scanned FROM prices.price_ohlcv_1m FINAL WHERE timestamp >= now() - INTERVAL 2 DAY GROUP BY source ORDER BY (no_fill_but_price + usd_without_close + fills_without_price + band + nonpositive) DESC
    ```
    → `fills_without_price`: missing `pf_trade_count` (ADR 0287). A result on 1m points to the writer by `source`. A bad higher tier with a clean 1m: rollup defect.

13. **asset_id and SAC.**
    ```sql
    SELECT asset_id, groupArray((asset_code, issuer_address, contract_address)) AS identities FROM prices.assets FINAL GROUP BY asset_id HAVING count() > 1 LIMIT 20;
    SELECT source, count() AS orphans FROM prices.price_ohlcv_1m FINAL WHERE timestamp >= now() - INTERVAL 2 HOUR AND (asset_id NOT IN (SELECT asset_id FROM prices.assets) OR quote_asset_id NOT IN (SELECT asset_id FROM prices.assets)) GROUP BY source;
    SELECT asset_id, contract_address FROM prices.assets FINAL WHERE contract_address IN (SELECT sac_address FROM prices.assets WHERE sac_address != '') OR contract_address IN (SELECT contract_id FROM default.soroban_contracts WHERE is_sac)
    ```
    → Collisions: runbook 0139. SAC above baseline 36: runbook 0242.

14. **ingest_drop / ingest_degraded** (`/aws/lambda/prices-production-ledger-processor`, 3 h).
    ```
    fields @timestamp, @logStream | filter fields.message like /dropped trades from pools missing|token decimals did not resolve|iteration budget exhausted|no SAC proof|is_sac contract set unreadable/
    | stats count() as runs, min(@timestamp) as first, max(@timestamp) as last, count_distinct(@logStream) as containers by fields.message, fields.contracts | sort last desc
    ```
    → Pools missing: step 15. Decimals: step 16. Iteration budget: `maxIterations`. No SAC proof: 0242. is_sac unreadable: container cold start. Every drop requires repricing.

15. **unregistered_pool.**
    ```sql
    SELECT c.contract_id, lower(hex(c.wasm_hash)) AS wasm, c.is_sac, r.venue AS registered_venue FROM default.soroban_contracts AS c FINAL LEFT JOIN (SELECT contract_id, venue FROM prices.pool_registry FINAL) AS r USING (contract_id) WHERE c.contract_id IN ('<contracts from step 14>') SETTINGS join_use_nulls = 1;
    SELECT venue, wasm_hash, count() AS pools FROM prices.pool_registry FINAL GROUP BY venue, wasm_hash ORDER BY venue, pools DESC
    ```
    → Known wasm: a missed factory event. New wasm: a task for the venue. Contract already in the registry: a warm processor from before registration (cold start). I assume `wasm_hash` in the registry is lowercase hex.

16. **missing_decimals.**
    ```sql
    SELECT contract_address, decimals, fetched_at FROM prices.asset_decimals FINAL WHERE contract_address IN ('<contracts from step 14>')
    ```
    → Row present: RPC was failing, retry after 10 min. No row: insert it by hand, do a cold start, then reprice.

17. **enrichment_pass.**
    ```sql
    SELECT countIf(volume_quote_usd = 0 AND volume_quote > 0) AS zero_usd_recent, count() AS rows_recent, max(timestamp) AS newest FROM prices.price_ohlcv_1m FINAL WHERE timestamp >= now() - INTERVAL 4 HOUR;
    SELECT asset_code, issuer_address, contract_address, asset_id FROM prices.assets FINAL WHERE asset_code IN ('USDC', 'USDT', 'XLM');
    SELECT oracle_name, max(timestamp) AS newest, dateDiff('minute', max(timestamp), now()) AS age_min FROM prices.oracle_prices WHERE timestamp >= now() - INTERVAL 1 DAY GROUP BY oracle_name
    -- log group /aws/lambda/prices-production-enrichment (T2, 6 h): filter fields.message = 'enrichment pass complete' and ispresent(fields.rows_enriched) | fields @timestamp, fields.rows_enriched, fields.rows_remaining_recent, fields.oracle_misses, fields.candidates_before | sort @timestamp desc | limit 6
    ```
    → `rows_enriched = 0` with rising zero_usd: stall. Old oracle: PR-RUNTIME-OUTPUTS. No lines: producer_silent.

18. **coverage_unclassified** (`/aws/lambda/prices-production-coverage-sweep-probe`).
    ```
    fields @timestamp, fields.contract, fields.wasm, fields.events, fields.txs, fields.first_ledger, fields.last_ledger, fields.top_action, fields.top_shape
    | filter fields.message = 'unclassified swap emitter'
    | sort fields.events desc
    ```
    → Three options: register, a task for the venue, or the allow-list. Until classified, mute with an expiry date (the emitters from 2026-11-09 are in task 0345 C).

19. **backfill.**
    ```sql
    SELECT task_name, toString(status) AS status, last_push_at, dateDiff('hour', last_push_at, now()) AS push_age_h, earliest_data_available, newest_data_available, current_ledger, target_ledger FROM prices.backfill_progress FINAL ORDER BY task_name;
    SELECT if(source = 'sdex', 'sdex_archive', 'soroban_amm') AS task_name, min(timestamp) AS first_1h_row FROM prices.price_ohlcv_1h GROUP BY task_name
    ```
    → running and push_age_h > 168: a killed run. `earliest_data_available` < first_1h_row: overclaim (task 0264). The second query is a full scan; run it rarely.

#### PD-2 prices-data-health-critical
1. **Which MV lost APPEND?** Do this first, because every refresh destroys history.
   ```sql
   SELECT name, position(create_table_query, ' APPEND') > 0 AS has_append, leftUTF8(create_table_query, 200) AS head FROM system.tables WHERE database = 'prices' AND engine = 'MaterializedView' AND (name LIKE 'mv_ohlcv_%' OR name LIKE 'mv_reconcile_%') ORDER BY has_append, name
   ```
   → `has_append = 0`: STOP VIEW (admin, runbook 0286), recreate with APPEND. All 1: false alarm, run the drift tool `--verbose`.
2. **Damage.**
   ```sql
   SELECT 'price_ohlcv_1d' AS t, min(timestamp) AS oldest, count() AS rows FROM prices.price_ohlcv_1d
   UNION ALL SELECT 'price_ohlcv_1w', min(timestamp), count() FROM prices.price_ohlcv_1w
   UNION ALL SELECT 'price_ohlcv_1M', min(timestamp), count() FROM prices.price_ohlcv_1M
   ```
   → Target much younger than source: history destroyed, re-roll (0142/0286).

#### PD-3 evaluator-silent
The Lambda `prices-production-data-health-evaluator` and its log group are *(proposed)*.
1. **Schedule and function state.**
   ```
   aws events list-rule-names-by-target --profile soroban-readonly --region eu-central-1 --target-arn "$(aws lambda get-function --profile soroban-readonly --region eu-central-1 --function-name prices-production-data-health-evaluator --query Configuration.FunctionArn --output text)"
   aws lambda get-function-configuration --profile soroban-readonly --region eu-central-1 --function-name prices-production-data-health-evaluator --query '{state:State,last:LastUpdateStatus,modified:LastModified,timeout:Timeout}'
   ```
   → No rule or State != Active: deploy or configuration. Recent LastModified: bad deploy.
2. **Errors** (`/aws/lambda/prices-production-data-health-evaluator`).
   ```
   fields @timestamp, @message | filter @message like /ERROR|Task timed out|AccessDenied|ThrottlingException|ParameterNotFound/ | sort @timestamp desc | limit 20
   ```
   → AccessDenied: IAM. Timeout: scan or CH. ParameterNotFound: SSM.

#### PD-4 ledger-processor-dlq-growing
1. **Depth** (read-only; never receive-message).
   ```
   aws sqs get-queue-attributes --profile soroban-readonly --region eu-central-1 --queue-url "$(aws sqs get-queue-url --profile soroban-readonly --region eu-central-1 --queue-name prices-ingest-dlq-production --query QueueUrl --output text)" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
   ```
   → 1 message without growth: poison ledger. Steady growth: step 2. NotVisible > 0: someone is reading the queue.
2. **Error classes** (`/aws/lambda/prices-production-ledger-processor`).
   ```
   fields @timestamp, level, fields.message | filter level = 'ERROR' or @message like /Task timed out|Code: 243|ACCESS_DENIED|certificate|TIMEOUT_EXCEEDED/ | stats count() as n, max(@timestamp) as last by fields.message | sort n desc | limit 20
   ```
   → 243: disk (PD-1 step 9). TLS errors: mtls-notafter. ACCESS_DENIED: grant on the explorer side (task 0477).

#### ledger-processor-dlq (kept)
First message in `prices-ingest-dlq-production` (>= 1, notBreaching). Works without CH and without the evaluator.
1. **Depth and growth:** PD-4 step 1. If depth is growing, PD-4 will fire separately anyway.
2. **Error class:** PD-4 step 2 (log group `/aws/lambda/prices-production-ledger-processor`, T2, 3 h).
3. **Are candles missing?** PD-1 step 6 (cursor `prices.ingest_cursor` vs the explorer tip) and step 5 (1m freshness).
   → Fresh cursor and fresh 1m: a single poison ledger, hole only in that ledger. Old cursor: PR-INGEST.
4. **Was CH available at the time?** P0 (query_log) and PD-1 step 9 (disk). The wave of 2026-08-13 (91 messages) was a full disk.
5. **HUMAN-ONLY: redrive.** Only after the cause is removed. The agent never does receive-message, redrive or purge. After redrive: step 3 again (cursor and 1m). I did not find a separate redrive runbook for Prices (not checked beyond `docs/runbooks/deploy-ledger-processor.md`).

#### PR-SERVE
1. **Which input?**
   ```
   aws cloudwatch get-metric-data --profile soroban-readonly --region eu-central-1 --start-time $(($(date +%s)-3600)) --end-time $(date +%s) --metric-data-queries '[{"Id":"gw5xx","MetricStat":{"Metric":{"Namespace":"AWS/ApiGateway","MetricName":"5XXError","Dimensions":[{"Name":"ApiName","Value":"prices-production-api"},{"Name":"Stage","Value":"production"}]},"Period":300,"Stat":"Sum"}},{"Id":"gw4xx","MetricStat":{"Metric":{"Namespace":"AWS/ApiGateway","MetricName":"4XXError","Dimensions":[{"Name":"ApiName","Value":"prices-production-api"},{"Name":"Stage","Value":"production"}]},"Period":300,"Stat":"Sum"}},{"Id":"gwcount","MetricStat":{"Metric":{"Namespace":"AWS/ApiGateway","MetricName":"Count","Dimensions":[{"Name":"ApiName","Value":"prices-production-api"},{"Name":"Stage","Value":"production"}]},"Period":300,"Stat":"Sum"}},{"Id":"gwlat","MetricStat":{"Metric":{"Namespace":"AWS/ApiGateway","MetricName":"IntegrationLatency","Dimensions":[{"Name":"ApiName","Value":"prices-production-api"},{"Name":"Stage","Value":"production"}]},"Period":300,"Stat":"p99"}},{"Id":"herr","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"Errors","Dimensions":[{"Name":"FunctionName","Value":"prices-production-api-handler"}]},"Period":300,"Stat":"Sum"}},{"Id":"hthr","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"Throttles","Dimensions":[{"Name":"FunctionName","Value":"prices-production-api-handler"}]},"Period":300,"Stat":"Sum"}},{"Id":"hconc","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"ConcurrentExecutions","Dimensions":[{"Name":"FunctionName","Value":"prices-production-api-handler"}]},"Period":300,"Stat":"Maximum"}},{"Id":"portal","MetricStat":{"Metric":{"Namespace":"Prices/ApiHandler","MetricName":"PortalSourcesLoadFailed"},"Period":300,"Stat":"Sum"}}]' --query 'MetricDataResults[].[Id,join(`,`,to_array(to_string(Values)))]' --output text
   ```
   → herr > 0: step 2. gw5xx and hthr > 0: Lambda throttling. gw5xx with herr = 0 and high gwlat: CH (step 3). Rising gw4xx: stage throttling (429), which does not trigger the signal. portal: step 4.
2. **Handler errors** (`/aws/lambda/prices-production-api-handler`).
   ```
   fields @timestamp, level, fields.message, fields.error
   | filter level = 'ERROR' or level = 'WARN' or @message like /Task timed out|panicked|Runtime\.ExitError|INIT_REPORT/
   | stats count(*) as n, latest(fields.error) as last_error by fields.message
   | sort n desc
   | limit 20
   ```
   → Timeout (15 s): CH. Panic: code. CH codes: 201 quota, 497 grant.
3. **CH side** (requires SELECT on `system.query_log`, not checked).
   ```sql
   SELECT user, count() AS queries, countIf(exception_code != 0) AS failed, groupUniqArrayIf(5)(exception_code, exception_code != 0) AS error_codes, quantile(0.99)(query_duration_ms) AS p99_ms, max(memory_usage) AS max_mem
   FROM system.query_log WHERE event_time > now() - INTERVAL 1 HOUR AND type IN ('QueryFinish', 'ExceptionBeforeStart', 'ExceptionWhileProcessing')
   GROUP BY user ORDER BY failed DESC, queries DESC
   ```
   → 201: quota (2026-09-03). 159/160: timeout. 241: memory. 497: grant.
4. **Portal.**
   ```
   aws logs filter-log-events --profile soroban-readonly --region eu-central-1 --log-group-name /aws/lambda/prices-production-api-handler --start-time $((($(date +%s)-3600)*1000)) --filter-pattern '{ $.fields.message = "portal sources failed to load*" }' --query 'events[-5:].message' --output text
   ```
   → A single line: transient. A line on every load: configuration (`portal-oauth-deploy-prep.md`).
5. **Deploy?**
   ```
   aws lambda get-function-configuration --profile soroban-readonly --region eu-central-1 --function-name prices-production-api-handler --query '[LastModified,Version,CodeSha256,Timeout,MemorySize]' --output text
   ```

#### PR-INGEST
1. **Queue and processor metrics** (2 h).
   ```
   for m in 'AWS/SQS ApproximateAgeOfOldestMessage QueueName prices-ingest-production Maximum' 'AWS/SQS NumberOfMessagesReceived QueueName prices-ingest-production Sum' 'AWS/SQS ApproximateNumberOfMessagesVisible QueueName prices-ingest-dlq-production Maximum' 'AWS/Lambda Invocations FunctionName prices-production-ledger-processor Sum' 'AWS/Lambda Errors FunctionName prices-production-ledger-processor Sum' 'AWS/Lambda Throttles FunctionName prices-production-ledger-processor Sum' 'AWS/Lambda Duration FunctionName prices-production-ledger-processor Maximum'; do set -- ${=m}; printf '%s %s: ' $2 $4; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace $1 --metric-name $2 --dimensions Name=$3,Value=$4 --start-time $(($(date +%s)-7200)) --end-time $(date +%s) --period 900 --statistics $5 --query "sort_by(Datapoints,&Timestamp)[].$5" --output text; done
   ```
   → Errors: step 2. Duration around 60000: timeouts. Invocations around 0 with Received > 0: ESM (step 4). Received = 0: upstream (PD-1 freshness).
2. **Errors** (`/aws/lambda/prices-production-ledger-processor`).
   ```
   fields @timestamp, level, fields.message, fields.error
   | filter level = 'ERROR' or @message like /Task timed out|panicked|Runtime\./
   | stats count(*) as n, latest(fields.error) as last_error by fields.message
   | sort n desc | limit 20
   ```
   → TLS: mtls. 497/241/252/159: CH. XDR: protocol (`xdr-protocol-watch.md`).
3. **Stuck, slow or upstream?**
   ```sql
   SELECT c.ledger AS prices_cursor, c.updated_at AS cursor_updated_at, dateDiff('second', c.updated_at, now64(3)) AS cursor_age_s,
          (SELECT max(sequence) FROM default.ledgers WHERE closed_at > now() - INTERVAL 1 DAY) AS explorer_tip,
          (SELECT max(closed_at) FROM default.ledgers WHERE closed_at > now() - INTERVAL 1 DAY) AS explorer_tip_closed_at,
          explorer_tip - toInt64(prices_cursor) AS ledgers_behind,
          (SELECT max(timestamp) FROM prices.price_ohlcv_1m WHERE timestamp > now() - INTERVAL 1 DAY) AS newest_1m_candle
   FROM prices.ingest_cursor AS c FINAL WHERE c.id = 'ledger-processor'
   ```
4. **ESM and the function.**
   ```
   aws lambda list-event-source-mappings --profile soroban-readonly --region eu-central-1 --function-name prices-production-ledger-processor --query 'EventSourceMappings[].[State,StateTransitionReason,LastProcessingResult,BatchSize]' --output text; aws lambda get-function-configuration --profile soroban-readonly --region eu-central-1 --function-name prices-production-ledger-processor --query '[State,LastUpdateStatus,StateReasonCode,LastModified]' --output text; aws lambda get-function-concurrency --profile soroban-readonly --region eu-central-1 --function-name prices-production-ledger-processor
   ```
   → Disabled: broken trigger. Concurrency 0. Failed: deploy. Note: for SQS `LastProcessingResult` is None, so do not branch on it.

#### PR-WORKERS-FAILING
1. **Who is erroring and how close enrichment is to its timeout.**
   ```
   for f in supply asset-discovery enrichment coarse-sweep oracle mtls-notafter-probe rollup-freshness-probe backfill-freshness-probe coverage-sweep-probe; do printf '%-26s errors=' $f; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/Lambda --metric-name Errors --dimensions Name=FunctionName,Value=prices-production-$f --start-time $(($(date +%s)-7200)) --end-time $(date +%s) --period 900 --statistics Sum --query 'sum(Datapoints[].Sum)' --output text; done; printf 'enrichment max duration ms: '; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/Lambda --metric-name Duration --dimensions Name=FunctionName,Value=prices-production-enrichment --start-time $(($(date +%s)-7200)) --end-time $(date +%s) --period 900 --statistics Maximum --query 'max(Datapoints[].Maximum)' --output text
   ```
   → One worker: step 2. Several workers that use CH: step 3. Duration >= 240000 without errors: step 6.
2. **Messages** (T2, 3 h; log groups `/aws/lambda/prices-production-<f>` for each `f` with errors in step 1: `supply`, `asset-discovery`, `enrichment`, `coarse-sweep`, `oracle`, `mtls-notafter-probe`, `rollup-freshness-probe`, `backfill-freshness-probe`, `coverage-sweep-probe`).
   ```
   fields @timestamp, @log, level, fields.message, fields.error
   | filter level = 'ERROR' or level = 'WARN' or @message like /Task timed out|panicked|Runtime\.|table failed/
   | stats count(*) as n, latest(fields.error) as last_error by @log, fields.message
   | sort n desc | limit 30
   ```
3. **Common cause in CH.**
   ```sql
   SELECT event_time, user, exception_code, substring(exception, 1, 200) AS exception, substring(query, 1, 120) AS query
   FROM system.query_log WHERE event_time > now() - INTERVAL 2 HOUR AND type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')
   ORDER BY event_time DESC LIMIT 50
   ```
   → No exceptions with connection errors: connectivity or TLS before the query.
4. **Was the output produced anyway?**
   ```sql
   SELECT 'asset_supply' AS output, toString(max(fetched_at)) AS newest, toString(uniqExact(asset_id)) AS detail FROM prices.asset_supply
   UNION ALL
   SELECT 'oracle_prices(reflector)', toString(max(timestamp)), toString(countIf(timestamp > now() - INTERVAL 1 HOUR)) FROM prices.oracle_prices WHERE oracle_name = 'reflector' AND timestamp > now() - INTERVAL 2 DAY
   UNION ALL
   SELECT 'enrichment_frontier ' || toString(tbl) || '/' || toString(state), toString(max(swept_at)), toString(count()) FROM prices.enrichment_frontier FINAL GROUP BY tbl, state
   ```
5. **Unpriced candles** (30 h).
   ```sql
   SELECT '1m' AS tier, toStartOfHour(timestamp) AS hour, count() AS candles, countIf(close_usd = 0 AND trade_count > 0) AS unpriced FROM prices.price_ohlcv_1m WHERE timestamp > now() - INTERVAL 30 HOUR GROUP BY hour
   UNION ALL
   SELECT '1h', timestamp, count(), countIf(close_usd = 0 AND trade_count > 0) FROM prices.price_ohlcv_1h WHERE timestamp > now() - INTERVAL 30 HOUR GROUP BY timestamp
   ORDER BY tier, hour
   ```
   → Ignore the newest 1–2 h. A growing share in older hours: enrichment (1m) or coarse-sweep (1h) errors are reaching the API.
6. **Headroom to timeout** (REPORT, T2, 24 h; all 9 log groups `/aws/lambda/prices-production-<f>` from step 2 at once).
   ```
   filter @type = 'REPORT'
   | stats count(*) as runs, max(@duration) as max_ms, pct(@duration, 95) as p95_ms, max(@maxMemoryUsed / 1000000) as max_mem_mb by @log
   | sort max_ms desc
   ```
   → Timeouts: 300 s for asset-discovery, enrichment, coarse-sweep and supply; 120 s for oracle; 180 s for coverage-sweep; 60 s for the other probes. Supply around 240 s is the normal budget.
7. **Deploy?**
   ```
   aws lambda list-functions --profile soroban-readonly --region eu-central-1 --query "Functions[?starts_with(FunctionName,'prices-production-')].[LastModified,FunctionName]" --output text | sort -r | head
   ```

#### PR-PROBES-SILENT
1. **Invocations, TriggeredRules, FailedInvocations.**
   ```
   for r in rollup-freshness-probe backfill-freshness-probe; do printf '%-26s inv=' $r; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/Lambda --metric-name Invocations --dimensions Name=FunctionName,Value=prices-production-$r --start-time $(($(date +%s)-7200)) --end-time $(date +%s) --period 900 --statistics Sum --query 'sum(Datapoints[].Sum)' --output text | tr '\n' ' '; for m in TriggeredRules FailedInvocations; do printf '%s=' $m; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/Events --metric-name $m --dimensions Name=RuleName,Value=prices-production-$r --start-time $(($(date +%s)-7200)) --end-time $(date +%s) --period 900 --statistics Sum --query 'sum(Datapoints[].Sum)' --output text | tr '\n' ' '; done; echo; done
   ```
2. **Rules.**
   ```
   aws events list-rules --profile soroban-readonly --region eu-central-1 --name-prefix prices-production --query 'Rules[].[Name,State,ScheduleExpression]' --output text; for r in rollup-freshness-probe backfill-freshness-probe; do printf '%s -> ' $r; aws events list-targets-by-rule --profile soroban-readonly --region eu-central-1 --rule prices-production-$r --query 'Targets[].Arn' --output text; done
   ```
   → Only cleanup should be DISABLED.
   - Blind spot: `prices-production-backfill-reconcile` (weekly, same function) and `prices-production-coverage-sweep-probe` do not affect this alarm. A disabled reconcile rule does not lower backfill-freshness-probe Invocations. Their silence is caught by PD-1 `producer_silent` (`backfill-reconcile:run`, `coverage-sweep:run`, 7 d; D23).
3. **Function and concurrency.**
   ```
   for f in rollup-freshness-probe backfill-freshness-probe; do printf '%s ' $f; aws lambda get-function-configuration --profile soroban-readonly --region eu-central-1 --function-name prices-production-$f --query '[State,LastUpdateStatus,StateReasonCode,LastModified]' --output text | tr '\n' ' '; aws lambda get-function-concurrency --profile soroban-readonly --region eu-central-1 --function-name prices-production-$f --query ReservedConcurrentExecutions --output text; done
   ```
4. **Who changed it (CloudTrail, 48 h).**
   ```
   for e in DisableRule DeleteRule RemoveTargets PutRule PutFunctionConcurrency DeleteFunction; do aws cloudtrail lookup-events --profile soroban-readonly --region eu-central-1 --lookup-attributes AttributeKey=EventName,AttributeValue=$e --start-time $(($(date +%s)-172800)) --query "Events[?contains(to_string(Resources),'prices-production')].[EventTime,EventName,Username]" --output text; done
   ```
5. **Manual freshness when the probe is blind.**
   ```sql
   SELECT (SELECT max(timestamp) FROM prices.price_ohlcv_1m WHERE timestamp > now() - INTERVAL 1 DAY) AS newest_1m, dateDiff('minute', newest_1m, now()) AS age_1m_min, (SELECT max(timestamp) FROM prices.price_ohlcv_1h WHERE timestamp > now() - INTERVAL 3 DAY) AS newest_1h, (SELECT ledger FROM prices.ingest_cursor FINAL WHERE id = 'ledger-processor') AS prices_cursor
   ```

#### PR-WORKERS-SILENT
1. **Invocations, rules, functions.** For these 3 workers the EventBridge rule name = the function name (`prices-production-asset-discovery`, `-enrichment`, `-coarse-sweep`; checked with `list-targets-by-rule` 2026-11-16).
   ```
   for f in asset-discovery enrichment coarse-sweep; do n=prices-production-$f; printf '%-34s inv=' $n; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/Lambda --metric-name Invocations --dimensions Name=FunctionName,Value=$n --start-time $(($(date +%s)-10800)) --end-time $(date +%s) --period 3600 --statistics Sum --query 'sort_by(Datapoints,&Timestamp)[].Sum' --output text | tr '\n' ' '; for m in TriggeredRules FailedInvocations; do printf '%s=' $m; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/Events --metric-name $m --dimensions Name=RuleName,Value=$n --start-time $(($(date +%s)-10800)) --end-time $(date +%s) --period 3600 --statistics Sum --query 'sum(Datapoints[].Sum)' --output text | tr '\n' ' '; done; aws events describe-rule --profile soroban-readonly --region eu-central-1 --name $n --query '[State,ScheduleExpression]' --output text | tr '\n' ' '; aws lambda get-function-configuration --profile soroban-readonly --region eu-central-1 --function-name $n --query '[State,LastUpdateStatus,LastModified]' --output text | tr '\n' ' '; aws lambda get-function-concurrency --profile soroban-readonly --region eu-central-1 --function-name $n --query ReservedConcurrentExecutions --output text; done
   ```
   → TriggeredRules = 0: the rule (State, schedule). TriggeredRules > 0 and inv = 0: FailedInvocations, concurrency 0 or the function. Who changed it: PR-PROBES-SILENT step 4 (CloudTrail).
   - Note: oracle and supply have rules with different names (`prices-production-oracle-watcher` → `prices-production-oracle`, `prices-production-asset-supply` → `prices-production-supply`). They are not in this signal; their silence is PR-RUNTIME-OUTPUTS.
2. **User impact.**
   ```sql
   SELECT 'enrichment_frontier ' || toString(tbl) || '/' || toString(state) AS item, toString(max(swept_at)) AS newest, toString(count()) AS n FROM prices.enrichment_frontier FINAL GROUP BY tbl, state
   UNION ALL
   SELECT 'assets created last 24h', toString(max(created_at)), toString(countIf(created_at > now() - INTERVAL 24 HOUR)) FROM prices.assets
   ```

#### PR-RUNTIME-OUTPUTS
1. **The probe's SQL** (the same as in the trigger).
   ```sql
   SELECT check_name, newest, dateDiff('second', newest, now()) AS age_s, limit_s, toUInt8(age_s > limit_s) AS failing FROM (
     SELECT 'oracle_xlm' AS check_name, (SELECT max(timestamp) FROM prices.oracle_prices WHERE oracle_name = 'reflector' AND asset_id = xxh3('XLM::') AND timestamp > now() - INTERVAL 7 DAY) AS newest, 1800 AS limit_s
     UNION ALL SELECT 'oracle_usdc', (SELECT max(timestamp) FROM prices.oracle_prices WHERE oracle_name = 'reflector' AND asset_id = xxh3('USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN:') AND timestamp > now() - INTERVAL 7 DAY), 1800
     UNION ALL SELECT 'usd_rate_usdc', (SELECT max(timestamp) FROM prices.usd_rate WHERE asset_kind = 'credit' AND asset_code = 'USDC' AND issuer_address = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' AND contract_address = '' AND method = 'oracle' AND timestamp > now() - INTERVAL 7 DAY), 10800
     UNION ALL SELECT 'usd_rate_xlm', (SELECT max(timestamp) FROM prices.usd_rate WHERE asset_kind = 'native' AND asset_code = 'XLM' AND issuer_address = '' AND contract_address = '' AND method = 'oracle' AND timestamp > now() - INTERVAL 7 DAY), 3600
     UNION ALL SELECT 'supply', (SELECT max(fetched_at) FROM prices.asset_supply), 10800
   ) ORDER BY failing DESC, check_name
   ```
   → All 5 failing: common cause. Both oracle_*: the feed is down. One of them: a rejected symbol. usd_rate failing with a fresh oracle: snapshot (step 3). supply: step 5.
2. **Oracle per asset.**
   ```sql
   SELECT asset_id, multiIf(asset_id = xxh3('XLM::'), 'XLM', asset_id = xxh3('USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN:'), 'USDC', 'other') AS symbol,
          max(timestamp) AS newest, dateDiff('minute', newest, now()) AS age_min, countIf(timestamp > now() - INTERVAL 1 HOUR) AS rows_1h, argMax(price_usd, timestamp) AS last_price
   FROM prices.oracle_prices WHERE oracle_name = 'reflector' AND timestamp > now() - INTERVAL 2 DAY GROUP BY asset_id ORDER BY newest
   ```
   → About 12 rows per hour is healthy. 'other' in place of XLM/USDC means a wrong xxh3 literal in the probe.
3. **usd_rate.**
   ```sql
   -- version = unix sekundy (sprawdzone w kodzie): method 'oracle' pisze toUInt64(now()) w packages/prices-ingest-core/src/writer.rs:547,
   -- import zewnętrzny pisze SystemTime::now()...as_secs() w packages/enrichment-worker/src/bin/load-external-rate.rs:312-314.
   SELECT asset_kind, asset_code, issuer_address, method, max(timestamp) AS newest_obs, dateDiff('minute', newest_obs, now()) AS age_min, toDateTime(toUInt32(max(version))) AS last_written, count() AS rows_3d
   FROM prices.usd_rate
   WHERE ((asset_kind = 'credit' AND asset_code = 'USDC' AND issuer_address = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN') OR (asset_kind = 'native' AND asset_code = 'XLM' AND issuer_address = ''))
     AND contract_address = '' AND timestamp > now() - INTERVAL 3 DAY
   GROUP BY asset_kind, asset_code, issuer_address, method ORDER BY asset_code, method
   ```
   → Old `newest_obs` with a fresh oracle from step 2: the snapshot is not running or refuses to write (step 4, e.g. "refusing to write usd_rate"). `last_written` tells when the last successful snapshot was.
4. **Oracle logs** (`/aws/lambda/prices-production-oracle`, 2 h).
   ```
   fields @timestamp, level, fields.message, fields.set, fields.rows, fields.written, fields.timestamp_rejected, fields.symbol, fields.raw, fields.error
   | filter fields.message like /oracle-worker run complete|reflector timestamp rejected|usd_rate snapshot|rpc|error/ or level = 'ERROR'
   | stats count(*) as n, sum(fields.written) as written, sum(fields.timestamp_rejected) as rejected, latest(fields.raw) as last_raw, latest(fields.error) as last_error by fields.message, fields.set, fields.symbol
   | sort n desc
   ```
   → "timestamp rejected" with last_raw: a unit change (class 0227). Fix the parsing, do not widen the guard.
5. **Supply.**
   ```sql
   SELECT max(fetched_at) AS newest, dateDiff('minute', newest, now()) AS age_min, uniqExact(asset_id) AS assets_with_supply FROM prices.asset_supply
   ```
6. **User impact.**
   ```sql
   SELECT toStartOfHour(timestamp) AS hour, count() AS candles, countIf(close_usd = 0 AND trade_count > 0) AS unpriced FROM prices.price_ohlcv_1m WHERE timestamp > now() - INTERVAL 30 HOUR GROUP BY hour ORDER BY hour
   ```

#### alert-notifier-health and mtls-notafter (kept)
- **notifier:** steps as in PD-3, with the function `prices-production-alert-notifier` *(proposed)*.
- **mtls:**
  ```
  aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace Prices/Mtls --metric-name MinDaysToNotAfter --dimensions Name=Environment,Value=production --start-time $(($(date +%s)-259200)) --end-time $(date +%s) --period 86400 --statistics Minimum
  ```
  → Less than 30 days: renew. No datapoints: the probe is silent (steps 2–4 of PR-PROBES-SILENT with `mtls-notafter-probe`).

### 4.2 Explorer

Time variables (ISO-8601 UTC), set once before the runbook:
```
END=$(date -u +%FT%TZ)
START=$(date -u -d '-60 min' +%FT%TZ 2>/dev/null || date -u -v-60M +%FT%TZ)
START_24H=$(date -u -d '-24 hour' +%FT%TZ 2>/dev/null || date -u -v-24H +%FT%TZ)
START_7D=$(date -u -d '-7 day' +%FT%TZ 2>/dev/null || date -u -v-7d +%FT%TZ)
```
The metrics `SorobanBlockExplorer/Signal` (`Bits`, `NewBits`) and `SorobanBlockExplorer/Galexie` (`ReadinessFailing`) and the `*-explorer-signal-evaluator` Lambdas are *(proposed)*; steps 1–2 work only after they are deployed.

#### EXP-PROD-SIGNAL
1. **Always first: both alarms and the full Bits/NewBits series.**
   ```
   aws cloudwatch describe-alarms --profile soroban-readonly --region eu-central-1 --alarm-names production-explorer-signal production-explorer-new-cause --query 'MetricAlarms[].[AlarmName,StateValue,StateTransitionedTimestamp,StateReason]' --output text; for M in Bits NewBits; do echo $M; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace SorobanBlockExplorer/Signal --metric-name $M --dimensions Name=Environment,Value=production --start-time $START --end-time $END --period 60 --statistics Maximum --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Maximum]' --output text; done
   ```
   → Decode the bitmask. 2048 with Bits = 0: trust the raw lag. ALARM with no datapoints: the evaluator is dead (step 2).
2. **Always: evaluator health** (`/aws/lambda/production-explorer-signal-evaluator` *(proposed)*, 60 min).
   ```
   fields @timestamp, @message | filter @message like /ERROR|Task timed out|AccessDenied|Throttl|PartialData/ or @type = "REPORT" | stats count(*) as runs, sum(strcontains(@message, "ERROR")) as errors by bin(10m)
   ```
   → About 5 runs per 10 min with no errors: the bitmask is reliable.
3. **Always: CH and freshness of both networks.**
   ```sql
   SELECT 'production' AS env, max(sequence) AS newest_seq, max(closed_at) AS newest_closed_at, dateDiff('second', max(closed_at), now64(3, 'UTC')) AS lag_s FROM default.ledgers UNION ALL SELECT 'testnet', max(sequence), max(closed_at), dateDiff('second', max(closed_at), now64(3, 'UTC')) FROM testnet.ledgers
   ```
   → Query fails: CH or the host. Both networks stale: common cause on ch-prod-01. CH fresh with bit 1: lag is not being published, false page.
4. **Bits 1, 2, 4: ESM, ingest queue, ledger DLQ.**
   ```
   aws lambda list-event-source-mappings --profile soroban-readonly --region eu-central-1 --function-name production-soroban-explorer-indexer --query 'EventSourceMappings[].[State,LastProcessingResult,StateTransitionReason,LastModified]' --output table; for q in production-ledger-ingest production-ledger-processor-dlq; do aws sqs get-queue-attributes --profile soroban-readonly --region eu-central-1 --queue-url https://sqs.eu-central-1.amazonaws.com/750702271865/$q --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output text; done
   ```
   → Empty list: permanent pause (`indexerLambdaConcurrency 0`). Disabled: pause. DLQ: evidence only, the operator does the purge.
5. **Bits 1, 4: why the indexer fails** (T2, `/aws/lambda/production-soroban-explorer-indexer`, 2 h).
   ```
   fields @timestamp, fields.cause, fields.error | filter fields.alarm = "indexer_failure" | stats count(*) as n, earliest(@timestamp) as first, latest(@timestamp) as last by fields.cause | sort n desc
   -- potem: filter @message like /Task timed out|Runtime exited|Runtime.ExitError|panicked/ | stats count(*) as crashes by bin(5m)
   ```
6. **A ledger missing from S3?** (T2, `/aws/lambda/production-soroban-explorer-indexer`, 2 h).
   ```
   fields @timestamp, fields.next, fields.persisted, fields.message | filter fields.message like /no new contiguous ledger|reached gap|wrong folder|failed to publish indexer CW metrics/ | sort @timestamp desc | limit 30
   ```
7. **Bit 2: Galexie.**
   ```
   aws ecs describe-services --profile soroban-readonly --region eu-central-1 --cluster production-ingestion --services production-galexie-live --query 'services[0].{running:runningCount,desired:desiredCount,taskDef:taskDefinition,deployments:deployments[].[status,rolloutState,updatedAt],events:events[0:8].[createdAt,message]}'
   -- Logs Insights /ecs/production/galexie-live, 2 h: fields @timestamp, @message | filter @message like /(?i)error|fatal|panic|No space left|Starting Galexie|protocol|catchup/ | sort @timestamp desc | limit 50
   ```
   → Fargate host replacement: about 25 min, and bit 4 will remind you anyway. "No space left": disk deadlock. Protocol error: core is not keeping up with the vote.
8. **Bit 2 with healthy Galexie: newest S3 objects vs doorbells.** Keys are hex `u32::MAX - seq` (`crates/api/src/runtime_enrichment/stellar_archive/key.rs:17-22`), so the lexicographically first folder and first files are the newest.
   ```
   B=$(aws lambda get-function-configuration --profile soroban-readonly --region eu-central-1 --function-name production-soroban-explorer-indexer --query 'Environment.Variables.BUCKET_NAME' --output text); P=$(aws s3api list-objects-v2 --profile soroban-readonly --region eu-central-1 --bucket $B --delimiter / --max-items 1 --query 'CommonPrefixes[0].Prefix' --output text | head -1); aws s3api list-objects-v2 --profile soroban-readonly --region eu-central-1 --bucket $B --prefix "$P" --max-items 5 --query 'Contents[].[Key,LastModified]' --output text
   ```
   → Checked 2026-11-16 (`production-stellar-ledger-data`): the first row is the newest ledger, LastModified a few seconds old. Fresh objects with bit 2: the S3→SNS→SQS chain is broken. Old LastModified: Galexie is not writing (step 7).
9. **Bits 1, 16, 32: CH errors and disk.**
   ```sql
   SELECT user, exception_code, count() AS n, min(event_time) AS first, max(event_time) AS last, any(left(exception, 160)) AS sample FROM system.query_log WHERE event_date >= yesterday() AND event_time > now() - INTERVAL 2 HOUR AND exception_code != 0 GROUP BY user, exception_code ORDER BY n DESC LIMIT 20;
   SELECT name, formatReadableSize(free_space) AS free, round(100 * (1 - free_space / total_space), 1) AS used_pct FROM system.disks
   ```
10. **Bit 1, cause=parse: protocol.**
    ```sql
    SELECT protocol_version, min(sequence) AS from_seq, max(sequence) AS to_seq, max(closed_at) AS last_closed FROM default.ledgers WHERE sequence > (SELECT max(sequence) - 20000 FROM default.ledgers) GROUP BY protocol_version ORDER BY protocol_version;
    SELECT countIf(parse_error) AS parse_errors, count() AS txs FROM default.transactions WHERE ledger_sequence > (SELECT max(sequence) - 1000 FROM default.ledgers)
    ```
11. **Bit 8 / NewBits 64: DLQ.**
    ```
    for q in production-enrichment-dlq production-ledger-processor-dlq; do aws sqs get-queue-attributes --profile soroban-readonly --region eu-central-1 --queue-url https://sqs.eu-central-1.amazonaws.com/750702271865/$q --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible MessageRetentionPeriod --output text; done; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/SQS --metric-name ApproximateAgeOfOldestMessage --dimensions Name=QueueName,Value=production-enrichment-dlq --start-time $START --end-time $END --period 3600 --statistics Maximum
    ```
    → Age above 10 days: redrive or a deliberate drop before the 14-day retention (batch from 11-05, task 0671).
12. **Enrichment worker** (T2, `/aws/lambda/production-soroban-explorer-enrichment-worker`, 6 h).
    ```
    fields @timestamp, level, fields.reason, fields.key, fields.message | filter level in ["ERROR","WARN"] | stats count(*) as n by level, fields.reason, substr(fields.message, 0, 70) | sort n desc
    -- potem: filter @type = "REPORT" or @message like /Task timed out/ | stats sum(strcontains(@message, "Task timed out")) as timeouts, max(@maxMemoryUsed) as max_mem_bytes, max(@duration) as max_ms by bin(15m)
    ```
13. **Is the worker writing?**
    ```sql
    SELECT 'asset_enrichment' AS t, max(version) AS last_write, countIf(version > now() - INTERVAL 1 HOUR) AS rows_1h FROM default.asset_enrichment UNION ALL SELECT 'nft_enrichment', max(version), countIf(version > now() - INTERVAL 1 HOUR) FROM default.nft_enrichment
    ```
14. **Bit 32: API errors** (T2, `/aws/lambda/production-soroban-explorer-api`, 1 h).
    ```
    filter level = "ERROR" | stats count(*) as cnt by fields.message, fields.error | sort cnt desc
    ```
15. **Bit 32: 502/504 only at the gateway.**
    ```
    aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/ApiGateway --metric-name 5XXError --dimensions Name=ApiName,Value=production-soroban-explorer-api Name=Stage,Value=production --start-time $START --end-time $END --period 300 --statistics Sum; aws xray get-trace-summaries --profile soroban-readonly --region eu-central-1 --start-time $START --end-time $END --filter-expression 'fault = true' --query 'TraceSummaries[].[Id,Http.HttpURL,Http.HttpStatus,Duration]' --output table
    ```
    → X-Ray is a 5% sample. The difference is what counts: the gateway Sum minus the errors in the logs.
16. **After recovery: ledger continuity.**
    ```sql
    SELECT min(sequence) AS from_seq, max(sequence) AS to_seq, max(sequence) - min(sequence) + 1 - uniqExact(sequence) AS missing FROM default.ledgers WHERE closed_at >= parseDateTime64BestEffort('<INCIDENT_START>', 3, 'UTC')
    ```

#### EXP-TESTNET-SIGNAL
1. **Same as prod step 1**, with `testnet-explorer-signal`, `testnet-explorer-new-cause` and `Environment=testnet`. Also check whether production is firing at the same time: both at once point to ch-prod-01.
2. **Bit 1: our tip vs the network.**
   ```sql
   SELECT min(sequence) AS oldest, max(sequence) AS newest, max(closed_at) AS newest_closed_at, dateDiff('second', max(closed_at), now64(3, 'UTC')) AS lag_s FROM testnet.ledgers
   -- poza CH: curl -s https://horizon-testnet.stellar.org/ | jq '.history_latest_ledger, .core_latest_ledger, .current_protocol_version'
   ```
   → Network far below our tip: testnet reset (`testnet-reset.md`).
3. **Indexer and gaps in the lake** (T2, `/aws/lambda/testnet-soroban-explorer-indexer`, 2 h).
   ```
   fields @timestamp, fields.cause, fields.error, fields.next, fields.message | filter fields.alarm = "indexer_failure" or fields.message like /no new contiguous ledger|reached gap|wrong folder|could not queue the next wake-up|failed to publish/ | stats count(*) as n, latest(@timestamp) as last by fields.cause, substr(fields.message, 0, 60) | sort n desc
   ```
4. **ESM.**
   ```
   aws lambda list-event-source-mappings --profile soroban-readonly --region eu-central-1 --function-name testnet-soroban-explorer-indexer --query 'EventSourceMappings[].[State,LastProcessingResult,LastModified]' --output table; for q in testnet-ledger-ingest testnet-ledger-processor-dlq; do aws sqs get-queue-attributes --profile soroban-readonly --region eu-central-1 --queue-url https://sqs.eu-central-1.amazonaws.com/750702271865/$q --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output text; done
   ```
5. **Bit 128: runaway or catch-up?** (T2, `/aws/lambda/testnet-soroban-explorer-indexer`, 1 h).
   ```
   filter @type = "REPORT" | stats count(*) as invocations, max(@duration) as max_ms by bin(1m)
   -- i: aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/SQS --metric-name NumberOfMessagesSent --dimensions Name=QueueName,Value=testnet-ledger-ingest --start-time $START --end-time $END --period 60 --statistics Sum
   ```
   → Steadily above about 27 per minute for 30 min: runaway. Normal is 10–14 per minute.
6. **Enrichment and DLQ:** prod steps 11–13 with testnet names.
   ```sql
   SELECT max(version), countIf(version > now() - INTERVAL 1 HOUR) FROM testnet.asset_enrichment
   ```
7. **API errors:** prod step 14 on `/aws/lambda/testnet-soroban-explorer-api`, and step 15 with `ApiName testnet-soroban-explorer-api` and `Stage testnet`.

#### EXP-PROD-GALEXIE-READINESS
1. **Bitmask.**
   ```
   aws cloudwatch describe-alarms --profile soroban-readonly --region eu-central-1 --alarm-names production-galexie-readiness --query 'MetricAlarms[0].[StateValue,StateTransitionedTimestamp,StateReason]' --output text; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace SorobanBlockExplorer/Galexie --metric-name ReadinessFailing --start-time $START_24H --end-time $END --period 1800 --statistics Maximum --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Maximum]' --output text
   ```
   → Bits: 1 new core, 2 xdr, 4 disk, 8 cannot check, 16 memory. No data for 2 h: the watch is dead.
2. **Cause lines** (`/aws/lambda/production-galexie-protocol-watch`, 6 h).
   ```
   fields @timestamp, @message | filter @message like /NEW CORE|BUMP|cannot|could not|Task timed out|ERROR|ReadinessFailing|429/ | sort @timestamp desc | limit 20
   ```
3. **Has the network already voted?**
   ```sql
   SELECT protocol_version, min(sequence) AS from_seq, max(sequence) AS to_seq, max(closed_at) AS last_closed FROM default.ledgers WHERE sequence > (SELECT max(sequence) - 20000 FROM default.ledgers) GROUP BY protocol_version ORDER BY protocol_version
   -- curl -s https://horizon.stellar.org/ | jq '.current_protocol_version, .core_supported_protocol_version'
   ```
4. **Image, disk, memory, last restart.**
   ```
   TD=$(aws ecs describe-services --profile soroban-readonly --region eu-central-1 --cluster production-ingestion --services production-galexie-live --query 'services[0].taskDefinition' --output text); aws ecs describe-task-definition --profile soroban-readonly --region eu-central-1 --task-definition $TD --query 'taskDefinition.[containerDefinitions[].image,ephemeralStorage,memory]'; aws ecs describe-services --profile soroban-readonly --region eu-central-1 --cluster production-ingestion --services production-galexie-live --query 'services[0].events[0:6].[createdAt,message]' --output text
   ```
5. **Galexie disk.**
   - **Until the sidecar gate (today):** there is no sidecar line contract, and Container Insights stays. Read CI.
     ```
     for m in EphemeralStorageUtilized EphemeralStorageReserved; do echo "== $m"; aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace ECS/ContainerInsights --metric-name $m --dimensions Name=ClusterName,Value=production-ingestion Name=ServiceName,Value=production-galexie-live --start-time $START_24H --end-time $END --period 3600 --statistics Maximum --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Maximum]' --output text; done
     ```
     → Utilized/Reserved > 60%: bit 4 would fire. `production-galexie-ephemeral-storage` reads it the same way.
   - **After the sidecar gate:** T2 on `/ecs/production/galexie-live`, 24 h. The fields `galexie_disk.used_mib` and `galexie_disk.reserved_mib` must first be added to `declared-vs-emitted.spec.ts`.
     ```
     fields @timestamp, galexie_disk.used_mib, galexie_disk.reserved_mib | filter ispresent(galexie_disk.used_mib) | stats max(galexie_disk.used_mib * 100 / galexie_disk.reserved_mib) as used_pct, count(*) as lines by bin(1h)
     ```
6. **Memory trend.**
   ```
   aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace AWS/ECS --metric-name MemoryUtilization --dimensions Name=ClusterName,Value=production-ingestion Name=ServiceName,Value=production-galexie-live --start-time $START_7D --end-time $END --period 21600 --statistics Average Maximum
   ```

### 4.3 x402

**Network parameters.** Take the network from the alarm: the `network` label (on-host), the `network` field of the finding (x402-watch), or the name suffix (`-testnet` / `-pubnet`). An alarm shared across networks (CW1, CW2, CW3 without `network`): run the steps for each network in `WATCH_TARGETS`, pubnet first. The steps below use only these variables; no value is hardcoded.

| Variable | stellar:testnet | stellar:pubnet | Source |
|---|---|---|---|
| `${NET}` | `stellar:testnet` | `stellar:pubnet` | from the alarm (above) |
| `${DB}` | `testnet` | `default` | chain databases, `crates/db-clickhouse/schema/init.sql` |
| `${HORIZON}` | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` | deployed env `WATCH_PROTOCOL` of the `x402-production-watch` Lambda (from `watch.protocol.<net>.horizonUrl` in `infra/envs/production.json`) |
| `${FEE_ACCOUNT}` | `GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP` | none today (pubnet is not in `feeAccounts`) | deployed env `WATCH_TARGETS` of this Lambda, the same account that `balance-*` read (D26) |
| `${PG_SERVICE}` | `postgres-testnet` | `postgres-pubnet` *(proposed, name by analogy; not in `deploy/production/compose.yaml`)* | `deploy/production/compose.yaml` |
| `${CHANNELS_VAR}` | `CHANNELS_TESTNET` | `CHANNELS_PUBNET` *(proposed)* | `/srv/x402/production/.env` on ch-prod-01 |

```
NET=${NET:?z alarmu: stellar:testnet albo stellar:pubnet}
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
   → Nothing firing while CW1 is in ALARM: the cause is off the host (Cloudflare, tunnel). No access: P3 step 2 (logs) and `ONHOST_UNREADABLE`.

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
2. **agent_silent / deadman / audit_disk: is the host alive?**
   ```sql
   SELECT uptime() AS ch_uptime_s, now() AS server_now, version() AS ch_version
   ```
3. **agent_silent: Roles Anywhere, streams and the deployed certificate.** I read the certificate from what AWS saw at the last authentication, not from the copy in the repo.
   ```
   aws rolesanywhere list-subjects --query 'subjects[].[subjectId,x509Subject,lastSeenAt,enabled]' --output text --profile soroban-readonly --region eu-central-1; aws logs describe-log-streams --log-group-name /x402/production/app --order-by LastEventTime --descending --max-items 10 --query 'logStreams[].[logStreamName,lastEventTimestamp]' --output text --profile soroban-readonly --region eu-central-1
   SID=$(aws rolesanywhere list-subjects --profile soroban-readonly --region eu-central-1 --query "subjects[?x509Subject=='CN=x402-cloudwatch-agent-production'].subjectId | [0]" --output text); aws rolesanywhere get-subject --profile soroban-readonly --region eu-central-1 --subject-id $SID --query 'subject.credentials | sort_by(@,&seenAt)[-1].[seenAt,failed]' --output text; aws rolesanywhere get-subject --profile soroban-readonly --region eu-central-1 --subject-id $SID --query 'subject.credentials | sort_by(@,&seenAt)[-1].x509CertificateData' --output text | openssl x509 -noout -enddate -serial
   # przed 0139 także: aws cloudwatch get-metric-statistics --profile soroban-readonly --region eu-central-1 --namespace x402-host --metric-name certificate_days_left --start-time $(($(date +%s)-86400)) --end-time $(date +%s) --period 3600 --statistics Minimum
   ```
   → Checked 2026-11-16: `x509CertificateData` is PEM, last used every hour, notAfter 2027-11-05. `lastSeenAt` old: the agent is not authenticating (credentials helper, egress). `failed = True`: cert rejected. notAfter < 30 days: renew.
4. **monitoring_deadman: heartbeat on SNS.** The topic `x402-production-monitoring-heartbeat` is *(proposed)*; it is created in 0139.
   ```
   S=$(date -u -d '-2 hour' +%FT%TZ 2>/dev/null || date -u -v-2H +%FT%TZ); E=$(date -u +%FT%TZ); for m in NumberOfMessagesPublished NumberOfNotificationsFailed; do echo "== $m"; aws cloudwatch get-metric-statistics --namespace AWS/SNS --metric-name $m --dimensions Name=TopicName,Value=x402-production-monitoring-heartbeat --statistics Sum --period 300 --start-time $S --end-time $E --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text --profile soroban-readonly --region eu-central-1; done
   ```
   → While this finding lasts, P1–P3 are blind. HUMAN-ONLY on option A: `systemctl status prometheus alertmanager alloy`.
5. **audit_disk: who filled the disk.**
   ```sql
   SELECT name, formatReadableSize(free_space) AS free, formatReadableSize(total_space) AS total, round(100 * (1 - free_space / total_space), 1) AS used_pct FROM system.disks;
   SELECT database, formatReadableSize(sum(bytes_on_disk)) AS size, sum(bytes_on_disk) AS b FROM system.parts WHERE active GROUP BY database ORDER BY b DESC;
   ```
   → Growth in CH: the CH owners. CH flat: Postgres WAL, pgBackRest, logs, OpenBao, Docker or TSDB. Urgent, because signing stops at 90%.
6. **log_flood** (T2, 1 h, log group from the finding: `/x402/production/app` or `/x402/production/metrics`).
   ```
   stats count() as n, sum(strlen(@message)) as bytes by @logStream, event
   | sort bytes desc
   | limit 20
   ```
7. **protocol_changed.**
   ```sql
   SELECT 'stellar:testnet' AS network, argMax(protocol_version, sequence) AS protocol, max(sequence) AS ledger, max(closed_at) AS closed
   FROM testnet.ledgers WHERE sequence > (SELECT max(sequence) - 200 FROM testnet.ledgers)
   UNION ALL
   SELECT 'stellar:pubnet', argMax(protocol_version, sequence), max(sequence), max(closed_at)
   FROM default.ledgers WHERE sequence > (SELECT max(sequence) - 200 FROM default.ledgers)
   ```
   → Then P1 step 2. If the logs show no SDK errors, raise `watch.protocol.expected` and `supported` (this is a redeploy of the Watch stack).
8. **upstream** (T2, `/aws/lambda/x402-production-watch`, 72 h).
   ```
   fields @timestamp, msg, section, error, files
   | filter msg in ["watch_upstream","watch_section_failed"] and (section = "upstream" or msg = "watch_upstream")
   | sort @timestamp desc
   | limit 10
   ```

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
0. **Before 0139:** enter through T4 (alarm `x402-production-*-testnet` or `-pubnet` → cause from App. A.3; the suffix sets `${NET}`), then step 2.
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
   A=${FEE_ACCOUNT}; curl -s "${HORIZON}/accounts/$A/effects?order=desc&limit=50" | jq -r '._embedded.records[] | [.created_at,.type,(.amount // "")] | @tsv' | sort | uniq -c -f1 | sort -rn | head
   ```

#### P3 x402-runtime
0. **Before 0139:** enter through T4 (`disk-root`, `memory`, `facilitator-*`, `gauges-silent-*`, `probe-silent`, `credentials-stale`, `certificate`, `watchdog-restart`, `emf-*`), then step 2.
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
3. **Disk:** queries as in CW3 step 5.
4. **Memory: CH or us?**
   ```sql
   SELECT metric, formatReadableSize(value) AS v FROM system.asynchronous_metrics WHERE metric IN ('OSMemoryTotal', 'OSMemoryAvailable', 'MemoryResident')
   ```
   → Small CH resident: our containers (HUMAN-ONLY: `docker stats --no-stream; sudo journalctl -k | grep -i oom`).
5. **Credentials / certificate:** commands as in CW3 step 3 (`rolesanywhere list-subjects` and `openssl x509 -enddate`).
6. **HUMAN-ONLY: units.**
   ```
   systemctl list-units 'x402*' && systemctl status x402@production x402-host-probe.timer x402-watchdog@production.timer amazon-cloudwatch-agent --no-pager && sudo journalctl -u x402-watchdog@production -n 20 --no-pager
   ```

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
1. **All paging depends on new, untested code and metric-math semantics.**
   - Four different re-notify mechanisms are being built:
     - the Prices evaluator + the `prices.data_checks` table;
     - the `alert-notifier` Lambda;
     - explorer evaluators ×2;
     - the findings section in x402-watch.
   - Not checked: FILL on an empty series and on a period still being filled, DIFF at the start of the range, REPEAT, the 10-metric limit (PR-WORKERS-FAILING has exactly 10), delivery through Chatbot.
   - Mitigation: drills DR2–DR4 and a test of two simultaneous failures right after the switch (no shadow period, decided 2026-11-17); a signal that fails is fixed forward.
   - Convergence to one mechanism: decision D15 (§6).
2. **The agent cannot run triage yet.**
   - There is no operator ClickHouse user. Users are defined in XML and access storage is read-only, so `users.xml` must be edited in the ch-prod-01 base setup.
   - Grants needed: SELECT on `default.*`, `testnet.*`, `prices.*` and the `system.*` tables, including `query_log` and `view_refreshes`.
   - x402 steps that use Postgres and OpenBao are HUMAN-ONLY, because there is no read-only path.
   - All SQL is unverified.
   - One ch-prod-01 failure pages in three channels at once: PD-1, PR-*, both explorer signals, x402 P1/P3. There is no shared host signal to silence them.
3. **Approvals and evidence.**
   - Explorer ADR 0054 must be amended. Rule 2 forbids re-notify machinery, and the DIFF growth alarms were retired on 2026-08-11.
   - We reverse zero-tolerance for a self-healing indexer error (decision of 2026-08-18).
   - SCF milestone evidence and CI refer to alarms and series being removed:
     - M1 Table 3: `sdex-push-freshness`, `enrichment-backlog`;
     - M2: the `verify-dashboard-synth.mjs` gate;
     - M3: `RollupLagSeconds{current_prices}`, which is kept.
   - x402 P1–P3 require the 0139 cut-over and a chosen backend (A/B/C).

### 5.2 Unresolved skeptic objections (after the final version)

The "unsound" verdicts (explorer coverage, cross-cutting coverage) applied to the first versions, with blink and DIFF count. The final versions address them. What remains:

**Prices data:**
- The WARN `is_sac contract set unreadable` is probably logged once at cold start, so a 3-hour window will miss it. This needs a code change (not checked).
- Sequencing with 0242: the 0242 runbook relies on the `SacContractIdentities` alarm and metric (§4e, §5g, AC). So the series stays until 0242 closes (D6).
- The Logs Insights scan cost is not measured.
- Day-1 mutes are needed: 6 coverage emitters and pool `CDJJA3CJRZHMKKW4XRRRIT7GVIL4C4AMS4E2OJ7ZHUL5IUYBAOX7H4XZ`. Without them PD-1 is red from the first run.

**Prices runtime:**
- The new enrichment near-timeout already pages after 1 run instead of 2.
- PR-RUNTIME-OUTPUTS thresholds are first guesses.
- The xxh3 literals are unverified.
- A fully dark API (zero traffic) is undetected before and after the change (§2.3). Synthetic `/v1` probe: D13.

**Overlaps in Prices after merging:**
- A dead probe gives two pages: PD-1 `producer_silent` after 30 min and PR-PROBES-SILENT after 45 min.
- A DLQ wave gives three: PR-INGEST, `ledger-processor-dlq` and PD-4.
- Whether to silence `producer_silent` for 15-minute probes: D18.

**Explorer:**
- A stall shows after ~6–8 min instead of ~4–5.
- The disk warning arrives after 1–2 h instead of 15 min.
- A second new cause in the same 5-min period does not give a second page.
- Docker Hub limits at 48 runs per day (not checked).
- The SNS → Chatbot chain has no witness; with 5 alarms its failure silences everything.

**x402:**
- Broader IAM for the watch Lambda (GetMetricData, SSM, SNS); the plan calls it "the central design choice". Alternative: a separate small Lambda. Decision D19.
- A breaker counted just before a crash is lost. Not checked whether the spend store persists breakers.
- SNS credentials (heartbeat and phone) for the on-host stack in options A, B and C: D12.
- Re-baseline the memory threshold for node_exporter.

**Cross-cutting, still valid:**
- Feed loss by a single consumer (broken Prices SNS subscription). In this plan PD-1 `freshness:price_ohlcv_1m` catches it, but only after ≤20 min.
- `production-galexie-readiness` with the Prices and x402 topics: accepted in §2.6 (D17), no longer open.

### 5.3 Data not in ClickHouse
- **x402:** state of settlements, hashes, the spend store and breakers (Postgres, ADR 0011), OpenBao status, `CHANNELS_TESTNET` configuration.
- **Explorer:** not checked whether the testnet index covers settlements since genesis 2025-12-18, or whether the fee source of a fee-bump lands in `transaction_participants`.
- **AWS:** DLQ contents (SQS only), Lambda, Galexie and APIGW logs (CloudWatch Logs), certificate age (Secrets Manager / host), host disk outside CH, Prices verdict and mutes (SSM).

### 5.4 Questions for you (one at a time, in order)
1. D11: what mechanism is behind the phone route (SNS SMS or a pager provider), and who is on call? Without it D1–D3 have nowhere to go.
2. D15: one re-notify mechanism for everything (a Lambda evaluator with state in SSM) or four local ones?
3. D20: should SIG-06 (ch-prod-01 disk, memory and silence) be one platform signal, and who owns it?

---

## 6. Decisions to make

Each one is a design choice. I entered the safest option consistent with ADR 0011 and marked it as the default.

| # | Decision | Default (in this report) | Alternative |
|---|---|---|---|
| D1 | P1 causes guarding money on pubnet: `sweeps_stopped`, `check_error{check=pending}`, `landed_after_expired`, `commit_unmatched` | phone + Slack (separate route, same P1 rule) | Slack only, as in the x402 plan |
| D2 | P3 causes for which P2 is blind: `facilitator_unscraped`, `selfcheck_stalled`, `series_missing` | phone + Slack on pubnet (matcher: D16) | Slack only |
| D3 | CW3 `agent_silent` (then `audit_disk` cannot see the disk) | pager-class, phone on pubnet | Slack only, as in the plan |
| D4 | CW1 `uptime` and P1 cause `openbao` | Slack (they are not money in the ADR 0011 sense) | phone on pubnet |
| D5 | PR-RUNTIME-OUTPUTS into PD-1 as fixed checks | separate signal (13 Prices alarms) | merge: −1 alarm, −1 series, one evaluator |
| D6 | `SacContractIdentities` | stays until 0242 closes, then check `sac_contract_identities` in PD-1 | disable at once and rewrite the 0242 runbook onto `prices.data_checks` |
| D7 | 7 series from the CI gate `verify-dashboard-synth.mjs` (M2) | dropped only after M2 acceptance is confirmed | kept permanently (Prices runtime: 3 → 10 series) |
| D8 | Channel list for the agent | HUMAN-ONLY read of `/srv/x402/production/.env` | public addresses in SSM (e.g. `/x402/production/channels-testnet`), readable by the agent |
| D9 | `prices.data_checks` | proposed table, out-of-band migration like init.sql | add to `packages/prices-clickhouse/schema/init.sql` |
| D10 | `x402-production-emf-parsing`, `emf-validation` | retire together with the log group `/x402/production/metrics` in 0139 | keep until the first P3 `series_missing` drill |
| D11 | x402 phone route (does not exist today) | One new SNS topic `x402-production-phone` as the contract for CW, x402-watch and Alertmanager. Behind it, SNS SMS to at least 2 numbers with on-call rotation; numbers only in subscriptions, not in the repo. Pubnet does not start without a test SMS received by a human. Checked 2026-11-16: `MonthlySpendLimit` = 1 ($1/month), `IsInSandbox` = true; handled in D25 | A pager provider (e.g. PagerDuty, Opsgenie) through an HTTPS subscription to this topic: acknowledgements and escalation, but a new vendor |
| D12 | SNS credentials for the on-host stack (heartbeat, phone, Slack) | A: the ch-prod-01 Roles Anywhere chain, permission only `sns:Publish` on 3 topics. B: the VPS's own Roles Anywhere cert. C: assume-role. No static keys | a static key limited to `sns:Publish` (B, C) |
| D13 | Prices API fully dark (PR-SERVE cannot see it) | Synthetic `/v1` probe in an external uptime-probe, outside ch-prod-01, as a PR-SERVE cause | accept the gap, as in task 0223 |
| D14 | PromQL/Alertmanager read by the agent (T3) | HUMAN-ONLY until 0139 provides a read-only endpoint off the host; the agent starts from the `/x402/production/app` logs | read-only token (C) or the Alertmanager API behind a tunnel with auth (A/B) |
| D15 | Four re-notify mechanisms (§2.2) | Four local ones, as in the plans; we assess convergence after the first month | One Lambda evaluator with state in SSM for all areas |
| D16 | D2 route matcher for `facilitator_unscraped` and `selfcheck_stalled` (no `network` label) | Route on `alertname` + `cause` only, enabled together with `stellar:pubnet` in `config.networks`; testnet outages also call | Add a `network` label to these causes (one instance per network) and match `network="stellar:pubnet"` |
| D17 | `production-galexie-readiness`: extra topics | Yes: AlarmActions also to `prices-production-ops-alarms` and `x402-production-alarms` | explorer topic only |
| D18 | Double page on a dead probe (PD-1 `producer_silent` + PR-PROBES-SILENT) | Do not silence: silence = failure takes priority over noise | Disable `producer_silent` for the rollup- and backfill-freshness-probe |
| D19 | Watch Lambda IAM (GetMetricData, SSM, SNS to Slack and phone) | As in the plan: extend the `x402-production-watch` role, scoped to one SSM parameter and two topics; CW2 guards silence | A separate small Lambda on the same schedule (smaller IAM reach, but a new producer without a dead-man) |
| D20 | SIG-06: shared ch-prod-01 host signal | No shared signal; each area keeps its own (PD-1 disk, explorer bits, P3 and CW3 `audit_disk`) | One platform signal owned by the ch-prod-01 base setup owner, silencing pages in three channels |
| D21 | CW4 `watch-security` (account_state, account_effects, backup_secret_read) is disabled until decision 68, and the pubnet gate required only a test SMS | Pubnet does not start until CW4 is enabled with AlarmActions to `x402-production-phone` and one test finding has reached the phone. Applies to both D22 options | Pubnet start with CW4 disabled; theft and backup secret reads (ADR 0013) are visible only in CW2/P2 triage |
| D22 | Pubnet before 0139, on `-pubnet` copies of the old CW alarms (§3.3, ~26 alarms) | Pubnet waits for 0139: only then does on-host P2 run with the full silence clause (`monitoring_deadman` in CW3) | Start before 0139 on `-pubnet` copies with the routes from §3.3 "Before 0139" (phone for P2, balance, D1, D2, CW2, `audit-disk`, `telemetry-silent`); without `monitoring_deadman`, P2 silence is seen only by `facilitator-silent-pubnet` and `gauges-silent-pubnet` |
| D23 | Silence of weekly producers: the `prices-production-backfill-reconcile` rule (`cron(47 5 ? * MON *)`, invokes `prices-production-backfill-freshness-probe` with `{"check":"reconcile"}`, source `backfill_overclaim`) and `prices-production-coverage-sweep-probe`. PR-PROBES-SILENT counts Invocations of functions that the 15-min run keeps alive, so a disabled reconcile rule is invisible | Mandatory heartbeats `backfill-reconcile:run` and `coverage-sweep:run` in `prices.data_checks`, cadence 7 d, on the `producer_silent` list in PD-1 step 2 | No heartbeat; a disabled rule is seen only manually (PR-PROBES-SILENT step 2) |
| D24 | CW2 `watch-blind` latches across networks and sections: `runBalance` throws on every failed network, and `balance-*` have TreatMissingData ignore. CW2 in ALARM due to flaky testnet RPC hides a later failure of a pubnet section | A failed section does not throw. The Lambda publishes a per-network finding `section_failed{section,network}` (same SSM state and self-post as CW3), pubnet to `x402-production-phone`. CW2 catches only missing runs or a crash of the whole Lambda. Change in `infra/src/watch/balance.ts` (and the findings/security sections) and in `docs/monitoring.md`. No new alarm or series. Pubnet gate | A separate CW2 per network (e.g. series `section_ok{network}`, TreatMissingData breaching): +1 alarm and +1 series per network, no change to findings semantics |
| D25 | Silent delivery failure on the phone route: default SMS limit $1/month, sandbox, SMS test only once at the pubnet gate. Once the limit is used up, SMS messages do not arrive and nothing sees it | 2 alarms to Slack (`x402-production-alarms`): `x402-production-phone-delivery-failed` (`NumberOfNotificationsFailed` >= 1, `TopicName=x402-production-phone`) and `x402-production-sms-spend` (`SMSMonthToDateSpentUSD` >= 80% of the limit). Before pubnet: limit raised, account out of sandbox, SMS delivery status logging enabled. Weekly SMS drill with confirmation on Slack. Whether a used-up limit counts in `NumberOfNotificationsFailed`: not checked, hence the second alarm. +2 pubnet alarms (§1.1), runbook `phone-delivery` | Drill only, no alarms; or a pager provider (D11), which reports failed delivery itself |
| D26 | Where runbooks get the pubnet fee account (and Horizon). Today `feeAccounts` has only testnet | The deployed env `WATCH_TARGETS` / `WATCH_PROTOCOL` of the `x402-production-watch` Lambda (`lambda get-function-configuration`, read-only), i.e. exactly the account that `balance-*` read. Empty result = `FEE_ACCOUNT_UNKNOWN`, no guessing (§4.3, parameter table) | A public address in SSM (e.g. `/x402/production/fee-account-pubnet`), like the channel list in D8 |
| D27 | CI gate `verify-dashboard-synth.mjs` (Prices): `MIN_ALARMS = 49` ("alarms were removed, which is a decision") and a requirement of at least one imported `prices-<env>-<worker>-errors` in the dashboard. After the change Prices has 13 alarms, and all `-errors` go to PR-WORKERS-FAILING or to drop, so the gate will fail | Consistent with D7: old Prices alarms stay until M2 acceptance is confirmed; then, in the same change, explicitly lower `MIN_ALARMS` and replace the import assertion with the PR-WORKERS-FAILING alarm. Until then the "before M2" numbers in §1.1 and §1.2 include the old Prices alarms | Change the gate at once, together with removing the alarms |
| D28 | SCF deliverables tied to Prices alarms: `sdex-push-freshness` (Tranche-1 AC #5, in code), `current-prices-freshness` in `docs/scf/milestone-3-monitoring/report.py:18`, the dashboard alarm strip ("current state of every alarm", Tranche 3 AC 8) shrinks from 87 tiles | `sdex-push-freshness` and `current-prices-freshness` stay as separate alarms on kept metrics (alarm cost, no new series) until someone confirms that folding them into PD-1 does not reopen an accepted AC. The dashboard strip shows signals, and the change is noted in the AC 8 description | Fold into PD-1 at once and update the SCF evidence |
| D29 | Runbook 0242 §6 (l. 798–809) deploys three alarms as AC: `sac-unproven`, `sac-candidates-unavailable`, `sac-contract-identities` with actions enabled. App. A maps them to PD-1, and §1.1 counts the 0242 window without them | Rewrite 0242 §6 onto PD-1 causes (`check_id` `sac_*`) before it is executed; the `SacUnprovenSkipped` / `SacCandidatesUnavailable` series are not created, `SacContractIdentities` stays until 0242 closes (D6) | 0242 deploys them as written: +3 alarms and +2 series until 0242 closes |
| D30 | The pubnet gate did not require x402-watch to read pubnet at all. Today `WATCH_TARGETS` (`feeAccounts`) has only testnet; `balance-*-pubnet` have TreatMissingData ignore, and the Lambda without a pubnet target does not throw | Gate (§3.3): `stellar:pubnet` in `feeAccounts`/`WATCH_TARGETS` and at least one datapoint `spendable_stroops{network=stellar:pubnet}` before start | `balance-*-pubnet` with TreatMissingData breaching (silence = alarm) |

---

## Appendix A: alarm mapping

All 155 alarms from the 2026-11-16 inventory, each exactly once (source: the final area plans). The "Fate" column: signal id, `keep` or `drop`.

### A.1 Prices API (87)

| Alarm | Area | Fate | Cause / check_id |
|---|---|---|---|
| `prices-production-amm-push-freshness` | prices-data | PD-1 | backfill_push_stale:soroban_amm |
| `prices-production-asset-id-collisions-10000` | prices-data | PD-1 | asset_id_collisions@10000 |
| `prices-production-asset-id-collisions-100` | prices-data | PD-1 | asset_id_collisions@100 |
| `prices-production-asset-id-collisions-1` | prices-data | PD-1 | asset_id_collisions@1 |
| `prices-production-asset-id-orphan-candles-10000` | prices-data | PD-1 | asset_id_orphans@10000 |
| `prices-production-asset-id-orphan-candles-100` | prices-data | PD-1 | asset_id_orphans@100 |
| `prices-production-asset-id-orphan-candles-1` | prices-data | PD-1 | asset_id_orphans@1 |
| `prices-production-backfill-earliest-overclaim-amm` | prices-data | PD-1 | backfill_overclaim:soroban_amm |
| `prices-production-backfill-earliest-overclaim-sdex` | prices-data | PD-1 | backfill_overclaim:sdex_archive |
| `prices-production-ch-disk-free` | prices-data | PD-1 | disk_free_pct |
| `prices-production-coverage-sweep-unclassified` | prices-data | PD-1 | coverage_unclassified (+ :<contract>) |
| `prices-production-current-prices-freshness` | prices-data | PD-1 | freshness:current_prices |
| `prices-production-enrichment-backlog` | prices-data | PD-1 | enrichment_pass |
| `prices-production-ledger-processor-forced-partial-flush` | prices-data | PD-1 | ingest_drop:forced_partial_flush |
| `prices-production-ledger-processor-trades-missing-decimals` | prices-data | PD-1 | ingest_drop:missing_decimals:<contract> |
| `prices-production-ledger-processor-unregistered-pool` | prices-data | PD-1 | ingest_drop:unregistered_pool:<contract> |
| `prices-production-mv-drift-unreadable` | prices-data | PD-1 | mv_drift (not_run) |
| `prices-production-mv-drift` | prices-data | PD-1 | mv_drift |
| `prices-production-mv-refresh-disabled` | prices-data | PD-1 | mv_refresh:disabled |
| `prices-production-mv-refresh-failing` | prices-data | PD-1 | mv_refresh:failing |
| `prices-production-mv-refresh-unreadable` | prices-data | PD-1 | mv_refresh:* (not_run) |
| `prices-production-mv-refresh-waiting` | prices-data | PD-1 | mv_refresh:waiting |
| `prices-production-ohlc-band-10000` | prices-data | PD-1 | ohlc_band@10000 |
| `prices-production-ohlc-band-100` | prices-data | PD-1 | ohlc_band@100 |
| `prices-production-ohlc-band-1` | prices-data | PD-1 | ohlc_band@1 |
| `prices-production-rollup-freshness-15m` | prices-data | PD-1 | freshness:price_ohlcv_15m |
| `prices-production-rollup-freshness-1M` | prices-data | PD-1 | freshness:price_ohlcv_1M |
| `prices-production-rollup-freshness-1d` | prices-data | PD-1 | freshness:price_ohlcv_1d |
| `prices-production-rollup-freshness-1h` | prices-data | PD-1 | freshness:price_ohlcv_1h |
| `prices-production-rollup-freshness-1m` | prices-data | PD-1 | freshness:price_ohlcv_1m |
| `prices-production-rollup-freshness-1w` | prices-data | PD-1 | freshness:price_ohlcv_1w |
| `prices-production-rollup-freshness-4h` | prices-data | PD-1 | freshness:price_ohlcv_4h |
| `prices-production-rollup-mismatch-15m` | prices-data | PD-1 | mismatch:price_ohlcv_15m |
| `prices-production-rollup-mismatch-1M` | prices-data | PD-1 | mismatch:price_ohlcv_1M |
| `prices-production-rollup-mismatch-1d` | prices-data | PD-1 | mismatch:price_ohlcv_1d |
| `prices-production-rollup-mismatch-1h` | prices-data | PD-1 | mismatch:price_ohlcv_1h |
| `prices-production-rollup-mismatch-1w` | prices-data | PD-1 | mismatch:price_ohlcv_1w |
| `prices-production-rollup-mismatch-4h` | prices-data | PD-1 | mismatch:price_ohlcv_4h |
| `prices-production-sdex-push-freshness` | prices-data | PD-1 | backfill_push_stale:sdex_archive |
| `prices-production-usd-peg-applied-10000` | prices-data | PD-1 | usd_peg_applied@10000 |
| `prices-production-usd-peg-applied-100` | prices-data | PD-1 | usd_peg_applied@100 |
| `prices-production-usd-peg-applied-1` | prices-data | PD-1 | usd_peg_applied@1 |
| `prices-production-usd-stranded-10000` | prices-data | PD-1 | usd_stranded@10000 |
| `prices-production-usd-stranded-100` | prices-data | PD-1 | usd_stranded@100 |
| `prices-production-usd-stranded-1` | prices-data | PD-1 | usd_stranded@1 |
| `prices-production-zero-invariant-10000` | prices-data | PD-1 | zero_invariant@10000 |
| `prices-production-zero-invariant-100` | prices-data | PD-1 | zero_invariant@100 |
| `prices-production-zero-invariant-1` | prices-data | PD-1 | zero_invariant@1 |
| `prices-production-mv-drift-critical` | prices-data | PD-2 | mv_drift_critical (severity=critical) |
| `prices-production-ledger-processor-dlq-10` | prices-data | PD-4 | DLQ growth (depth in triage) |
| `prices-production-ledger-processor-dlq-50` | prices-data | PD-4 | DLQ growth (depth in triage) |
| `prices-production-api-5xx` | prices-runtime | PR-SERVE | APIGW 5XXError |
| `prices-production-api-handler-errors` | prices-runtime | PR-SERVE | handler Errors |
| `prices-production-api-handler-portal-load-failed` | prices-runtime | PR-SERVE | PortalSourcesLoadFailed |
| `prices-production-ledger-processor-errors` | prices-runtime | PR-INGEST | processor Errors |
| `prices-production-ledger-processor-lag` | prices-runtime | PR-INGEST | oldest message age > 120 s |
| `prices-production-asset-discovery-errors` | prices-runtime | PR-WORKERS-FAILING | Errors asset-discovery |
| `prices-production-backfill-freshness-probe-errors` | prices-runtime | PR-WORKERS-FAILING | Errors backfill-freshness-probe |
| `prices-production-coarse-sweep-errors` | prices-runtime | PR-WORKERS-FAILING | Errors coarse-sweep |
| `prices-production-coverage-sweep-probe-errors` | prices-runtime | PR-WORKERS-FAILING | Errors coverage-sweep-probe |
| `prices-production-enrichment-duration-near-timeout` | prices-runtime | PR-WORKERS-FAILING | Max Duration enrichment >= 240 s |
| `prices-production-enrichment-errors` | prices-runtime | PR-WORKERS-FAILING | Errors enrichment |
| `prices-production-mtls-notafter-probe-errors` | prices-runtime | PR-WORKERS-FAILING | Errors mtls-notafter-probe |
| `prices-production-oracle-errors` | prices-runtime | PR-WORKERS-FAILING | Errors oracle |
| `prices-production-rollup-freshness-probe-errors` | prices-runtime | PR-WORKERS-FAILING | Errors rollup-freshness-probe |
| `prices-production-supply-errors` | prices-runtime | PR-WORKERS-FAILING | Errors supply |
| `prices-production-backfill-freshness-probe-no-invocations` | prices-runtime | PR-PROBES-SILENT | backfill-freshness-probe |
| `prices-production-rollup-freshness-probe-no-invocations` | prices-runtime | PR-PROBES-SILENT | rollup-freshness-probe |
| `prices-production-asset-discovery-no-invocations` | prices-runtime | PR-WORKERS-SILENT | asset-discovery |
| `prices-production-coarse-sweep-no-invocations` | prices-runtime | PR-WORKERS-SILENT | coarse-sweep |
| `prices-production-enrichment-no-invocations` | prices-runtime | PR-WORKERS-SILENT | enrichment |
| `prices-production-oracle-dark-feed` | prices-runtime | PR-RUNTIME-OUTPUTS | oracle_xlm, oracle_usdc |
| `prices-production-oracle-no-invocations` | prices-runtime | PR-RUNTIME-OUTPUTS | oracle_*, usd_rate_* (stale output) |
| `prices-production-oracle-timestamp-rejected` | prices-runtime | PR-RUNTIME-OUTPUTS | oracle_* (rejected readings = stale rows) |
| `prices-production-oracle-usdc-snapshot-stalled` | prices-runtime | PR-RUNTIME-OUTPUTS | usd_rate_usdc |
| `prices-production-supply-no-invocations` | prices-runtime | PR-RUNTIME-OUTPUTS | supply (stale output) |
| `prices-production-ledger-processor-dlq` | prices-data | keep | kept: native SQS >= 1, works without CH |
| `prices-production-mtls-notafter` | prices-runtime | keep | kept: TMD → breaching, 2 of 2 days |
| `prices-production-asset-discovery-duration-near-timeout` | prices-runtime | drop | drop: timeout = Error (PR-WORKERS-FAILING), trend in the headroom line |
| `prices-production-backfill-freshness-probe-duration-near-timeout` | prices-runtime | drop | drop: timeout = Error (PR-WORKERS-FAILING), trend in the headroom line |
| `prices-production-cleanup-errors` | prices-runtime | drop | drop: rule DISABLED |
| `prices-production-coarse-sweep-duration-near-timeout` | prices-runtime | drop | drop: timeout = Error (PR-WORKERS-FAILING), trend in the headroom line |
| `prices-production-ledger-processor-no-invocations` | prices-runtime | drop | drop: covered by PD-1 freshness:price_ohlcv_1m + producer_silent + PD-3 |
| `prices-production-mtls-notafter-probe-duration-near-timeout` | prices-runtime | drop | drop: timeout = Error (PR-WORKERS-FAILING), trend in the headroom line |
| `prices-production-mtls-notafter-probe-no-invocations` | prices-runtime | drop | drop: covered by mtls-notafter (breaching) |
| `prices-production-oracle-duration-near-timeout` | prices-runtime | drop | drop: timeout = Error (PR-WORKERS-FAILING), trend in the headroom line |
| `prices-production-rollup-freshness-probe-duration-near-timeout` | prices-runtime | drop | drop: timeout = Error (PR-WORKERS-FAILING), trend in the headroom line |

### A.2 Explorer (19)

| Alarm | Area | Fate | Cause / check_id |
|---|---|---|---|
| `production-api-gateway-5xx` | explorer | EXP-PROD-SIGNAL | bit 32 API_5XX |
| `production-enrichment-dlq-depth` | explorer | EXP-PROD-SIGNAL | NewBits 64 + bit 8 |
| `production-enrichment-worker-error-rate` | explorer | EXP-PROD-SIGNAL | bit 16 WORKER_ERRORS |
| `production-galexie-ingestion-lag` | explorer | EXP-PROD-SIGNAL | bit 2 GALEXIE_SILENT |
| `production-indexer-failures` | explorer | EXP-PROD-SIGNAL | bit 1 (persistent error); a single self-healing one: no page |
| `production-ingestion-backlog-age` | explorer | EXP-PROD-SIGNAL | bit 1 INDEXER_BEHIND (and 4) |
| `production-ledger-processor-dlq-depth` | explorer | EXP-PROD-SIGNAL | bit 8 DLQ_EXPIRING |
| `production-ledger-processor-error-rate` | explorer | EXP-PROD-SIGNAL | bit 1 (indexer crash loop) |
| `testnet-api-gateway-5xx` | explorer | EXP-TESTNET-SIGNAL | bit 32 |
| `testnet-enrichment-dlq-depth` | explorer | EXP-TESTNET-SIGNAL | NewBits 64 + bit 8 |
| `testnet-enrichment-worker-error-rate` | explorer | EXP-TESTNET-SIGNAL | bit 16 |
| `testnet-indexer-failures` | explorer | EXP-TESTNET-SIGNAL | bit 1 (persistent error) |
| `testnet-indexer-runaway-wakeups` | explorer | EXP-TESTNET-SIGNAL | bit 128 RUNAWAY_WAKEUPS |
| `testnet-ingestion-backlog-age` | explorer | EXP-TESTNET-SIGNAL | bit 1 |
| `testnet-ingestion-stall` | explorer | EXP-TESTNET-SIGNAL | bit 1 INDEXER_BEHIND |
| `testnet-ledger-processor-dlq-depth` | explorer | EXP-TESTNET-SIGNAL | bit 8 |
| `testnet-ledger-processor-error-rate` | explorer | EXP-TESTNET-SIGNAL | bit 1 |
| `production-galexie-ephemeral-storage` | explorer | EXP-PROD-GALEXIE-READINESS | bit 4 DISK (only after the sidecar gate) |
| `production-galexie-protocol-watch` | explorer | EXP-PROD-GALEXIE-READINESS | bits 1 NEW_CORE, 2 XDR_BUMP, 8 CANNOT_CHECK |

### A.3 x402 (49)

| Alarm | Area | Fate | Cause / check_id |
|---|---|---|---|
| `x402-production-uptime` | x402 | CW1 | not serving 7 min |
| `x402-production-watch-errors` | x402 | CW2 | watch Lambda Errors |
| `x402-production-watch-no-invocations` | x402 | CW2 | Invocations < 1 |
| `x402-production-audit-disk` | x402 | CW3 | audit_disk (pager-class) |
| `x402-production-log-volume-app` | x402 | CW3 | log_flood{/x402/production/app} |
| `x402-production-log-volume-metrics` | x402 | CW3 | log_flood{/x402/production/metrics} (until 0139) |
| `x402-production-protocol-changed-pubnet` | x402 | CW3 | protocol_changed{pubnet} |
| `x402-production-protocol-changed-testnet` | x402 | CW3 | protocol_changed{testnet} |
| `x402-production-protocol-upgrade-coming-pubnet` | x402 | CW3 | protocol_upgrade_coming{pubnet} |
| `x402-production-protocol-upgrade-coming-testnet` | x402 | CW3 | protocol_upgrade_coming{testnet} |
| `x402-production-telemetry-silent` | x402 | CW3 | agent_silent |
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
| `x402-production-certificate` | x402 | P3 | certificate |
| `x402-production-credentials-stale` | x402 | P3 | credentials |
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

Develop-only (defined on origin/develop, not in the inventory, not counted in the 155):

| Alarm | Where on develop | Fate |
|---|---|---|
| `prices-production-sac-contract-identities` | stellar-prices-api | PD-1 `sac_contract_identities` |
| `prices-production-ledger-processor-sac-unproven` | stellar-prices-api | PD-1 `ingest_drop:sac_unproven:<contract>` |
| `prices-production-ledger-processor-sac-candidates-unavailable` | stellar-prices-api | PD-1 `ingest_degraded:sac_candidates_unavailable` |
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

Checksum: 155 alarms. PD-1 48, P1 19, P3 11, PR-WORKERS-FAILING 10, drop 9, EXP-TESTNET-SIGNAL 9, EXP-PROD-SIGNAL 8, CW3 8, keep 5, PR-RUNTIME-OUTPUTS 5, P2 5, PR-SERVE 3, PR-WORKERS-SILENT 3, PR-PROBES-SILENT 2, PD-4 2, PR-INGEST 2, EXP-PROD-GALEXIE-READINESS 2, CW2 2, PD-2 1, CW1 1.

---

## Appendix B: fate of custom metrics

All 166 series from the inventory (prices 66, explorer 45, x402 55). "Replaced" means: the series stops being published, and its condition lives on in the signal. "Conditional" means: the series stays until the given event.

I checked who reads each series in the origin/develop code: alarms and dashboard (`infra/src/lib/stacks/observability-stack.ts`), CI gate `tools/scripts/verify-dashboard-synth.mjs`, runbooks `docs/runbooks/*`.

### B.1 Prices (66)

kept 12, replaced 36, drop 18; of which 8 conditional.

| Namespace | Series | Dimensions | Fate | Who reads / condition |
|---|---|---|---|---|
| Prices/Enrichment | `EnrichmentRowsEnriched` | — | kept | dashboard overview, CI gate, M1 Table 3 (enrichment-backlog) |
| Prices/Enrichment | `EnrichmentRowsRemainingRecent` | — | kept | dashboard overview, CI gate, M1 Table 3 (enrichment-backlog) |
| Prices/Mtls | `MinDaysToNotAfter` | — | kept | input to the mtls-notafter alarm, dashboard, CI gate |
| Prices/Rollup | `ClickHouseDiskFreePercent` | — | kept | dashboard overview (threshold line), CI gate |
| Prices/Rollup | `RollupLagSeconds` | Table=current_prices | kept | dashboard overview (7 tiers), CI gate verify-dashboard-synth.mjs:128; M3 export (queries-rollup.json fresh_current) |
| Prices/Rollup | `RollupLagSeconds` | Table=price_ohlcv_15m | kept | dashboard overview (7 tiers), CI gate verify-dashboard-synth.mjs:128 |
| Prices/Rollup | `RollupLagSeconds` | Table=price_ohlcv_1M | kept | dashboard overview (7 tiers), CI gate verify-dashboard-synth.mjs:128 |
| Prices/Rollup | `RollupLagSeconds` | Table=price_ohlcv_1d | kept | dashboard overview (7 tiers), CI gate verify-dashboard-synth.mjs:128 |
| Prices/Rollup | `RollupLagSeconds` | Table=price_ohlcv_1h | kept | dashboard overview (7 tiers), CI gate verify-dashboard-synth.mjs:128 |
| Prices/Rollup | `RollupLagSeconds` | Table=price_ohlcv_1m | kept | dashboard overview (7 tiers), CI gate verify-dashboard-synth.mjs:128 |
| Prices/Rollup | `RollupLagSeconds` | Table=price_ohlcv_1w | kept | dashboard overview (7 tiers), CI gate verify-dashboard-synth.mjs:128 |
| Prices/Rollup | `RollupLagSeconds` | Table=price_ohlcv_4h | kept | dashboard overview (7 tiers), CI gate verify-dashboard-synth.mjs:128 |
| Prices/Backfill | `EarliestOverclaimSeconds` | Stream=sdex_archive | replaced: PD-1 `backfill_overclaim:sdex_archive` | alarm only; no dashboard widget |
| Prices/Backfill | `EarliestOverclaimSeconds` | Stream=soroban_amm | replaced: PD-1 `backfill_overclaim:soroban_amm` | alarm only; no dashboard widget |
| Prices/Coverage | `UnclassifiedSwapEvents` | — | replaced: PD-1 `coverage_unclassified` | alarm + runbook 0100; no dashboard widget |
| Prices/Enrichment | `CoarseSweepDurationMs` | — | replaced: PR-WORKERS-FAILING | duplicate of AWS/Lambda Invocations/Errors/Duration (task 0347) |
| Prices/Enrichment | `CoarseSweepFailedRuns` | — | replaced: PR-WORKERS-FAILING | duplicate of AWS/Lambda Invocations/Errors/Duration (task 0347) |
| Prices/Enrichment | `CoarseSweepRuns` | — | replaced: PR-WORKERS-FAILING | duplicate of AWS/Lambda Invocations/Errors/Duration (task 0347) |
| Prices/Enrichment | `CoarseSweepTableFailures` | — | replaced: PR-WORKERS-FAILING | coarse-sweep fails the invocation on failed_tables |
| Prices/Ingest | `UnregisteredPoolEvents` | — | replaced: PD-1 `ingest_drop:unregistered_pool:<contract>` | alarm only; no dashboard widget |
| Prices/Oracle | `OracleFailedRuns` | — | replaced: PR-WORKERS-FAILING | duplicate of AWS/Lambda Invocations/Errors/Duration (task 0347) |
| Prices/Oracle | `OracleMeasuredRatesSnapshotted` | — | replaced: PR-RUNTIME-OUTPUTS (`usd_rate_*`) | remove the oracle widget from the dashboard |
| Prices/Oracle | `OracleRowsSkipped` | — | replaced: PR-RUNTIME-OUTPUTS | diagnostics; oracle log lines (PR-RUNTIME-OUTPUTS step 4) |
| Prices/Oracle | `OracleRowsWritten` | — | replaced: PR-RUNTIME-OUTPUTS | **conditional until M2 acceptance**: CI gate verify-dashboard-synth.mjs + dashboard (D7) |
| Prices/Oracle | `OracleRuns` | — | replaced: PR-WORKERS-FAILING | duplicate of AWS/Lambda Invocations/Errors/Duration (task 0347) |
| Prices/Oracle | `OracleSymbolsQueried` | — | replaced: PR-RUNTIME-OUTPUTS | diagnostics; oracle log lines (PR-RUNTIME-OUTPUTS step 4) |
| Prices/Oracle | `OracleTimestampRejected` | — | replaced: PR-RUNTIME-OUTPUTS | **conditional until M2 acceptance**: CI gate verify-dashboard-synth.mjs + dashboard (D7) |
| Prices/Oracle | `OracleUsdRatesSnapshotted` | — | replaced: PR-RUNTIME-OUTPUTS (`usd_rate_*`) | remove the oracle widget from the dashboard |
| Prices/Rollup | `AssetIdCollisions` | — | replaced: PD-1 `asset_id_collisions` | alarm + runbooks 0139, 0242; no dashboard widget |
| Prices/Rollup | `AssetIdOrphanCandles` | — | replaced: PD-1 `asset_id_orphans` | alarm + runbook 0139; no dashboard widget |
| Prices/Rollup | `CandleBandViolations` | — | replaced: PD-1 `ohlc_band` | alarm only; no dashboard widget |
| Prices/Rollup | `CandleZeroInvariantViolations` | — | replaced: PD-1 `zero_invariant` | alarm + runbook 0151; no dashboard widget |
| Prices/Rollup | `MvDriftCount` | — | replaced: PD-1 `mv_drift` | alarm + runbook 0142; no dashboard widget |
| Prices/Rollup | `MvDriftCritical` | — | replaced: PD-2 `mv_drift_critical` | only the alarm and runbook 0286 |
| Prices/Rollup | `MvDriftUnreadable` | — | replaced: PD-1 `mv_drift (not_run)` | alarm only; no dashboard widget |
| Prices/Rollup | `MvRefreshDisabledCount` | — | replaced: PD-1 `mv_refresh:disabled` | alarm only; no dashboard widget |
| Prices/Rollup | `MvRefreshFailingCount` | — | replaced: PD-1 `mv_refresh:failing` | alarm only; no dashboard widget |
| Prices/Rollup | `MvRefreshUnreadable` | — | replaced: PD-1 `mv_refresh:* (not_run)` | alarm + runbook 0142; no dashboard widget |
| Prices/Rollup | `MvRefreshWaitingCount` | — | replaced: PD-1 `mv_refresh:waiting` | alarm only; no dashboard widget |
| Prices/Rollup | `RollupMismatchBuckets` | Table=price_ohlcv_15m | replaced: PD-1 `mismatch:price_ohlcv_15m` | alarm + runbooks 0142, 0286; no dashboard widget |
| Prices/Rollup | `RollupMismatchBuckets` | Table=price_ohlcv_1M | replaced: PD-1 `mismatch:price_ohlcv_1M` | alarm + runbooks 0142, 0286; no dashboard widget |
| Prices/Rollup | `RollupMismatchBuckets` | Table=price_ohlcv_1d | replaced: PD-1 `mismatch:price_ohlcv_1d` | alarm + runbooks 0142, 0286; no dashboard widget |
| Prices/Rollup | `RollupMismatchBuckets` | Table=price_ohlcv_1h | replaced: PD-1 `mismatch:price_ohlcv_1h` | alarm + runbooks 0142, 0286; no dashboard widget |
| Prices/Rollup | `RollupMismatchBuckets` | Table=price_ohlcv_1w | replaced: PD-1 `mismatch:price_ohlcv_1w` | alarm + runbooks 0142, 0286; no dashboard widget |
| Prices/Rollup | `RollupMismatchBuckets` | Table=price_ohlcv_4h | replaced: PD-1 `mismatch:price_ohlcv_4h` | alarm + runbooks 0142, 0286; no dashboard widget |
| Prices/Rollup | `SacContractIdentities` | — | replaced: PD-1 `sac_contract_identities` | **conditionally kept until 0242 closes** (runbook 0242 §4e/§5g/AC reads it from CloudWatch; D6) |
| Prices/Rollup | `UsdtPegAppliedCandles` | — | replaced: PD-1 `usd_peg_applied` | alarm only; no dashboard widget |
| Prices/Rollup | `UsdtStrandedCandles` | — | replaced: PD-1 `usd_stranded` | alarm only; no dashboard widget |
| Prices/Coverage | `UnclassifiedSwapContracts` | — | drop | the alarm reads Events; rewrite runbook 0100 (l. 52, 54, 344) |
| Prices/Enrichment | `CoarseSweepDeadlineHit` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `CoarseSweepRowsEnriched` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `CoarseSweepTablesSkipped` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `CoarseSweepTablesSwept` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `EnrichmentAvgBatchDurationMs` | — | drop | **conditional until M2 acceptance**: CI gate verify-dashboard-synth.mjs + dashboard (D7) |
| Prices/Enrichment | `EnrichmentFrontierMonth` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `EnrichmentFrontierMonthsPending` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `EnrichmentFrontierMonthsReopened` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `EnrichmentHistoricalDeadlineHit` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `EnrichmentHistoricalRowsEnriched` | — | drop | diagnostics without an alarm; "pass complete" log line |
| Prices/Enrichment | `EnrichmentOracleMiss` | — | drop | **conditional until M2 acceptance**: CI gate verify-dashboard-synth.mjs + dashboard (D7) |
| Prices/Enrichment | `EnrichmentPassDurationMs` | — | drop | **conditional until M2 acceptance**: CI gate verify-dashboard-synth.mjs + dashboard (D7) |
| Prices/Enrichment | `EnrichmentRowsRemainingAtVolumeZero` | — | drop | **conditional until M2 acceptance**: CI gate verify-dashboard-synth.mjs + dashboard (D7) |
| Prices/Ingest | `ClickHouseWriteLatencyMs` | — | drop (PR-INGEST catches the effect) | **conditional until M2 acceptance**: CI gate verify-dashboard-synth.mjs + dashboard (D7); SCF Row-0, milestone-2-evidence.md:569 |
| Prices/Mtls | `DaysToNotAfter` | Role=api | drop | MinDaysToNotAfter is enough |
| Prices/Mtls | `DaysToNotAfter` | Role=ingestion | drop | MinDaysToNotAfter is enough |
| Prices/Rollup | `ClickHouseDiskFreeBytes` | — | drop | nobody reads it (task 0347); disk is measured in % |

### B.2 Explorer (45)

kept 2, replaced 2, drop 41; of which 38 conditional (Container Insights).

| Namespace | Series | Dimensions | Fate | Who reads / condition |
|---|---|---|---|---|
| SorobanBlockExplorer/Indexer | `ChWriteFailures` | — | drop | dead since ~2026-11-12 |
| SorobanBlockExplorer/Indexer | `IngestionLagSeconds` | Environment=production | kept | bits 1/4 and the raw-lag backstop in `*-explorer-signal` |
| SorobanBlockExplorer/Indexer | `IngestionLagSeconds` | Environment=testnet | kept | bit 1 and the raw-lag backstop in `testnet-explorer-signal` |
| SorobanBlockExplorer/Indexer | `LastProcessedLedgerSequence` | Environment=production | drop | dashboards and live-tail-cutover.md → `SELECT max(sequence)` from ledgers |
| SorobanBlockExplorer/Indexer | `LastProcessedLedgerSequence` | Environment=testnet | drop | dashboards and live-tail-cutover.md → `SELECT max(sequence)` from ledgers |
| SorobanBlockExplorer/Indexer/production | `IndexerFailures` | — | replaced: EXP-*-SIGNAL bit 1 | dashboard widget → Logs Insights on fields.alarm="indexer_failure" |
| SorobanBlockExplorer/Indexer/testnet | `IndexerFailures` | — | replaced: EXP-*-SIGNAL bit 1 | dashboard widget → Logs Insights on fields.alarm="indexer_failure" |
| ECS/ContainerInsights | 38 series: `ContainerInstanceCount`, `CpuReserved`, `CpuUtilized`, `DeploymentCount`, `DesiredTaskCount`, `EphemeralStorageReserved`, `EphemeralStorageUtilized`, `MemoryReserved`, `MemoryUtilized`, `NetworkRxBytes`, `NetworkTxBytes`, `PendingTaskCount`, `RunningTaskCount`, `ServiceCount`, `StorageReadBytes`, `StorageWriteBytes`, `TaskCount`, `TaskSetCount` | ClusterName=production-ingestion, ±ServiceName / TaskDefinitionFamily=production-galexie-live | drop **after the sidecar gate** (0673) | **conditional, until the sidecar gate**: only production-galexie-ephemeral-storage reads it |

### B.3 x402 (55)

kept 3, replaced 34, drop 18; of which 30 conditional.

| Namespace | Series | Dimensions | Fate | Who reads / condition |
|---|---|---|---|---|
| x402-host | `disk_used_percent` | path=/ | kept | agent_silent (SampleCount) and audit_disk (Max >= 90) in CW3; disk-root until 0139 |
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
| x402-host | `certificate_days_left` | — | replaced: P3 `certificate` | **conditional, until 0139** (the old alarm reads it) |
| x402-host | `credentials_age_seconds` | — | replaced: P3 `credentials` | **conditional, until 0139** (the old alarm reads it) |
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

New series (not in the 166): Prices `FailingChecks`, `FailingCriticalChecks`, `RuntimeChecksFailing`, `PortalSourcesLoadFailed` (empty today); Explorer `ReadinessFailing`, `Bits` ×2, `NewBits` ×2; x402 `findings`. In total 10 new + 17 kept = 27.
