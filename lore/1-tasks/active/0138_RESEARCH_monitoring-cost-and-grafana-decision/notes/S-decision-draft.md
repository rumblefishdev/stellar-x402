---
title: "Draft decision: Grafana for what runs on the Hetzner server, CloudWatch for the rest"
type: synthesis
status: developing
spawned_from: I-grafana-shape.md
spawns: []
tags: [monitoring, grafana, cloudwatch, decision]
links:
  - R-alarm-inventory-and-reductions.md
  - R-cloudwatch-cost-measurement.md
  - R-logs-cloudwatch-or-loki.md
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-13"
    status: developing
    who: claude
    note: "Draft for the team, not the decision; the ADR 0011 amendment records that"
---

# Draft decision: Grafana for what runs on the Hetzner server, CloudWatch for the rest

> Draft for the team, not the decision. The ADR 0011 amendment records the decision.

## Proposal

- **Format.** The facilitator moves to Prometheus: a `/metrics` adapter behind
  `packages/metrics-catalog`, beside the EMF one until the cut-over. New metrics go through the
  catalog either way. The `uptime-probe` and `watch` Lambdas stay on EMF.
- **Grafana Cloud Free** alerts on the facilitator, the Hetzner host (Alloy's built-in node
  exporter and its textfile collector) and, later, ClickHouse. The rules are generated from the
  catalog, as `infra/src/lib/alarms/factory.ts` builds the alarms today.
- **CloudWatch keeps:**
  - the logs, so the CloudWatch agent and its Roles Anywhere chain stay
    ([logs](R-logs-cloudwatch-or-loki.md)), with `certificate`, `credentials-stale` and a
    log-delivery silence alarm;
  - `x402-watch` and its Lambda's alarms, off the server by design (ADR 0013): balance, protocol
    and uptime;
  - what watches Grafana: an always-firing Watchdog rule posts to a Lambda function URL that writes
    one metric, and a CloudWatch alarm with missing data breaching fires when the posts stop.
- **The explorer and the Prices API** stay on CloudWatch in this decision. Moving them is not
  planned here and is not this project's work. It needs the explorer's ADR 0054 superseded first
  ([inventory](R-alarm-inventory-and-reductions.md#decisions-the-move-runs-into)).

## Why

1. **Pubnet.** In CloudWatch each per-network check is one alarm per network: pubnet adds 26
   alarms and about 30 series. In Grafana it adds alert instances, not rules.
2. **One view of the shared server.** The facilitator shares ch-prod-01 with the explorer's
   ClickHouse, which CloudWatch sees only through the host probe. The Prices API and x402 alarm on
   the same root filesystem today, about 1 pp apart.
3. **Rules in our config.** Generated from the catalog, the rules answer ADR 0011's objection to
   Grafana Cloud Free.
4. **Not cost.** x402's CloudWatch is about $21 a month at today's inventory
   ([measurement](R-cloudwatch-cost-measurement.md)).

## What it costs

|                  | Today | After the cut-over                                                                                                  |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| CloudWatch, x402 | ~$21  | ~$5: `x402-watch` (6 metrics, 10 alarms), the heartbeat, the certificate, credentials and log-delivery alarms, logs |
| Grafana Cloud    | —     | $0 on Free while up to 3 people log in a month; Pro is $19 plus $8 a person over 3                                  |

Target for 0139: **x402's CloudWatch at or under $8 a month, with Grafana on Free.** If a fourth
person needs to log in, Pro (about $27) is the team's call, not a miss for 0139.

## Order (0139)

1. The ADR 0011 amendment, agreed by the team.
2. The Prometheus adapter: counters pre-set to 0 for every closed label value, a
   last-successful-read timestamp per gauge, and a liveness series written after start.
3. The 22 log-only fields: each becomes a label or moves to the app line
   ([shape](I-grafana-shape.md#what-the-emf-lines-carry-that-a-series-wont)).
4. Alloy next to the CloudWatch agent. The host probe writes textfiles, with counter files for its
   one-off events and an mtime rule per file.
5. Rules generated from the catalog: one per check with `network` as a label, and the Event
   alarms as one rule.
6. Every rule drilled once. An old alarm goes off only after its replacement has fired.

## Still open

- One day of Alloy on a free stack, to count series. ClickHouse's endpoint has all four metric
  families on.
- The repeat interval for the facilitator's rules. Grafana repeats a standing alert every 4 hours
  by default.
- Who logs in: the free plan counts 3 active users a month, and the team is four.
- `snapshot_age_seconds` still reads the 1e9 sentinel although the snapshot timer is installed.
  0026 checks why before the age rule.

## Alternatives

- **Cut CloudWatch only.** About $22 a month across the account, nearly all of it the explorer's
  and the Prices API's; x402's own part is about $1. Pubnet still doubles the facilitator's alarms.
- **All three projects to Grafana now.** Blocked by the explorer's ADR 0054. The Prices API's
  inventory has to be read from its `develop`, and the other projects' Lambda counters and log
  filters have no Grafana source without a rewrite.
- **Our own Grafana on a Hetzner Cloud VM.** One more server to patch, back up and watch
  ([shape](I-grafana-shape.md)).
- **The logs to Loki too.** Not for Milestone 2 ([logs](R-logs-cloudwatch-or-loki.md)).
