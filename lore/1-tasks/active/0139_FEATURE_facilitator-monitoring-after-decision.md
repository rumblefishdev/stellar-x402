---
id: "0139"
title: "Carry out the monitoring decision for the facilitator, with every alarm fired again"
type: FEATURE
status: active
owner: stkrolikiewicz
milestone: 2
related_adr: ["0011"]
related_tasks: ["0138", "0027", "0089", "0109", "0118", "0125", "0127"]
tags: [monitoring, alarms, cost, priority-medium, effort-large, platform]
links:
  - ../../../docs/monitoring.md
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan. Waits on 0138's decision.
  - date: "2026-11-17"
    status: active
    who: stkrolikiewicz
    note: >
      Started with the monitoring VM, bought on 2026-11-17 (CPX12 in Helsinki). The decision is
      the ADR 0011 amendment in PR #186.
---

# Carry out the monitoring decision for the facilitator, with every alarm fired again

## Summary

As the team running the facilitator, we want its monitoring to cost the amount 0138 set, without
losing an alarm that protects money or a payment.

## Context

- 0138 decided (ADR 0011 amendment, PR #186): Prometheus and Alertmanager on a separate Hetzner
  Cloud VM (CPX12 in Helsinki, bought 2026-11-17), an agent on ch-prod-01 sending to it over
  `remote_write`, and CloudWatch keeping the logs, `x402-watch` and a heartbeat. The target is
  x402's CloudWatch at or under $8 a month. This task does the work for the facilitator only.
- `docs/monitoring.md` lists every metric and alarm (0027). Several alarms guard money: low
  balance, budgets, breakers, quarantined channels, pending settlements.
- The AWS account is shared with the explorer team; changes to it are agreed with them first.
- Alarm tasks still open build on whatever this leaves: 0089, 0109, 0118, 0125, 0127.

## Implementation Plan

- Change the metrics, logs and alarms as 0138 decided, behind the typed metric catalog
  ([order](0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/S-decision-draft.md#order-0139)).
- Switch in one change: the rules go on, and the EMF adapter and the old CloudWatch alarms go
  off. No period runs both (decided 2026-11-17 in 0138). Every rule is drilled right after the
  switch, and one that fails its drill is fixed forward.
- A heartbeat in CloudWatch that fires when the monitoring VM or its Alertmanager goes silent.
- Update `docs/monitoring.md` and the runbook.

## Acceptance Criteria

- [ ] Given a full month (or a measured week scaled to one), when the facilitator's monitoring
      cost is read, then it is at or under the amount recorded by 0138
- [ ] Given every alarm in `docs/monitoring.md`, when the drill runs, then each has fired once in
      the new setup, and the drill is recorded
- [ ] The switch is one change, with no period running both the old alarms and the new rules,
      and every rule's drill follows it the same day
- [ ] Given the monitoring VM or its Alertmanager stops, then a CloudWatch alarm fires from
      outside it, shown once
- [ ] `docs/monitoring.md` and the runbook describe the new setup, and ADR 0011 matches it
