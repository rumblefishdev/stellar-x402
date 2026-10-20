---
id: "0027"
title: "Alerts and metrics"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007", "0011"]
related_tasks: ["0012", "0014", "0024", "0026", "0020", "0009", "0045", "0049"]
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
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)): the backend is CloudWatch.
  - The adapter writes Embedded Metric Format lines to stdout (namespace `x402-facilitator`), and
    `awslogs` turns them into metrics; no SDK or agent.
  - Dimensions stay low-cardinality (`network`, route, outcome, event name), never payer or
    `payTo`, and the adapter emits only listed fields.
  - Check once that extraction works, since some setups report it failing.
- From 0014: alarms go through SNS and Amazon Q Developer in chat applications to the team's
  Slack channel. Besides the five AD-18 conditions:
  - "ready to settle" (lease held, reconciliation done);
  - CloudTrail events on the testnet KMS key: use by another principal, a policy change, a
    scheduled deletion;
  - AWS Health task-retirement notices.
- From 0014: uptime is a Route 53 HTTPS health check.
  - Its metrics exist only in us-east-1, so the alarm and its SNS topic go in a small us-east-1
    stack subscribed to the same Slack channel.
  - The alarm needs more failing minutes than a deploy's downtime (about 6).
  - Check `/supported` once 0020 lands, `/health` before.
  - The 99% figure counts a minute as up only when the check passes and the facilitator is ready
    to settle.
- From 0014, amended by 0009 (decisions 44, 47; ADR 0011): RPC endpoints are logged and labelled
  as `RPC_URLS[i]#<fingerprint>` (`rpcEndpointName` in `logger.ts`), never by URL or host. The
  fingerprint tells an entry from the URL it replaced after a redeploy. signer-pool's
  `FallbackRpc.fromUrls` names endpoints by their full URL, which reaches `onSwitch`; name them
  with `rpcEndpointName` before wiring it to logs or metrics (0049).
- From 0009 (PR #41 reviews): the settlement counters, one `settlement_` prefix, labels from
  closed sets (0009 decision 38):
  - `settlement_outcomes_total{reason, replay}`: every `/settle` answer (this task's AC 1);
  - `settlement_already_settled_total`, `settlement_nonce_reuse_total` (counted before any check:
    forged bodies raise it, so don't page on it);
  - `settlement_refused_after_verify_total{reason, stage}`: alarm on `stage="pool"` only;
  - `settlement_budget_exhausted_total{signed}`, `settlement_uncertain_total`,
    `settlement_submit_failures_total`, `settlement_hook_failures_total{hook}`;
  - `settlement_record_failures_total`: the store-outage alarm (0009 decision 30);
  - `pool_events_total{type}`, with `status` on `resolved`, for a "pending settlements" alarm.
- From 0045 (via 0009): `/verify`'s upstream failover logs `rpc_failover` with `rpcEndpointName`
  names (`RPC_URLS[i]#<fingerprint>`). Add a `rpc_failovers_total{from,to}` counter, or an alarm on the log, since a lagging
  fallback answers valid payments with rejections (0045 decision 9). A return to the first URL
  should read as recovery, not a new outage (`rpc_failback`, info).

## Acceptance Criteria

- [ ] Given the running facilitator, when it serves traffic, then pool `onEvent` events, per-route request counts and settle outcomes are exported as metrics
- [ ] Given each alert condition: budget nearly used, breaker open, low facilitator balance (`checkFacilitatorBalance`), quarantined channel, pending settlements, when it occurs, then an alert fires on the backend chosen in 0014; each alert has been triggered once on testnet or with a fake
- [ ] Given a process that stays not ready to settle (no lease, or reconciliation unfinished) longer than the alarm window, when the alarm evaluates, then it fires (ADR 0011)
- [ ] Given `docs/monitoring.md`, when this story is done, then it lists every metric and alert
