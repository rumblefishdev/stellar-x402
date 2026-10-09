---
id: "0027"
title: "Alerts and metrics"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007"]
related_tasks: ["0012", "0014", "0024", "0026"]
tags: [facilitator, operations, monitoring, priority-medium, effort-small, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.6 (Platform lane)."
---

# Alerts and metrics

## Summary

As a facilitator operator, I want metrics and alerts for anything that costs money or can lose a payment, so that I hear about problems before users do.

**Story:** [M1 Story 2.6](../../../docs/planning/m1-epics.md#story-26-alerts-and-metrics) · **Lane:** Platform · **Covers:** FR14 (AD-18); NFR7

## Context

- The backend comes from 0014; the budget and breaker events come from 0024.
- Related tasks: 0014, 0024, 0026.

## Implementation

- Metrics adapter in `adapters/` fed by pool events and the HTTP layer.
- Alert rules for the five conditions; a balance check on a timer.
- Update `docs/monitoring.md`.
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)): the backend is
  CloudWatch. The metrics adapter writes Embedded Metric Format lines to stdout (namespace
  `x402-facilitator`), and `awslogs` turns them into metrics; no SDK or agent. Dimensions stay
  low-cardinality (`network`, route, outcome, event name), never payer or `payTo`. Check once that
  extraction works, since some setups report it failing.
- From 0014: alarms → SNS → Amazon Q Developer in chat applications → the team's Slack channel;
  a Route 53 HTTPS health check on the public `/supported` measures uptime.
- From 0014: export "lease held" as a metric with an alarm. The health check doesn't look at the
  lease (ADR 0011), so this is how a process stuck without the lease is noticed.

## Acceptance Criteria

- [ ] Given the running facilitator, when it serves traffic, then pool `onEvent` events, per-route request counts and settle outcomes are exported as metrics
- [ ] Given each alert condition: budget nearly used, breaker open, low facilitator balance (`checkFacilitatorBalance`), quarantined channel, pending settlements, when it occurs, then an alert fires on the backend chosen in 0014; each alert has been triggered once on testnet or with a fake
- [ ] Given `docs/monitoring.md`, when this story is done, then it lists every metric and alert
