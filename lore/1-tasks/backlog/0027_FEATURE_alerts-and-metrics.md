---
id: "0027"
title: "Alerts and metrics"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007", "0011"]
related_tasks: ["0012", "0014", "0024", "0026", "0020", "0009", "0045", "0049", "0039"]
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
  - date: "2026-10-20"
    status: backlog
    who: okarcz
    note: "0047 (ADR 0013 amended): the low-balance alarm at 25 XLM as a Slack message, and a CloudTrail alarm on reads of the backup secret."
  - date: "2026-10-22"
    status: backlog
    who: stkrolikiewicz
    note: "0039: the uptime check targets the Cloudflare Tunnel hostname on sorobanscan.com."
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
- From 0039 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md), revised): the backend is CloudWatch, fed from the
  Hetzner server.
  - Docker keeps our containers' logs on the host (`json-file`, rotated), and the CloudWatch
    agent sends them on with the logs-and-metrics role's credentials from IAM Roles Anywhere. Only
    the agent holds them, so `dockerd` stays untouched and an AWS outage never stops a container.
    Decide how the agent picks only our containers' files.
  - The adapter writes Embedded Metric Format lines to stdout (namespace `x402-facilitator`).
    Dimensions stay low-cardinality (`network`, route, outcome, event name), never payer or
    `payTo`, and the adapter emits only listed fields. Check once that extraction works on the
    agent's path.
  - The CloudWatch agent on the server reports memory, CPU and free disk, since ClickHouse shares
    the machine.
- From 0039: alarms go through SNS and Amazon Q Developer in chat applications to the team's
  Slack channel. Besides the five AD-18 conditions:
  - "ready to settle" (lease held, reconciliation done);
  - from ADR 0013: OpenBao sealed, down or failing to sign; theft (below, from 0047); and
    OpenBao's audit log disk at 80%;
  - WAL archiving failing: `pg_stat_archiver.failed_count` rising, or the last archived segment
    older than 10 minutes, since a stuck archive fills a disk ClickHouse shares;
  - the last WAL segment shipped off the server older than 30 minutes, or the last OpenBao
    snapshot older than 26 hours (they run daily);
  - the Roles Anywhere certificate expiring within 30 days;
  - low free disk and memory on the server.
- From 0014: uptime is a Route 53 HTTPS health check.
  - Its metrics exist only in us-east-1, so the alarm and its SNS topic go in a small us-east-1
    stack subscribed to the same Slack channel.
  - The alarm needs more failing minutes than a deploy's worst downtime, which includes the
    migrations and the wait for `ready` (ADR 0011's Consequences). It fires after 7 failing
    minutes in a row; ADR 0011 gives the reasoning.
  - Check `/supported` once 0020 lands, `/health` before, at
    `x402-facilitator-testnet.sorobanscan.com` (Cloudflare Tunnel, ADR 0011), so a Cloudflare
    or tunnel outage counts as downtime.
  - The 99% figure counts a minute as up only when the check passes and the facilitator is ready
    to settle.
  - From 0020: `/supported` answers an object fixed at startup, so its 200 shows only that the
    process is up, not that the RPC answers or the channels can settle. Readiness to settle needs
    a check of its own, such as `/health` (0026).
  - From 0020: a process whose startup check fails (an RPC down, a channel another key can move)
    exits with `startup_failed` and is restarted in a loop; it never becomes ready, so the
    readiness alarm (criterion 3) must cover it.
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
- From 0047 ([ADR 0013](../../../docs/adr/0013-facilitator-key-custody.md), amended 2026-10-20):
  - **Low balance:** the fee account's spendable balance below 25 XLM (float 100 XLM), as a Slack
    message. Decide here where the check runs (in the facilitator, or off the server, e.g. a
    scheduled job reading Horizon, which still fires when the server is down) and what the message
    says (network, balance, the fee account's address, the runbook's top-up step).
  - **Theft:** a transaction with the fee account or a channel as its source or fee source whose
    hash our submitter didn't record, and any signer or threshold change on those accounts, read
    from Horizon (`/accounts/{id}/transactions`). It runs off the server, since root on the server
    is the case it is for. Decide here how it gets our hashes: they sit in the server's database,
    where root could forge them; the signer check doesn't need them.
  - **Reads of the backup secret:** `GetSecretValue` on `x402/production/openbao-backup` outside a
    drill. The shared AWS account has no CloudTrail trail today, so this needs one; until then the
    drill checks the 90-day event history.
  - ADR 0011's "Slack is not a pager" still holds for money alerts on mainnet.

## Acceptance Criteria

- [ ] Given the running facilitator, when it serves traffic, then pool `onEvent` events, per-route request counts and settle outcomes are exported as metrics
- [ ] Given each alert condition: budget nearly used, breaker open, low facilitator balance (`checkFacilitatorBalance`), quarantined channel, pending settlements, when it occurs, then an alert fires on CloudWatch (ADR 0011); each alert has been triggered once on testnet or with a fake
- [ ] Given a process that stays not ready to settle (no lease, or reconciliation unfinished) longer than the alarm window, when the alarm evaluates, then it fires (ADR 0011)
- [ ] Given `docs/monitoring.md`, when this story is done, then it lists every metric and alert
