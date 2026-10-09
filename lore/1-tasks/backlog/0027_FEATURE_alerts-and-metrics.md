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
  - date: "2026-10-09"
    status: backlog
    who: okarcz
    note: "Added the UptoProxy TTL alert from 0035's future work."
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
- **UptoProxy TTL (from 0035):** read the proxy's instance and code TTL on the balance timer and
  alert when either drops below about 30 days (`TTL_EXTEND_TO`, 518,400 ledgers). The contract
  extends itself on settlements, so a low TTL means little traffic; an operator then extends it
  with `stellar contract extend` before it is archived.
- Update `docs/monitoring.md`.

## Acceptance Criteria

- [ ] Given the running facilitator, when it serves traffic, then pool `onEvent` events, per-route request counts and settle outcomes are exported as metrics
- [ ] Given each alert condition: budget nearly used, breaker open, low facilitator balance (`checkFacilitatorBalance`), quarantined channel, pending settlements, when it occurs, then an alert fires on the backend chosen in 0014; each alert has been triggered once on testnet or with a fake
- [ ] Given `docs/monitoring.md`, when this story is done, then it lists every metric and alert
