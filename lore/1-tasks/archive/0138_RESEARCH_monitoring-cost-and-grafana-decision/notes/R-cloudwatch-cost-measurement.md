---
title: "What CloudWatch costs, and which project it costs for"
type: research
status: developing
spawns: []
tags: [monitoring, cloudwatch, cost, measurement]
links:
  - I-grafana-shape.md
history:
  - date: "2026-11-12"
    status: developing
    who: stkrolikiewicz
    note: "Invoice from Cost Explorer and inventory from the CloudWatch API, both read on 2026-11-12"
---

# What CloudWatch costs, and which project it costs for

AWS account 750702271865 holds the explorer, the Prices API and the facilitator together, so the
CloudWatch bill is for all three. Read on 2026-11-12 with read-only access.

## The invoice

Cost Explorer on the payer account, service CloudWatch, filtered to account 750702271865, split
by usage type, before tax:

| Month         | Total   | Custom metrics | Alarms | Rest                                          |
| ------------- | ------- | -------------- | ------ | --------------------------------------------- |
| August        | $16.85  | $13.28         | $3.56  | —                                             |
| September     | $30.42  | $21.79         | $5.83  | dashboards $2.75                              |
| October       | $42.34  | $26.26         | $9.98  | dashboards $3.00, vended logs $1.46, API $1.42 |
| 1–11 November | $13.82  | $9.06          | $3.67  | dashboards $1.09                              |

- In October, custom metrics and alarms were 86% of the CloudWatch bill. Log ingestion and
  storage were under $2.
- CloudWatch was 12.8% of the account's October bill ($330.76 with tax).
- November runs at about $38 per 30 days. It is still below what today's inventory costs,
  because metrics and alarms are billed pro rata by the hours they exist, and the facilitator's
  alarms were added during the month.

## The inventory

From `list-metrics` and `describe-alarms` in eu-central-1. us-east-1 has none of either.

| Project  | Custom metrics                                                                   | Alarms | On AWS/* metrics | On custom metrics |
| -------- | -------------------------------------------------------------------------------- | ------ | ---------------- | ----------------- |
| Prices   | 66 (Rollup 30, Enrichment 19, Oracle 8, Mtls 3, Backfill 2, Coverage 2, Ingest 2) | 87     | 33               | 54                |
| x402     | 54 (`x402-facilitator` 36, `x402-host` 12, `x402-watch` 6)                       | 49     | 6                | 43                |
| Explorer | 45 (Container Insights 38 for cluster `production-ingestion`, indexer 7)           | 19     | 15               | 4                 |
| Total    | 165                                                                              | 155    | 54               | 101               |

Alarms are attributed by name and by the namespaces they read. The facilitator's six alarms on
AWS/* metrics are four on `AWS/Logs` (EMF parsing, EMF validation and two log-volume alarms) and two
on `AWS/Lambda` (the watch Lambda's errors and invocations).

## What it costs per project

The rates on the invoice are $0.30 a metric-month and $0.10 an alarm-month, with 10 of each free per
account. At today's inventory:

| Project  | Metrics | Alarms | A month |
| -------- | ------- | ------ | ------- |
| Prices   | $19.80  | $8.70  | ~$28.5  |
| x402     | $16.20  | $4.90  | ~$21.1  |
| Explorer | $13.50  | $1.90  | ~$15.4  |

The free tier takes about $4 off the total, and dashboards add about $3. That puts the account's
ceiling at about $64 a month.

Two qualifications:

- An alarm on a metric-math expression is billed for each metric it reads, so alarm costs run a
  little above the count times $0.10.
- At the Milestone 2 plan's $2,600 per dev-week, the whole account's CloudWatch spend takes about
  3.5 years to repay one dev-week of migration.

## What this does not show

- **No split of the bill by project.** CloudWatch metrics and alarms take no cost-allocation
  tags, so Cost Explorer cannot split the bill by project. The per-project figures are the
  inventory times the invoice's rates, not invoiced amounts.
- **The uptime probe is only partly covered.** It is billed as Lambda, not CloudWatch, and that
  part was not measured. Its metrics and alarms are in the counts above.
- **Logs are not split by project.** At under $2 a month for the whole account, the split was not
  worth making.
