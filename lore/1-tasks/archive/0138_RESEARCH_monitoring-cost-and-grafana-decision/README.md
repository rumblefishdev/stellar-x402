---
id: "0138"
title: "Measure what CloudWatch costs and decide: cut it down or move to Grafana"
type: RESEARCH
status: completed
owner: stkrolikiewicz
milestone: 2
related_adr: ["0011"]
related_tasks: ["0014", "0027", "0139"]
tags: [monitoring, cloudwatch, grafana, cost, priority-high, effort-small, platform]
links:
  - ../../../../docs/adr/0011-facilitator-hosting.md
  - ../../../../docs/monitoring.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan and its review: the team wants monitoring on
      Grafana, and the choice changes the metric format every lane writes.
  - date: "2026-11-12"
    status: active
    who: stkrolikiewicz
    note: "Work starts: the platform track of the Milestone 2 plan."
  - date: "2026-11-13"
    status: active
    who: stkrolikiewicz
    note: "Every alarm checked against what it reads, and a draft decision for the team; not decided yet"
  - date: "2026-11-17"
    status: active
    who: stkrolikiewicz
    note: >
      Decided with the team: option B, Prometheus and Alertmanager on a separate Hetzner Cloud VM
      (CPX12 in Helsinki, bought the same day), recorded in the ADR 0011 amendment. Merging PR
      #186 is the team's agreement.
  - date: "2026-11-18"
    status: completed
    who: stkrolikiewicz
    note: >
      Closed after #186 merged (e4dd1a1c, Oskar's approval): the ADR 0011 amendment, six notes
      and 0139's $8 target. The announcement criterion was dropped by stkrolikiewicz; the format
      is in the ADR and the team agreed to it by merging. Open choices D1–D30 went to 0151.
---

# Measure what CloudWatch costs and decide: cut it down or move to Grafana

## Summary

As the team paying for the facilitator's monitoring, we want to know what CloudWatch costs and
choose between cutting it down and moving to Grafana, in the first week of M2, so nobody adds a
metric in a format we then drop.

## Context

- ADR 0011 chose CloudWatch for logs, metrics and alarms and rejected Grafana Cloud Free: "$0, but
  a second vendor whose alert rules sit outside our config". A move to Grafana amends that ADR.
- Since 0027 the facilitator emits EMF metrics from a typed catalog
  (`packages/metrics-catalog`), ships logs and host metrics to CloudWatch, and has 47 alarms and
  an uptime probe in CDK (`infra/`).
- Grafana means Prometheus metrics instead of EMF. A metric added in EMF before the decision is
  written twice if the decision is Grafana, so the format has to be fixed before other M2 work
  adds metrics.
- The wider wish is one Grafana for the explorer, the Prices API and the facilitator. Moving the
  other two is not work of this project; this task decides for the facilitator and says what the
  shared setup would need.
- Monitoring is not a Tranche #2 line item.

## Decision (2026-11-17)

Option B of the [draft](notes/S-decision-draft.md): Prometheus and Alertmanager on a separate
Hetzner Cloud VM, CloudWatch for what must outlive it. The record is the ADR 0011 amendment.

- **Format: Prometheus.** New metrics go through `packages/metrics-catalog` as before; 0139
  replaces its EMF adapter with `/metrics`. Nobody adds an EMF-only metric from now on.
- **Metrics that stay:** every metric in the catalog, under the same name, as a Prometheus series
  (the list is `docs/monitoring.md`); none is dropped. In CloudWatch stay `x402-watch`'s
  (`spendable_stroops`, `protocol_version`, `protocol_supported_version`,
  `upstream_files_changed`, `account_state_mismatches`, `account_effects_unexpected`,
  `backup_secret_reads`), the uptime probe's `ready`, the audit log disk's use, and the
  heartbeat topic's `NumberOfMessagesPublished`, which costs nothing.
- **Logs that stay:** all of them, in CloudWatch Logs through the CloudWatch agent: the app lines,
  the units' output and the Lambdas' logs. Only the EMF lines stop, and their log group is
  deleted once its 30-day retention has run out.
- **Target:** x402's CloudWatch at or under $8 a month, with the VM on CPX12 ($11.59 a month with
  its IPv4, before VAT). It is 0139's done signal.
- **The explorer and the Prices API:** moving their monitoring to the VM is possible later and
  not planned here. It is outside this project's work: the Prices API keeps its alarms until its
  Milestone 2 acceptance, except for its own fixes (0344–0347), and the explorer first has to
  supersede its ADR 0054. Their findings went to rumblefishdev/stellar-prices-api#420 and
  rumblefishdev/soroban-block-explorer#733.

