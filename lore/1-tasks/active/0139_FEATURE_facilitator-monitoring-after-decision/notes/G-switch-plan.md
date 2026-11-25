---
title: "The switch (step 7): what changes, in what order, and how each rule is drilled"
type: generation
status: developing
tags: [monitoring, switch, drill]
links:
  - ../../../../../docs/monitoring.md
  - ../../../../../deploy/metrics/rules/x402-production.yml
history:
  - date: 2026-11-24
    status: seed
    who: claude
    note: "Plan drafted with stkrolikiewicz after the heartbeat went on"
  - date: 2026-11-24
    status: developing
    who: claude
    note: "Adam's review of #240: playbook before image, the window, the drill's network, what stays"
  - date: 2026-11-25
    status: developing
    who: claude
    note: "Oskar's review of #240: pool-health's drill at 5, 19 Event messages, agent-behind's row"
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

Four changes. #228 is merged; the other three are the switch itself and go the same day.

| # | Change | Where | Ships by |
|---|--------|-------|----------|
| 0 | #228: Event rules fire after a restart and within a period | stellar-x402 | merged 2026-11-24 |
| 1 | #241: the facilitator serves Prometheus on `/metrics`, not EMF; it joins the `x402-metrics` network and the agent scrapes it | stellar-x402 `apps/facilitator`, `deploy/` | the playbook (`compose.yaml`, `x402@.service`, the agent's `prometheus.yml`), then the deploy by digest (the image) |
| 2 | soroban-infrastructure#20: the rules on the VM, `x402-production.yml` at a pinned stellar-x402 commit and checksum | soroban-infrastructure | a commit setting the pin, then its playbook `--tags monitoring` |
| 3 | #242: CloudWatch keeps only the 18 alarms that stay (`route()` in `rules.ts`); 31 are deleted. Adds `agent-behind` | stellar-x402 `infra/` | `make deploy-production-alarms`, agreed with the explorer team |

**Order on the day**, in working hours, announced in `#stellar-x402-bot`:

