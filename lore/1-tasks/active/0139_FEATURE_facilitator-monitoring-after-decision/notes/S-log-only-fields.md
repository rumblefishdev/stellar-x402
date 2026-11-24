---
title: "Step 4: where each log-only field goes, and what the switch has to carry"
type: synthesis
status: mature
spawned_from: ../../../archive/0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/I-grafana-shape.md
spawns: []
tags: [monitoring, prometheus, metrics-catalog, emf]
links:
  - ../../../archive/0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/S-decision-draft.md
history:
  - date: 2026-11-19
    status: mature
    who: stkrolikiewicz
    note: "Field table from 2026-11-18, values read from the code, and Adam's three points from #200"
  - date: 2026-11-19
    status: mature
    who: stkrolikiewicz
    note: "The certificate label, and Adam's points for steps 6 and 7 from #203 and #204"
---

# Step 4: where each log-only field goes, and what the switch has to carry

Step 4 of the [order](../../../archive/0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/S-decision-draft.md#order-0139).
A catalog `field` is a label in the EMF line only, so it goes when the metric lines stop
([why](../../../archive/0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/I-grafana-shape.md#what-the-emf-lines-carry-that-a-series-wont)).
Each field either becomes a Prometheus label or stays in an app line, which CloudWatch keeps.

## The rule

A field becomes a label when its values form a short closed list. The adapter writes a zero
series for every combination of a metric's closed values, so the product of a metric's label
values counts, not the values seen. A field with open or numeric values stays in an app line.

In the catalog, a label field has its closed values in `fieldValues`, with `other` for anything
outside the list. EMF never reads `fieldValues`, so these fields stay log fields there and
CloudWatch bills nothing new before the switch.

## Fields that become labels

The values come from the code that writes them. A value the code adds later is written as
`other` and reported once through `onIssue`.

| Metric | Field | Values (from) | Series per network |
| --- | --- | --- | --- |
| `settlement_outcomes_total` | `replay` | true, false | × 3 on `result` |
| `settlement_refused_after_verify_total` | `reason` | `REFUSED_AFTER_VERIFY` in settle.ts (3) | × 3 on `stage` |
| `settlement_landed_after_expired_total`, `settlement_rewrapped_total` | `state` | success, failed | 3 each |
| `settlement_nonce_consumed_elsewhere_total` | `window` | verify, settle | 3 |
| `signer_failures_total` | `reason`, `step` | `SignerFailure` (7) × sign, check | 24 |
| `settlement_budget_exhausted_total` | `signed` | true, false | 3 |
| `settlement_reopened_total` | `reason` | `UNSENT_REASONS` (11) | 12 |
| `settlement_hook_failures_total` | `hook` | `keyof SettlementHooks` (4) | 5 |
| `lease_changes_total` | `held` | true, false | 3 |
| `store_prune_failures_total` | `table` | the pruner's 4 tables, and #205's `settlements_refused` | 6, process |
| `catalog_internal_errors_total` | `stage`, `origin` | the cataloger's 11 steps × settle, resolved | 36, process |
| `catalog_attempts_total` | `origin`, `stage`, `outcome` | settle, resolved × payment, seller × `CatalogAttemptOutcome` (11) | 108, process |
| `catalog_upsert_failures_total`, `catalog_attempt_write_failures_total`, `catalog_route_template_ignored_total` | `origin` | settle, resolved | 3 each, process |
| `spend_commit_unmatched_total`, `fee_charged_stroops` | `state` | success, failed (only a landed record has a fee) | 3 each |
| `spend_store_failures_total` | `op` | breaker, reserve, release | 4 |
| `spend_refused_total` | `reason` | the policy's 11 refusals | 12 |
| `rpc_on_fallback` | `rpc` | the `RPC_URLS` index: 0, 1, 2 (`MAX_RPC_URLS` is 3) | gauge |
| `certificate_days_left` | `certificate` | cloudwatch-agent, metrics-agent: the probe's textfile (#204) | gauge, host |

Each count includes `other`. Measured from the adapter's zero series: **368 series with one
network, 504 with both**. 232 of them are process-scoped, and `catalog_attempts_total` alone is
108. The CPX12 estimate was 4,000 to 10,000.

`fee_charged_stroops` keeps `state` as a label, so `increase(fee_charged_stroops[7d])` by `state`
sums the week. The weekly review still reads the settlement records, not this series (Adam's
point 1 below).

## Fields that stay in an app line

| Metric | Field | Why not a label | Where it is read |
| --- | --- | --- | --- |
| `settlement_outcomes_total` | `reason` | about 75 values × 3 `result`, almost every combination dead | `settled` (http/app.ts) has `errorReason` |
| `catalog_attempts_total` | `reason` | about 30 values × 108 | the `catalog_attempts` row (Postgres), and the `catalog_check_skipped`, `catalog_rejected` and `catalog_upserted` lines; `unchanged` has no reason |
| `pool_events_total` | `status` | it means something only for `type=resolved`; 11 × 5 series | `settlement_resolved` has `status`; Oskar to confirm for 0125 |
| `pool_queued` | `channels`, `busy` | numbers: each value would be a new series | two gauges of their own, `pool_channels` and `pool_busy` |

The two runbook queries on pool events (`docs/monitoring.md`, the `fee-raised` and `send-retry`
counts) filter on `type`, which is already a label. They become PromQL at the switch.

## What the switch (step 7) has to carry from this step

- `main.ts` registers `pool_channels` and `pool_busy`. They are in the catalog now and registered
  only at the switch, so EMF writes nothing new before it.
- `main.ts` passes `rpc_on_fallback`'s `rpc` as the index, and the adapter's `RPC_INDEX` rewrite
  goes. Until then the EMF line keeps the endpoint's name, and `rpc_failover` maps the index to
  it.
- `pool_queued`'s `channels` and `busy` leave its `fields`.

## Adam's three points from the review of #200

1. **Pull loses the tail.** What is counted after the last scrape is lost at every exit (a deploy's
   drain, a crash), where EMF had the final flush and `eager-first`. Accepted. The weekly fee review
   (ADR 0013) reads the settlement records in Postgres, each with its fee, not
   `fee_charged_stroops` summed over 7 days, which would come out short after each deploy. To
   write into ADR 0011 with the switch.
2. **Step 6's `absent()` is per network.** With testnet and pubnet on one VM,
   `absent(x_last_read_timestamp_seconds)` stays empty while either network's stamp exists. Each
   rule names its network: `absent(x_last_read_timestamp_seconds{network="stellar:pubnet"})`, one
   per configured network. The liveness series has no `network`, so a join can't replace it.
3. **The notes below lived only in #200's description.**

### Where the adapter differs from EMF (from #200)

| The label | EMF | Prometheus |
| --- | --- | --- |
| missing (`http_requests_total` without `status`) | the sets holding it are dropped; `[route]` is still written | written as `status="other"` |
| `network` missing | the line is dropped (`no-valid-set`) | `network="other"` |
| `network` not a `STELLAR_NETWORKS` value | written as given | `network="other"` |

A network-scoped counter without `network` only happens past the types: the root's
`ProcessMetrics` takes no network-scoped name.

### For step 6 (from the review of #200)

- A stamp exists only after a gauge's first successful read, so each rule on
  `time() - <name>_last_read_timestamp_seconds > X` needs an `absent()` beside it, per network.
- An alarm carried over from a CloudWatch set with a `when` on a dim adds it as a matcher:
  `spend_failure_attributed_total{fault="ours"}`, `settlement_refused_after_verify_total{stage="pool"}`,
  `http_requests_total{status="500"}`.

### For steps 6 and 7 (from Adam's review of #203 and #204)

- **Step 7, the network.** The facilitator joins `x402-metrics` (`deploy/metrics/compose.yaml`).
  If `x402-production` takes it as an external network, `x402@production` can't start at boot
  until `x402-metrics.service` has made it, and nothing orders the two units. Adam's option: the
  playbook makes the network, so neither project owns it.
- **Step 6, ClickHouse's endpoint.** ADR 0011 scrapes it "so one view covers the shared server",
  and its series are the unknown part of the ~8,000 the CPX12 holds. Reaching it needs a change in
  the explorer's container; raise it with their team before step 6.
- **`project: x402`** is in the agent's `external_labels` (#203), so the VM tells x402's host
  series from another project's from the first sample on.
