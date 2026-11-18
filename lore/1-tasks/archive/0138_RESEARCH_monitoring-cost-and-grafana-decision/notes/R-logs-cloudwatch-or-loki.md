---
title: "Logs: stay in CloudWatch or move to Loki"
type: research
status: developing
spawns: []
tags: [monitoring, cloudwatch, grafana, loki, logs]
links:
  - R-cloudwatch-cost-measurement.md
  - I-grafana-shape.md
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-13"
    status: developing
    who: stkrolikiewicz
    note: "Log volumes read on 2026-11-12; comparison and recommendation written on 2026-11-13"
---

# Logs: stay in CloudWatch or move to Loki

If metrics move to Grafana, the server's logs could go with them, to Grafana Cloud's Loki. For
Milestone 2 they stay in CloudWatch.

## How much there is

The facilitator's log groups, read on 2026-11-12:

| Log group                              | Stored | A month                |
| -------------------------------------- | ------ | ---------------------- |
| `/x402/production/app` (app lines)     | 0.8 MB | ~4 MB                  |
| `/x402/production/metrics` (EMF lines) | 31 MB  | ~155 MB, gone with EMF |
| The `uptime-probe` and `watch` Lambdas | 6 MB   | ~30 MB                 |

The whole account wrote 0.86 GB to its own log groups in October, mostly Galexie's, and 6.5 GB of
Lambda logs. All of it cost $1.66 that month. Either side holds this volume for next to nothing,
so cost doesn't decide.

## The comparison

|                    | CloudWatch Logs                                                                      | Loki on Grafana Cloud Free                               |
| ------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Where the logs are | One place. The Lambdas' logs stay in CloudWatch either way.                          | Split: the server's in Loki, the Lambdas' in CloudWatch. |
| Retention          | 30 days (0027 decisions 11 and 18)                                                   | 14 days on the free tier                                 |
| Who holds them     | Our AWS account. The client IP in `rate_limited` ships on that basis (decision 11).  | A second vendor, client IP included                      |
| Agents on the host | Two: Alloy for metrics, the CloudWatch agent for logs                                | One: Alloy                                               |
| Credentials        | The Roles Anywhere chain stays: certificate, signing helper, logging role (ADR 0011) | The chain goes. Alloy holds one Grafana Cloud token.     |
| Queries            | Logs Insights, as `docs/monitoring.md` has them                                      | LogQL. Every query in the runbook is rewritten.          |

## Recommendation

Logs stay in CloudWatch for Milestone 2.

- All logs stay in one place, and the runbook's queries stay as they are.
- The team's 30 days hold, and the client IP stays in our account until 0038 looks at both before
  mainnet.
- The price is a second agent on the host and keeping the Roles Anywhere chain. Both run today.

Confirm the free tier's retention on Grafana's current pricing page. The 14 days are from memory,
not read on the measurement date.
