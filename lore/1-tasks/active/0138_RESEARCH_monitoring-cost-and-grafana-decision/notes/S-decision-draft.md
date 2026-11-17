---
title: "Draft decision: Prometheus and Alertmanager on a Hetzner Cloud VM, CloudWatch for what must outlive it"
type: synthesis
status: developing
spawned_from: I-grafana-shape.md
spawns: []
tags: [monitoring, prometheus, alertmanager, grafana, cloudwatch, decision]
links:
  - R-alarm-inventory-and-reductions.md
  - R-cloudwatch-cost-measurement.md
  - R-logs-cloudwatch-or-loki.md
  - G-alarm-signals-and-triage-runbooks.md
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-13"
    status: developing
    who: claude
    note: "Draft for the team, not the decision; the ADR 0011 amendment records that"
  - date: "2026-11-17"
    status: developing
    who: claude
    note: >
      Rewritten from Grafana Cloud Free to a self-hosted stack on a separate Hetzner Cloud VM
      (option B), after comparing it with the same stack on ch-prod-01 (A) and Grafana Cloud
      Free (C). The ADR 0011 amendment is drafted on the lore-0138-alarm-signals branch.
---

# Draft decision: Prometheus and Alertmanager on a Hetzner Cloud VM, CloudWatch for what must outlive it

> Draft for the team, not the decision. The ADR 0011 amendment records the decision.

## Proposal

- **Format.** The facilitator moves to Prometheus: a `/metrics` adapter behind
  `packages/metrics-catalog`, which replaces the EMF one in the same change. New metrics go
  through the catalog either way. The `uptime-probe` and `watch` Lambdas stay on EMF.
- **The monitoring VM.** Prometheus, Alertmanager and Grafana run on a small Hetzner Cloud VM
  in Helsinki, another location than ch-prod-01 in Falkenstein.
  - A CPX12: 1 AMD vCPU, 2 GB, 40 GB NVMe, 20 TB traffic, $11.59 a month in Helsinki with its
    IPv4, before VAT, on Ubuntu 24.04. Enough for all three projects, an estimated 4,000 to 10,000
    series; a bigger plan is a rescale.
  - Provisioned with the base roles of `infra-hetzner` (base, security, users) and a monitoring
    role.
  - The Hetzner Cloud firewall and `ufw` open 443 to all and 22 to the admins. Caddy on 443
    takes metrics only with a client certificate from the ClickHouse project's CA.
  - Prometheus keeps 90 days, capped at 20 GB.
- **ch-prod-01 runs only an agent** (Prometheus in agent mode, or Alloy). It scrapes the
  facilitator's `/metrics`, node_exporter with its textfile collector for the host probe, and
  ClickHouse's own endpoint, and sends them to the VM with `remote_write`.
  - The connection is outbound, so no port opens on the server.
  - The agent's write-ahead log holds a few hours while the VM can't be reached.
- **Alerts.** The rules are generated from the catalog, as `infra/src/lib/alarms/factory.ts`
  builds the alarms today: one per check, `network` as a label.
  - Alertmanager posts to Slack through a webhook, grouped by alert and cause, so a new cause
    posts while the alert already fires, and again when it resolves.
  - On pubnet, the alerts that cost money also go to a phone route through one SNS topic, which
    does not exist yet.
  - A rule fires on the VM when ch-prod-01's agent goes quiet, with the metrics from before.
- **Grafana** shows dashboards only, provisioned from the repo, behind Cloudflare Tunnel and
  Cloudflare Access. Its own alerting is off.
- **CloudWatch keeps:**
  - the logs, so the CloudWatch agent and its Roles Anywhere chain stay
    ([logs](R-logs-cloudwatch-or-loki.md)), with `certificate`, `credentials-stale` and a
    log-delivery silence alarm;
  - `x402-watch` and its Lambda's alarms, off the server by design (ADR 0013): balance, protocol
    and uptime;
  - what watches the VM: an always-firing Watchdog rule goes through Alertmanager to AWS every
    minute and writes one metric, and a CloudWatch alarm with missing data breaching fires when
    it stops;
  - a rule on `alertmanager_notifications_failed_total`, sent through Alertmanager's SNS
    receiver, so a broken Slack webhook still reaches the channel.
