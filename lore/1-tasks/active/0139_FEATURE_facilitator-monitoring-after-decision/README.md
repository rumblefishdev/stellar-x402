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
  - ../../../../docs/monitoring.md
  - ../../../../docs/adr/0011-facilitator-hosting.md
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
  - date: "2026-11-19"
    status: active
    who: stkrolikiewicz
    note: >
      Step 4: the log-only fields of 21 metrics become labels through the catalog's
      `fieldValues`, the rest stay in app lines, and Adam's three points from #200 are recorded
      ([S-log-only-fields](notes/S-log-only-fields.md)).
  - date: "2026-11-19"
    status: active
    who: stkrolikiewicz
    note: >
      Step 6, the rules: `make rules` in `infra/` writes `deploy/metrics/rules/x402-production.yml`
      from the alarm rows, `network` a label and the Event rows one rule, with the server rules
      for liveness, stamps, textfiles and the agent. Alertmanager's routes and the heartbeat come
      next.
  - date: "2026-11-20"
    status: active
    who: stkrolikiewicz
    note: >
      Severity and repeat intervals decided for Alertmanager's routes (Design Decisions 1 and 2),
      after Karol's review of #211. His points for the switch are under "For the switch".
  - date: "2026-11-24"
    status: active
    who: stkrolikiewicz
    note: >
      Heartbeat on: the VM's Watchdog reaches the topic every minute through IAM Roles Anywhere
      (soroban-infrastructure#19), the alarm on since 12:48 UTC, drilled by stopping
      Alertmanager (ALARM 20 minutes later, docs/monitoring.md, Drills). The switch's plan and
      drill are in [G-switch-plan](notes/G-switch-plan.md).
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
  ([order](../../archive/0138_RESEARCH_monitoring-cost-and-grafana-decision/notes/S-decision-draft.md#order-0139)).
- Switch in one change: the rules go on, and the EMF adapter and the old CloudWatch alarms go
  off. No period runs both (decided 2026-11-17 in 0138). Every rule is drilled right after the
  switch, and one that fails its drill is fixed forward.
- A heartbeat in CloudWatch that fires when the monitoring VM or its Alertmanager goes silent.
- Update `docs/monitoring.md` and the runbook.

## Acceptance Criteria

- [ ] Given a full month (or a measured week scaled to one), when x402's CloudWatch bill is read,
      then it is at or under $8 a month, with the monitoring VM on CPX12 (0138's target)
- [ ] Given every alarm in `docs/monitoring.md`, when the drill runs, then each has fired once in
      the new setup, and the drill is recorded
- [ ] The switch is one change, with no period running both the old alarms and the new rules,
      and every rule's drill follows it the same day
- [x] Given the monitoring VM or its Alertmanager stops, then a CloudWatch alarm fires from
      outside it, shown once (2026-11-24, docs/monitoring.md, Drills)
- [ ] `docs/monitoring.md` and the runbook describe the new setup, and ADR 0011 matches it

## Design Decisions

1. **`severity` on every rule (2026-11-20).** `critical` for what would page on mainnet,
   `warning` for Slack only, `none` for the Watchdog (kube-prometheus' values, Karol's point 7 on
   #211). `critical`: `pending`, the three `breaker-opened-*`, `budget-nearing` (ADR 0011's money
   alerts), `sweeps-stopped`, `landed-after-expired`, `commit-unmatched` (0138's D1 default),
   `facilitator-silent`, `gauge-stale` (D2's default). It is a field of the alarm row, next to
   its threshold, default `warning`, which CloudWatch ignores; on the Event rule each branch sets
   it, as `check`. The phone route (D11) then matches `severity="critical"`, not a list of checks.
2. **Repeat intervals (2026-11-20).** `warning` 24 h, `critical` 1 h; the Watchdog's route keeps
   1 min (ADR 0011). CloudWatch never repeats, so a day is the nearest to what the team has, and a
   standing alert still comes back once a day. An Event alert resolves after its 15-minute window
   with no resolved message, so it never repeats. All routes: `group_wait` 30 s,
   `group_interval` 5 min, `group_by` `[alertname, check, network, project]`.

## For the switch

From Karol's review of #211:
- The split of what moves and what stays lives only in `rules.ts` (`STAYS`, `REPLACED`); the
  switch must turn off exactly the CloudWatch alarms that moved.
- No rule reads `prometheus_remote_storage_*`, which `deploy/metrics/prometheus.yml` names "for
  the VM's rules".
- `docs/monitoring.md`'s `facilitator-silent` and `gauges-silent` sections describe the CloudWatch
  alarms, while the Prometheus rules of those names point at them.