1. Merge #241. Run ch-prod-01's playbook **first**, then the deploy by digest. Only the image goes
   by digest; the deploy's gate (`x402-deploy`) probes `/health` on 4021 alone, and the playbook's
   copy of `compose.yaml` notifies nothing. The image first would give a facilitator that writes
   neither EMF nor `/metrics` while the deploy reports success (Adam's review of #240).
2. Check on the VM: `up{job="facilitator"} == 1`, and every selector in `x402-production.yml`
   returns a series with no `drill` label. Every counter the rules read is a zero series from the
   start (369 series in 37 families, 28 KB a scrape at #241's head), and `x402-gauge-stale`'s
   `absent()` branches cover the gauges.
3. Merge #242, then the pin commit in soroban-infrastructure (from `develop` with #242 in) and its
   playbook: the rules are on.
4. `make deploy-production-alarms`: the 31 alarms go. Then `make fire-test`.

**The window between 1 and 3.** Nothing watches the facilitator's metrics: CloudWatch has no data
and the rules aren't on the VM. Acceptable with only testnet in production, and kept to one
playbook run by having soroban-infrastructure#20 merged before the day. CloudWatch's
`facilitator-silent` breaches on missing data after 15 minutes, so if steps 2 and 3 take longer it
posts to Slack: expected, not an outage.

**The point of no return is step 4.** Until then a failed or unwanted change 1 goes back to
`digest.good`, the old image, which writes EMF again while the CloudWatch alarms still exist, and
the pin is emptied on the VM. After step 4 the way back is a redeploy of the Alarms stack from
before #242.

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

- `snapshots` and `backups` as Prometheus rules only, proposed to Oskar on 2026-11-24 (#240); Adam
  agrees. A CloudWatch alarm on a host probe metric after the switch would go against `route()`
  and the cost target, and a flag turned on before it makes an alarm change 3 then deletes.
- The split (Adam's): 0139 delivers the rules and the drill method; 0026 turns each flag on and
  records its drill, `snapshots` after OpenBao's first good snapshot (at 1e9 the rule fires at
  once), `backups` once pgBackRest runs. So `backups`' drill isn't 0139's AC 2.
- One flag drives both sinks: before change 3, turning a group on also makes its CloudWatch alarm.

## The drill

Every rule fires once the same day, in Slack, with its `check`, `severity` and description, and
resolves. Recorded in `docs/monitoring.md` as the 2026-11-09 drills are.

The one tool for most of them: **a drill textfile on ch-prod-01**. node_exporter's textfile
collector exposes any metric name, and the rules match on name and `project`, not on `job`. A
file `/var/lib/x402/textfile/drill.prom` with a fake series fires the rule; removing it ends it.
Each fake series carries `drill="1"` and **its own network, `network="drill"`**: every
aggregation here is `by (network)`, which drops `drill`, so under the real network a `min by`
rule would take the real series' 0 (Adam's review of #240). Slack then shows `drill` as the
network. For a counter, write 0, wait one scrape (15 s), then 1. `textfile-stale` reads this file
too: keep its mtime fresh or end within 5 minutes.

| Rule / check | How | Notes |
|---|---|---|
| `x402-facilitator-silent` | stop window: `systemctl stop x402@production` | fires after 10 min |
| `x402-gauge-stale` | drill textfile: a last-read stamp 1000 s old, `network="drill"`, while the process runs | the rule is gated on the liveness series, so the stop window doesn't fire it (found 2026-11-25) |
| `x402-sweeps-stopped` | drill textfile: a flat `settlement_sweeps_total{network="drill",outcome="listed",drill="1"} 0` | the stop window doesn't fire it: no `absent()` branch, and a stopped series leaves `increase()` above 1, then nothing |
| `x402-server-silent` | stop `x402-metrics` past 5 min | real; stopping the node-exporter alone restarts the whole agent in 5 s (`--abort-on-container-exit`) |
| `x402-target-down` | the stop window (`job` facilitator) | real |
| `x402-textfile-stale` | stop `x402-host-probe.timer` past 5 min | real |
| `x402-agent-behind` | `promtool test rules` scenario, not fired live: a lag over 2 minutes fires it, samples the VM refused fire it, the 11 s lag read on the VM's live data stays quiet | no live drill: the agent's `prometheus_remote_storage_*` series reach the VM only through the sends they measure, so an unreachable `remote_write` URL leaves the VM nothing to read and fires `server-silent` instead (Oskar's review of #240). The scenario: `deploy/metrics/rules/agent-behind.test.yml` (#242), in CI's `prometheus-rules` |
| `x402-rpc-stalled`, `x402-balance-stale`, `x402-pending`, `x402-queue-waiting`, `x402-channel-quarantined`, `x402-rpc-on-fallback` | drill textfile, the gauge past its threshold for its `for`, `network="drill"` | `queue-waiting` and `rpc-on-fallback` are `min by (network)`: they need the own network |
| `x402-openbao-down` | drill textfile, `openbao_up{drill="1"} 0` | a plain `min`, so the real 1 doesn't hide it |
| `x402-event`, 19 checks | drill textfile, each counter 0 then 1, `network="drill"`; `pool-health`'s `pool_events_total{type="sequence-resync"}` 0 then 5 within 5 minutes, since it fires at 5 resyncs, not 1 | one file for all; 19 Slack messages, one per check: the expression has 20 branches, and `store-outage` takes two counters (`settlement_record_failures_total`, `spend_store_failures_total`) into one message (Oskar's review of #240) |
| `x402-disk-root`, `x402-memory` | not fired live: `promtool test rules` scenario | as CloudWatch's `memory` (2026-11-09) |
| `x402-agent-certificate` | not fired live: the real days left | as `certificate` |
| `NotificationsFailed`, `Watchdog`, heartbeat | done 2026-11-24 | |

**The 18 alarms that stay in CloudWatch.** Change 3 deletes the others and changes none of these
(the diff's only `[~]` is `watch-errors`' description), so their drills of 2026-11-06 and
2026-11-09 stand: same metric, threshold, statistic and action. One `make fire-test` after step 4
shows the topic's path to Slack still works, as after every deploy of the alarms (decision 12).

Every fake point stays in the VM's history, as CloudWatch's did: name the window in the drill
entry.

## Open

- The cost check (AC 1) starts the day after: a week of the bill, scaled to a month.
- Whether `host` EMF lines keep `x402-host` alive for the three alarms that stay (`audit-disk`,
  `certificate`, `credentials-stale`): the probe writes both today, so yes, until a later task
  moves them.
- For mainnet (Adam, #240): about 20 minutes with no Prometheus rule paging anyone, the `critical`
  ones included, is what the heartbeat gives today. Shorter alarm periods before mainnet, or
  accepted: 0151's to settle.
