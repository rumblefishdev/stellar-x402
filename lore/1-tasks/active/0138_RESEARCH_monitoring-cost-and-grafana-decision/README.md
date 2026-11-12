---
id: "0138"
title: "Measure what CloudWatch costs and decide: cut it down or move to Grafana"
type: RESEARCH
status: active
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

## Questions

- What does CloudWatch cost a month today, split into custom metrics, log ingestion and storage,
  alarms and the probe?
- How far does cutting get us: fewer metrics and dimensions, log levels, retention, fewer alarms?
- If Grafana: Grafana Cloud, or our own on a separate VM in Hetzner Cloud (not the production
  server, which it has to watch)? What does each cost, and who is paged when Grafana itself is
  down?
- What is the monthly amount we accept?

## Acceptance Criteria

- [ ] The current monthly cost is measured and split by source, with the dates measured
- [ ] The decision (cut CloudWatch, or Grafana and where it is hosted) is recorded as an amendment
      to ADR 0011 with the options' costs
- [ ] The metric format (EMF or Prometheus) is decided and announced before the end of M2's first
      week, with the list of metrics and logs that stay
- [ ] A target monthly amount is written into 0139 as its done signal
- [ ] If Grafana is chosen, the amendment says what watches Grafana from outside
- [ ] The task says whether moving the explorer's and the Prices API's monitoring is planned, and
      that it is outside this project's work