## Questions

- What does CloudWatch cost a month today, split into custom metrics, log ingestion and storage,
  alarms and the probe?
- How far does cutting get us: fewer metrics and dimensions, log levels, retention, fewer alarms?
- If Grafana: Grafana Cloud, or our own on a separate VM in Hetzner Cloud (not the production
  server, which it has to watch)? What does each cost, and who is paged when Grafana itself is
  down?
- What is the monthly amount we accept?

## Acceptance Criteria

- [x] The current monthly cost is measured and split by source, with the dates measured
      (`notes/R-cloudwatch-cost-measurement.md`, read on 2026-11-12)
- [x] The decision (cut CloudWatch, or Grafana and where it is hosted) is recorded as an amendment
      to ADR 0011 with the options' costs
- [x] A target monthly amount is written into 0139 as its done signal ($8 a month)
- [x] If Grafana is chosen, the amendment says what watches Grafana from outside (the Watchdog
      heartbeat through Alertmanager to SNS, alarmed in CloudWatch)
- [x] The task says whether moving the explorer's and the Prices API's monitoring is planned, and
      that it is outside this project's work (Decision, last point)

The criterion "the metric format is decided and announced before the end of M2's first week" was
dropped on 2026-11-18: the format and the list of what stays are in the ADR 0011 amendment and the
Decision above, and merging #186 was the team's agreement.

## Implementation Notes

- **#186** (merged 2026-11-18, 14 commits, docs only): the ADR 0011 amendment and six notes.
  - `R-cloudwatch-cost-measurement`: the invoice from Cost Explorer (October $42.34, 86% custom
    metrics and alarms) and the inventory: 165 custom metrics and 155 alarms across the account.
  - `R-alarm-inventory-and-reductions`: every custom metric mapped to the alarms and dashboards
    that read it (2026-11-13, read-only).
  - `R-logs-cloudwatch-or-loki`: logs stay in CloudWatch for Milestone 2.
  - `I-grafana-shape`, `S-decision-draft`: options A (stack on ch-prod-01), B (separate VM) and
    C (Grafana Cloud Free); B chosen.
  - `G-alarm-signals-and-triage-runbooks`: account-wide 155 → 29 CloudWatch alarms and about
    $62.80 → $9.60 a month, plus about $4–5 of reads, with a triage runbook per signal.
- The monitoring VM was bought on 2026-11-17 (CPX12, HEL1, $11.59 a month with IPv4, before VAT)
  and is provisioned from soroban-infrastructure (#12, #13).

## Issues Encountered

- **The bill can't be split by project.** CloudWatch metrics and alarms take no cost-allocation
  tags, so the per-project figures are the inventory times the invoice's rates, not invoiced
  amounts. The uptime probe's Lambda cost was not measured.
- **Numbers moved after the first draft.** #186's description and the team message of 2026-11-17
  said about 24 alarms and $8.50; the final count in the G- note is 29 alarms and $9.60.
- **The triage SQL has not run on live data.** The runbooks' ClickHouse queries had not run on live
  data when #186 merged.

## Design Decisions

### From Plan

1. **Measure before deciding**: the invoice and the inventory came first, so the options were
   compared in dollars, not in preferences.
2. **The decision is an ADR 0011 amendment**, since ADR 0011 had rejected Grafana Cloud Free.

### Emerged

3. **Option B over Grafana Cloud Free**: the draft started from Grafana Cloud Free; it moved to
   our own stack on a separate VM once the 10,000-series and 14-day limits and the second vendor
   were weighed (Marek for B).
4. **Logs stay in CloudWatch**: Loki was compared and left out for Milestone 2, so the CloudWatch
   agent stays and only the EMF lines stop.
5. **No period running both systems**: the new rules switch on with the old alarms' removal in
   one change (0139 AC3), so nobody gets paged twice.
6. **The Prices API keeps its alarms until its Milestone 2 acceptance**, except 0344–0347 (Oskar's
   review); its findings went to stellar-prices-api#420, the explorer's to
   soroban-block-explorer#733.
7. **The announcement criterion was dropped** (stkrolikiewicz, 2026-11-18): the ADR and the merge
   carry the format to the team.

## Future Work

- Carry out the decision: 0139.
- The open choices D1–D30 from the G- note §6 (phone route, pubnet gate, SNS credentials and the
  rest) and the draft's "Still open" list: 0151.
