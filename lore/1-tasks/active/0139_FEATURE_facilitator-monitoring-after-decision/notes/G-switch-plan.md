---
title: "The switch (step 7): what changes, in what order, and how each rule is drilled"
type: generation
status: seed
tags: [monitoring, switch, drill]
links:
  - ../../../../../docs/monitoring.md
  - ../../../../../deploy/metrics/rules/x402-production.yml
history:
  - date: 2026-11-24
    status: seed
    who: claude
    note: "Plan drafted with stkrolikiewicz after the heartbeat went on"
---

# The switch (step 7)

## Where it stands (2026-11-24)

> Done: the VM, Prometheus with `remote_write` in, Alertmanager to Slack, the heartbeat (topic,
> alarm `x402-production-monitoring-heartbeat` on since 12:48 UTC, Watchdog every minute), the
> agent on ch-prod-01, the host probe's textfiles, the generated rules (#211), the Event fixes
> (#228, in review).

What the VM receives today: only `job="node"` (node_exporter with the probe's textfiles) and
`job="agent"`. The facilitator writes no Prometheus series yet:
`apps/facilitator/src/adapters/prometheus-metrics.ts` exists, but `main()` still wires
`emfMetrics`, and the agent doesn't scrape it (`deploy/metrics/prometheus.yml`). The rule file
isn't on the VM (`/opt/monitoring/rules/` holds only `vm.yml`).

CloudWatch today: 50 `x402-production-*` alarms (22 on `x402-facilitator`, 8 `x402-host`,
8 `x402-watch`, 6 metric math, 4 `AWS/Logs`, 1 `AWS/Lambda`, 1 `AWS/SNS`).

## What the switch is made of

Four changes. Only the last three are the switch itself, and they go the same day.

| # | Change | Where | Ships by |
|---|--------|-------|----------|
| 0 | #228 merged (Event rules fire after a restart and within a period) | stellar-x402 | merge |
| 1 | The facilitator writes Prometheus, not EMF: `main()` wires the Prometheus adapter, serves `/metrics`, calls `markStarted()`; `emfMetrics` and its timers go. The facilitator joins the `x402-metrics` network, and the agent scrapes it | stellar-x402 `apps/facilitator`, `deploy/production/compose.yaml`, `deploy/metrics/prometheus.yml` | CI deploy by digest, the agent by the playbook |
| 2 | The rules on the VM: `x402-production.yml` into `/opt/monitoring/rules/`, from a pinned commit of stellar-x402 (get_url with checksum, or a copy in soroban-infrastructure) | soroban-infrastructure | playbook `--tags monitoring` |
| 3 | CloudWatch keeps only what stays: the Alarms stack builds only the rows `buildRules` skips with a "stays" reason (`STAYS`, `telemetry-silent`, the `x402-watch` and `AWS/*` rows). The rest are deleted | stellar-x402 `infra/` | `make deploy-production-alarms` |

Order on the day: 1 first (series arrive, nothing alarms on them yet), check them on the VM, then
2 and 3 back to back. The gap between 2 and 3 is minutes, so no period runs both for long (0138:
no overlap).

## Karol's points for the switch (#211)

1. The split lives only in `rules.ts` (`STAYS`, `REPLACED`). Change 3 reads it from there, so the
   switch turns off exactly what moved. A test: every CloudWatch alarm after the switch is in
   `skipped` with a "stays" reason, and every rule's check is absent from CloudWatch.
2. No rule reads `prometheus_remote_storage_*`. Add one on the VM's side: the agent's failed
   sends or its growing backlog (`prometheus_remote_storage_samples_failed_total`,
   `prometheus_remote_storage_highest_timestamp_in_seconds` against `..._queue_highest_sent_timestamp_seconds`).
   `server-silent` already covers a dead agent; this covers a live agent that can't send.
3. `docs/monitoring.md`'s `facilitator-silent` and `gauges-silent` sections describe CloudWatch.
   Rewrite them for `x402-facilitator-silent` and `x402-gauge-stale` with change 3.

## The groups the switch turns on

- `snapshots` (`snapshot-age`), proposed to Oskar on 2026-11-24 to move from 0026 here, not yet
  agreed: its flag goes on in change 3, after OpenBao's first good snapshot. With
  `snapshot_age_seconds` at 1e9 the rule fires at once.
- `backups` (`backup-age`, `wal-failing`, `wal-stale`): under the same proposal, Oskar turns it on
  once pgBackRest runs, as rules only.
- One flag drives both sinks: before change 3, turning a group on also makes its CloudWatch alarm.

## The drill

Every rule fires once the same day, in Slack, with its `check`, `severity` and description, and
resolves. Recorded in `docs/monitoring.md` as the 2026-11-09 drills are.

The one tool for most of them: **a drill textfile on ch-prod-01**. node_exporter's textfile
collector exposes any metric name, and the rules match on name and `project`, not on `job`. A
file `/var/lib/x402/textfile/drill.prom` with a fake series fires the rule; removing it ends it.
Each fake series carries `drill="1"`, so it never collides with a real one, and the rules' `sum by`
and `max by` don't keep that label. For a counter, write 0, wait one scrape (15 s), then 1.
`textfile-stale` reads this file too: keep its mtime fresh or end within 5 minutes.

| Rule / check | How | Notes |
|---|---|---|
| `x402-facilitator-silent` | stop window: `systemctl stop x402@production` | fires after 10 min; also `sweeps-stopped` |
| `x402-sweeps-stopped` | the same stop window | real |
| `x402-gauge-stale` | the same stop window (last-read stamps stop) | real |
| `x402-server-silent`, `x402-target-down` | stop the agent's node-exporter (`x402-metrics`) | real |
| `x402-textfile-stale` | stop `x402-host-probe.timer` past 5 min | real |
| `x402-rpc-stalled`, `x402-balance-stale`, `x402-pending`, `x402-queue-waiting`, `x402-channel-quarantined`, `x402-rpc-on-fallback` | drill textfile, gauge past its threshold for its `for` | `network="stellar:testnet"` only |
| `x402-openbao-down` | drill textfile, `openbao_up{drill="1"} 0` | |
| `x402-event`, 20 checks | drill textfile, each counter 0 then 1 | one file for all; one Slack message per check |
| `x402-disk-root`, `x402-memory` | not fired live: `promtool test rules` scenario | as CloudWatch's `memory` (2026-11-09) |
| `x402-agent-certificate` | not fired live: the real days left | as `certificate` |
| `NotificationsFailed`, `Watchdog`, heartbeat | done 2026-11-24 | |

Every fake point stays in the VM's history, as CloudWatch's did: name the window in the drill
entry.

## Open

- **Change 1 is code with a review**, not config. It is the biggest piece and decides the date.
- How the rule file reaches the VM (change 2): pinned download or a copy.
- Whether `host` EMF lines keep `x402-host` alive for the three alarms that stay (`audit-disk`,
  `certificate`, `credentials-stale`): the probe writes both today, so yes, until a later task
  moves them.
- The cost check (AC 1) starts the day after: a week of the bill, scaled to a month.