- **The explorer and the Prices API** stay on CloudWatch in this decision. The VM can take them
  later ([signals](G-alarm-signals-and-triage-runbooks.md)); the explorer first needs its ADR
  0054 superseded ([inventory](R-alarm-inventory-and-reductions.md#decisions-the-move-runs-into)).

## Why

1. **Pubnet.** In CloudWatch each per-network check is one alarm per network: pubnet adds 26
   alarms and about 30 series. In Prometheus it adds alert instances, not rules.
2. **One view of the shared server.** The facilitator shares ch-prod-01 with the explorer's
   ClickHouse, which CloudWatch sees only through the host probe. The Prices API and x402 alarm on
   the same root filesystem today, about 1 pp apart.
3. **Rules in our config.** Generated from the catalog and run by us.
4. **The monitoring lives outside the server it watches.** A fault, a full disk or a reboot of
   ch-prod-01 is an alert from the VM, with the metrics from before it. On ch-prod-01 itself (A)
   the monitoring would stop with it; the explorer's ADR 0054 rejected that shape as "partially
   inside the system it observes".
5. **Not cost.** x402's CloudWatch is about $21 a month at today's inventory
   ([measurement](R-cloudwatch-cost-measurement.md)), and the VM costs about the same as A's
   saving would be worth.

## What it costs

|                  | Today | After 0139                                                                                                          |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| CloudWatch, x402 | ~$21  | ~$5: `x402-watch` (6 metrics, 10 alarms), the heartbeat, the certificate, credentials and log-delivery alarms, logs |
| Monitoring VM    | —     | $11.59 a month before VAT (CPX12 with IPv4), for every project on ch-prod-01                                        |

Target for 0139: **x402's CloudWatch at or under $8 a month, with the VM on CPX12.**

Across the account, the [signals plan](G-alarm-signals-and-triage-runbooks.md) estimates
CloudWatch at about $62.80 → $8.50 a month, plus about $4–5 of reads, once the Prices API and the
explorer follow.

## Order (0139)

1. The ADR 0011 amendment, agreed by the team.
2. The VM: a Hetzner Cloud project, the base roles, the monitoring role, Caddy with mTLS, the
   firewall.
3. The Prometheus adapter: counters pre-set to 0 for every closed label value, a
   last-successful-read timestamp per gauge, and a liveness series written after start.
4. The 22 log-only fields: each becomes a label or moves to the app line
   ([shape](I-grafana-shape.md#what-the-emf-lines-carry-that-a-series-wont)).
5. The agent next to the CloudWatch agent on ch-prod-01, with Oskar's agreement. The host probe
   writes textfiles, with counter files for its one-off events and an mtime rule per file.
6. Rules generated from the catalog: one per check with `network` as a label, and the Event
   alarms as one rule. Alertmanager's routes, the heartbeat and the failed-notification rule.
7. The switch, in one change: the rules go on, and the EMF adapter and the old CloudWatch alarms
   go off. No period with both (decided 2026-11-17). Every rule is drilled once right after the
   switch, and one that fails its drill is fixed forward.

## Still open

- The series count, to size the VM: one day of the agent, with ClickHouse's endpoint on all four
  metric families.
- The repeat interval for standing alerts (Alertmanager's `repeat_interval`).
- Who creates the Hetzner Cloud project and pays for it.
- The phone route for pubnet's money alerts: no SNS topic for it exists today.
- The proposed numbers: a 15 s scrape and a 20 GB retention cap.
- `snapshot_age_seconds` still reads the 1e9 sentinel although the snapshot timer is installed.
  0026 checks why before the age rule.

## Alternatives

- **The same stack on ch-prod-01 (A).** $0, on capacity already paid. The monitoring would stop
  with every fault, full disk and reboot of the server it watches, and the metrics from the
  outage would be lost. Moving from B to A, or back, changes only the agent's `remote_write`
  target.
- **Grafana Cloud Free (C).** $0 and off the server, but 10,000 active series, 14 days of
  history, 100 alert rules, 3 people a month for a team of four, and a second vendor. The
  fallback if nobody runs the VM.
- **Cut CloudWatch only.** About $22 a month across the account, nearly all of it the explorer's
  and the Prices API's; x402's own part is about $1. Pubnet still doubles the facilitator's alarms.
- **All three projects to the VM now.** Blocked by the explorer's ADR 0054. The Prices API's
  inventory has to be read from its `develop`, and the other projects' Lambda counters and log
  filters need a source the VM can read.
- **The logs to Loki too.** Not for Milestone 2 ([logs](R-logs-cloudwatch-or-loki.md)).
