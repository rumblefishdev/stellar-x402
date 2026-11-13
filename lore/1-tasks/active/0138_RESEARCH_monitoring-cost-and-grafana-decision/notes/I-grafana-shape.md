---
title: "If Grafana, the smallest shape that pays its way"
type: idea
status: developing
spawns: []
tags: [monitoring, grafana, cloudwatch]
links:
  - R-cloudwatch-cost-measurement.md
  - R-logs-cloudwatch-or-loki.md
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-12"
    status: developing
    who: stkrolikiewicz
    note: "Proposal for the decision, not the decision; the ADR 0011 amendment records that"
  - date: "2026-11-13"
    status: developing
    who: stkrolikiewicz
    note: "The CloudWatch agent stays for logs; the log-only fields are a step before the cut-over"
---

# If Grafana, the smallest shape that pays its way

## Cost is not the argument

The facilitator's CloudWatch costs about $21 a month, and the whole account about $64 (see
[the measurement](R-cloudwatch-cost-measurement.md)). Most of the spend that can be cut is in the
other two projects, and cutting it needs no migration:

- **Container Insights on the explorer's Galexie cluster.** 38 metrics, about $11 a month. Before
  turning it off, check that no Galexie memory alarm reads it.
- **Prices/Rollup.** 30 metrics, about $9 a month. Its dimensions are worth reviewing.
- **Prices' 87 alarms.** Worth checking for duplicates.

That work belongs to the explorer and the Prices API, not to this project.

A move to Grafana is worth making for something else. The facilitator shares the company Hetzner
server with the explorer's production ClickHouse (ADR 0011), and CloudWatch sees that server only
through its agent. One view of the server, ClickHouse and the facilitator is the gain.

## The shape

- **Grafana Cloud Free, not our own Grafana.**
  - Our own Grafana on a separate Hetzner Cloud VM costs a few euros a month. It is also one more
    server to patch and back up, and it needs its own watcher.
  - Grafana Cloud's alerting runs outside our infrastructure. An absent-data rule on the agent then
    serves as the Hetzner server's heartbeat.
- **Alloy for metrics on the Hetzner server, next to the CloudWatch agent.** The CloudWatch agent
  stays for logs, and its Roles Anywhere chain with it ([logs](R-logs-cloudwatch-or-loki.md)). Alloy
  is one process with node_exporter built in (`prometheus.exporter.unix`), so no separate exporter
  runs. It collects from three sources:
  - the facilitator's `/metrics`. It is a long-running process, so it can be scraped;
  - the host's own metrics, through the built-in exporter;
  - ClickHouse's built-in Prometheus endpoint. That endpoint is the explorer's and the Prices
    API's way in later, at almost no extra work.
- **Alert rules as code.** This answers ADR 0011's objection that the rules would sit outside our
  config. Generate the rules from the same catalog that feeds `infra/src/lib/alarms/factory.ts`
  today, through Grafana's Terraform provider or file provisioning.
- **What watches Grafana from outside.** The existing `uptime-probe` Lambda and its CloudWatch alarm
  stay as they are.
- **Hybrid, not a full move.**
  - Alarms on AWS/* metrics stay in CloudWatch. Polling them from Grafana costs `GetMetricData`
    calls and adds nothing. For the facilitator that is two alarms on `AWS/Lambda`. Its four
    `AWS/Logs` alarms split: the two on EMF parsing and validation go with EMF, and the two on log
    volume stay while logs do.
  - Logs stay in CloudWatch: one place for all of them, 30 days, and the client IP in our account
    ([logs](R-logs-cloudwatch-or-loki.md)).
  - Both systems post to the same Slack channel.

## The format risk is smaller than it reads

The facilitator writes every metric through the typed `packages/metrics-catalog` and one adapter,
`apps/facilitator/src/adapters/emf.ts` (with `emf-metrics.ts`). Moving to Prometheus means a new
adapter, not rewriting metrics. Metrics that other Milestone 2 work adds before the decision are
safe as long as they go through the catalog.

The other EMF writers do not go through that adapter. Each needs its own answer:

- **The `uptime-probe` and `watch` Lambdas** cannot be scraped. They either push over OTLP or stay
  on EMF, since they write only a few metrics.
- **The host probe** (`deploy/libexec/x402-host-probe`) writes EMF to a file that the CloudWatch
  agent reads. Under Alloy it would write a textfile that the built-in exporter's textfile collector
  reads.

## What the EMF lines carry that a series won't

22 of the catalog's 62 metrics carry labels that are log fields only (`fields` in
`packages/metrics-catalog`): in no dimension set, so not billed, and readable only in the EMF line
through Logs Insights. Two readers depend on them:

- **The weekly fee review** reads a week of metric lines (0027 decision 18). `fee_charged_stroops`
  keeps its `state` as such a field.
- **The runbook's pool-event queries** filter `/x402/production/metrics` on `type`, a dimension
  only for `sequence-resync` (`docs/monitoring.md`, the `fee-raised` and `send-retry` counts).

A Prometheus series keeps only its labels, so these fields go when the metric lines stop. Before
the cut-over, each field either becomes a label, if its values are few and closed and the series
fit the free tier, or goes into the facilitator's app line, which stays in CloudWatch. The pool's
events are 0125's work, which then lands before the cut-over.

## To check before deciding

- **Series count against the free tier's active-series limit.** ClickHouse exposes many metrics.
  A one-day spike, with Alloy on the server sending to a free stack, gives the real number.
- **Retention.** The free tier keeps 14 days, while CloudWatch keeps 15 months.
- **Users.** The free tier's user limit, against the size of the team that gets paged.

Confirm the free tier's limits on Grafana's current pricing page. The figures above are from
memory, not read on the measurement date.
