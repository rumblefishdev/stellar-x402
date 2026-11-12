---
id: "0139"
title: "Carry out the monitoring decision for the facilitator, with every alarm fired again"
type: FEATURE
status: backlog
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
---

# Carry out the monitoring decision for the facilitator, with every alarm fired again

## Summary

As the team running the facilitator, we want its monitoring to cost the amount 0138 set, without
losing an alarm that protects money or a payment.

## Context

- 0138 decides between a smaller CloudWatch setup and Grafana, the metric format and the target
  amount. This task does the work for the facilitator only.
- `docs/monitoring.md` lists every metric and alarm (0027). Several alarms guard money: low
  balance, budgets, breakers, quarantined channels, pending settlements.
- The AWS account is shared with the explorer team; changes to it are agreed with them first.
- Alarm tasks still open build on whatever this leaves: 0089, 0109, 0118, 0125, 0127.

## Implementation Plan

- Change the metrics, logs and alarms as 0138 decided, behind the typed metric catalog.
- Keep the old alarms on until each new one has fired in a drill.
- If Grafana: an external heartbeat that reports when Grafana itself is silent.
- Update `docs/monitoring.md` and the runbook.

## Acceptance Criteria

- [ ] Given a full month (or a measured week scaled to one), when the facilitator's monitoring
      cost is read, then it is at or under the amount recorded by 0138
- [ ] Given every alarm in `docs/monitoring.md`, when the drill runs, then each has fired once in
      the new setup, and the drill is recorded
- [ ] No old alarm was turned off before its replacement fired
- [ ] If Grafana is used, then an outage of Grafana raises an alert from outside it, shown once
- [ ] `docs/monitoring.md` and the runbook describe the new setup, and ADR 0011 matches it
