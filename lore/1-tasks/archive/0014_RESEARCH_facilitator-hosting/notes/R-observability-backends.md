---
title: "Logger, metrics and alerting backends"
type: research
status: mature
spawned_from: README.md
spawns:
  - S-hosting-decision.md
tags: [observability, logging, metrics, alerting]
links: []
history:
  - date: "2026-10-08"
    status: developing
    who: claude
    note: "Researched for 0014 (logger library, metrics instrumentation, observability backends, uptime checks)."
  - date: "2026-10-09"
    status: mature
    who: stkrolikiewicz
    note: "Moved from an untracked checkout into the branch; feeds S-hosting-decision and ADR 0011."
---

# Logger, metrics and alerting backends

0014 has to choose the logger, the metrics library and the alerting backend, and 0027 builds on
that choice. Versions and prices were checked on 2026-10-08. AWS is Rumble Fish's default cloud, so
the AWS-native path gets a full row.

"Our scale" means T1: one instance on testnet. I assumed under 5 GB of logs a month, under 1,000
active metric series, about ten alert rules and one uptime check a minute. These are estimates,
not measurements.

## What has to be covered

- **Logs:** one JSON object per line, carrying `network`, the settlement key and the tx hash where
  known. Secrets and full XDR are never logged (spine, Consistency Conventions).
- **Metrics (0027):** pool `onEvent` events, request counts and latency per route, and settle
  outcomes.
- **Alerts (AD-18, 0027):**
  - budget nearly used
  - breaker open
  - low facilitator XLM balance
  - quarantined channel
  - pending settlements
  - uptime of the public URL (mainnet target 99%+)
- **Where alerts go:** Slack, plus email or a pager for mainnet.

With these metric shapes, every alert is a plain threshold on one series:

| Signal | Metric (Prometheus naming) | Fed by | Alert when |
| --- | --- | --- | --- |
| Pool activity | `pool_events_total{type}`, `pool_submissions_total{status}`, `pool_refused_total{reason}`, histograms of `queuedMs` / `totalMs` | `SubmitterEvent` (`sent`, `final`, `refused`, `send-retry`, `fee-raised`, ...) | none (dashboard) |
| Quarantined channels | `pool_channels_quarantined` (gauge) | `channel-quarantined` event or `snapshot().quarantined` | > 0 |
| Pending settlements | `settlements_pending` (gauge) | store: results reported `pending` but not yet `resolved` | > 0 for N minutes |
| Settle outcomes | `settle_total{outcome}` | `/settle` handler | failure ratio over a threshold |
| HTTP | `http_requests_total{route,status}`, `http_request_duration_seconds{route}` | Express middleware | 5xx rate |
| Spend budget | `spend_budget_used_ratio` (global) | `SpendStore` | > 0.8 |
| Breakers | `breakers_open` (count) | breaker | > 0 |
| Balance | `facilitator_balance_xlm` | `checkFacilitatorBalance` on a timer | < threshold |

- **Labels:** payer, `payTo`, asset contract and tx hash are unbounded, so they go in logs, not in
  metric labels. Breakers are per asset and per `payTo`, so export the count of open breakers. The
  log line says which breaker opened.
- **`network`:** every series carries it as a constant label.

## 1. Logger library

### pino

- **Version:** 10.4.0, published 2026-10-02 ([npm](https://www.npmjs.com/package/pino), checked with
  `npm view`).
- **Redaction:** the `redact` option takes paths, including `*` wildcards, and either censors the
  value or removes the key. The docs put the cost at about 2% without wildcards and much more with
  them ([redaction docs](https://github.com/pinojs/pino/blob/main/docs/redaction.md)). The docs
  still name `fast-redact`, but 10.4.0 depends on `@pinojs/redact` (npm dependency list).
- **Transports:**
  - `pino.transport()` runs targets in a worker thread. Each target can have its own level, and
    `pino/file` with destination 1 writes to stdout.
  - Transports exist for Loki (`pino-loki`), OpenTelemetry (`pino-opentelemetry-transport`),
    Better Stack (`@logtail/pino`), Axiom (`@axiomhq/pino`) and Datadog
    ([transports docs](https://github.com/pinojs/pino/blob/main/docs/transports.md)).
- **Overhead:** in pino's own benchmark, a basic log run averages about 115 ms, against about
  270 ms for winston and 377 ms for bunyan. It is a vendor benchmark, and the page states no N,
  date or hardware ([benchmarks](https://github.com/pinojs/pino/blob/main/docs/benchmarks.md)).
- **Bindings:** `logger.child({ network, settlementKey })` carries bindings into every line
  ([API docs](https://github.com/pinojs/pino/blob/main/docs/api.md)).

### Hand-rolled JSON-lines logger (about 20 lines)

- **Shape:**
  - one `process.stdout.write(JSON.stringify({ time, level, msg, ...bindings, ...fields }) + "\n")`
  - a `child()` that merges bindings
- **bigint:** `JSON.stringify` throws a `TypeError` on BigInt
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt#use_within_json)),
  and our amounts are bigints. The replacer writes them as decimal strings, which also matches the
  wire convention.
- **Errors:** `JSON.stringify` visits only enumerable own properties
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify)),
  so an `Error` turns into `{}` unless the replacer maps it to `name`, `message` and `stack`.
- **Redaction:** there is none as a safety net. Secrets stay out because the `Logger` field types
  never accept them (it takes a `txHash`, never an envelope).
- **Every candidate host already collects stdout:**
  - ECS through the `awslogs` driver
    ([AWS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_awslogs.html))
  - Cloud Run, which parses one-line JSON into `jsonPayload` and promotes `severity`
    ([Google](https://docs.cloud.google.com/run/docs/logging))
  - Railway, which parses JSON lines that have `message` and `level` and lets you filter on
    attributes ([Railway](https://docs.railway.com/observability/logs))
  - Fly and Render (section 3)

### Others

- **winston:** slower in the same benchmark, with more configuration.
- **OpenTelemetry logs:** the JS logs SDK is still at "Development" status
  ([OTel JS](https://opentelemetry.io/docs/languages/js/)), so it is not for now.

### Recommendation

The hand-rolled logger behind the app's `Logger` interface is enough for T1: one process, low
volume, and logs read in the host's log viewer.

The 0017 skeleton already has one. When this note was written, `apps/facilitator/src/logger.ts`
(uncommitted, on the 0017 branch) contained `jsonLogger`, which writes `time`, `level`, `event` and
the fields, and turns bigints into decimal strings. That matches this recommendation. One
adjustment depends on the host: Railway's JSON parsing looks for `message` and `level`, so on
Railway we would rename `event` to `message` or write both.

Swap the implementation to pino, with no change at the call sites, when any of these holds:

- Logs must be pushed from the process. That happens when the host has no log drain (Railway has
  none, see section 3) or when the chosen backend has no shipper on that host.
- We want path-based redaction as a second line of defence. The mainnet key-custody review is the
  natural point for this.
- Per-request logging on mainnet makes the cost per line visible.

## 2. Metrics instrumentation

### Prometheus client (`prom-client` is now `@prometheus-io/client`)

- **`prom-client` is deprecated on npm** ("replaced by @prometheus-io/client"). Its last release,
  15.1.3, came out on 2024-06-27 ([npm](https://www.npmjs.com/package/prom-client)).
- **The successor:**
  - `@prometheus-io/client` 0.16.1, released 2026-08-27, from `prometheus/client_js`
  - needs Node `^22 || ^24 || >=26`
    ([npm](https://www.npmjs.com/package/@prometheus-io/client))
  - 0.16.0 is its first release as a Prometheus subproject
    ([CHANGELOG](https://github.com/prometheus/client_js/blob/main/CHANGELOG.md))
- **Breaking changes from 15.x are small:** the package rename, `MetricType` is now a string union,
  and Node versions below 22 are dropped.
- **Model:**
  - an in-process registry of counters, gauges, histograms and summaries
  - you serve `await registry.metrics()` on `/metrics` yourself
  - `collectDefaultMetrics()` adds Node runtime metrics such as event-loop lag and GC
  - a Pushgateway is optional ([README](https://github.com/prometheus/client_js))
- **Dependencies:** only `tdigest` and `@opentelemetry/api` (npm).

### OpenTelemetry JS

- **Status:** metrics are "Stable" in OTel JS, and logs are "Development"
  ([OTel JS](https://opentelemetry.io/docs/languages/js/)).
- **Versions:** `@opentelemetry/sdk-metrics` is at 2.12.0 (2026-10-06). The OTLP exporters and
  `sdk-node` are still on the 0.x experimental line, at 0.223.0
  ([npm](https://www.npmjs.com/package/@opentelemetry/sdk-metrics)). SDK 2.x needs Node ≥ 18.19 or
  20.6 ([SDK 2.0 announcement](https://opentelemetry.io/blog/2025/otel-js-sdk-2-0/)).
- **Delivery:** OTLP push needs a MeterProvider, a periodic reader, an exporter and a flush on
  shutdown. Pull works through `@opentelemetry/exporter-prometheus`.

### Which is simpler for one service

The Prometheus client:

- It is one package, with no SDK lifecycle and nothing to flush when the AD-17 shutdown stops the
  process.
- Pull works with most of the backends below: Fly's built-in scraper, Grafana Cloud's hosted
  scrape, Better Stack's scraper and any Prometheus or Alloy.

Choose OTel only if the chosen backend can't scrape (Axiom, or a host where nothing can reach
`/metrics`), or when we add traces. On the AWS-native path we would use neither: the logger writes
EMF fields instead (section 3).

### Which backends accept which format

| Backend | Prometheus scrape (pull) | Prometheus remote write | OTLP push | Other |
| --- | --- | --- | --- | --- |
| Grafana Cloud | yes: a hosted "Metrics Endpoint" job; the target must be public and must require Basic or Bearer auth ([docs](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-infrastructure/integrations/integration-reference/integration-metrics-endpoint/)) | yes | yes, through the OTLP gateway; sending straight from the SDK suits non-production, and Alloy is recommended for production ([docs](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/otlp/send-data-otlp/)) | |
| Better Stack | yes, from their scrape IPs ([docs](https://betterstack.com/docs/logs/prometheus-scrape/)) | yes ([docs](https://betterstack.com/docs/logs/ingesting-data/metrics/prometheus-push/)) | yes ([docs](https://betterstack.com/docs/logs/open-telemetry/)) | `@logtail/pino` for logs |
| Axiom | not found (unverified) | not found (unverified) | yes: MetricsDB, GA since 2026-03-27 ([docs](https://axiom.co/docs/query-data/metrics), [changelog](https://axiom.co/changelog/metrics-mpl)) | `@axiomhq/pino` |
| Datadog | through the Agent (not checked for PaaS) | not checked | through the Agent or a collector; one third-party source says OTel metrics are billed as custom metrics (unverified) | |
| Fly.io built-in | yes: `[metrics]` in `fly.toml`, scraped every 15 s ([docs](https://docs.fly.io/monitoring/metrics)) | no | no | |
| AWS CloudWatch | not pursued | no | not checked | EMF fields in log lines ([docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Generation_PutLogEvents.html)) |

## 3. Backends

### Comparison

Cost at our scale is my estimate from the list prices cited below.

| Backend | Covers | Free tier | Cost at our scale (T1 / mainnet) | Slack alerts | Ingest | Setup effort |
| --- | --- | --- | --- | --- | --- | --- |
| **Grafana Cloud** | logs (Loki), metrics, alerts, uptime (Synthetic Monitoring), on-call (IRM) | 10k active series, 50 GB logs, 14-day retention, 3 users, 500 alert rules, 100k synthetic API runs a month | $0 / about $19 a month (Pro platform fee; we stay inside its included usage) | yes, contact point by webhook or bot token | Prometheus scrape and remote write, OTLP, Loki push | low for metrics, alerts and uptime; logs need a shipper on each host |
| **Better Stack** | logs, metrics, alerts, uptime, status page, on-call | 10 monitors and heartbeats (3-minute checks), 3 GB logs kept 3 days, 30 GB metrics, Slack and email | $0 / about $55–65 a month (one $29–34 responder plus a $25–30 EU Nano telemetry bundle with 30-day logs) | yes for uptime incidents; for telemetry alerts the docs list email, call, SMS, push and escalation policies, and Slack there is unverified | Prometheus scrape and remote write, OTLP, `@logtail/pino` | low |
| **Axiom** | logs, metrics, alerts (no uptime) | Personal plan: 500 GB ingest a month, 25 GB storage, 30-day retention | $0 / $25 a month plus usage (Cloud plan) | yes: Slack webhook, email, webhook, PagerDuty, Opsgenie | OTLP, `@axiomhq/pino` | medium: metrics need OTel, and uptime needs another vendor |
| **Datadog** | everything | 5 hosts, 1-day metric retention, no logs | about $40–60 a month for one host plus logs plus a 1-minute API check (both phases) | yes | Agent, OTLP through the Agent | medium to high; billed per product |
| **AWS-native** (CloudWatch Logs, EMF metrics, alarms, SNS, Amazon Q Developer in chat applications, Route 53 or Synthetics) | logs, metrics, alerts, uptime | 5 GB logs, 10 custom metrics, 10 alarms, 3 dashboards, 100 canary runs; 50 free health checks on AWS endpoints | about $10–25 a month (both phases) | yes, through SNS and Q Developer (no extra charge) | stdout through `awslogs`, EMF JSON lines | medium to high: IAM, SNS, Slack admin approval, alarms in IaC |
| **Google Cloud** (Cloud Run only) | logs, metrics, alerts, uptime | 50 GiB logs per project, 1M uptime-check runs per project | about $1–5 a month | unverified here | stdout JSON, Managed Prometheus (not checked) | medium; only if we host on Cloud Run |
| **Fly.io built-ins** | logs (7 days), metrics (15 days), Grafana dashboards | free for now | $0 | **no built-in alerting** | Prometheus scrape of `/metrics` | very low for metrics; alerts need an external Grafana |
| **Railway built-ins** | logs, CPU/RAM metrics, resource monitors | included in the plan | in plan | email and webhooks only, not on app metrics | stdout (JSON attributes) | low, but no alerts on app metrics |
| **Render built-ins** | logs, service metrics, notifications | included in the plan | in plan | Slack and email for deploys, health and disk, not on app metrics | stdout, log streams out | low, but no alerts on app metrics |

### Notes and sources per backend

**Grafana Cloud** ([pricing](https://grafana.com/pricing/))

- **Free tier:**
  - 10k active metric series a month
  - 50 GB each of logs, traces and profiles
  - 14-day retention for everything
  - 3 active users, which is exactly our team
  - 3 IRM users
  - 100k synthetic API test runs a month
- **Pro:** $19 a month, which includes the free allowances. Beyond them:
  - $6.50 per 1k active series
  - logs at $0.05/GB processing, $0.40/GB write and $0.10/GB retain
  - 13-month retention for metrics and 30 days for logs
- **Alerting:**
  - The free plan allows 500 alert rules
    ([docs](https://grafana.com/docs/grafana-cloud/alerting-and-irm/alerting/alerting-rules/create-grafana-managed-rule/)).
  - Slack is a contact point, by bot token or webhook URL
    ([docs](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/configure-slack/)).
- **Hosted scrape:**
  - It needs no collector, but the target must be public and protected by auth.
  - The default 1-minute interval is advised, because shorter intervals raise billed data points
    ([docs](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-infrastructure/integrations/integration-reference/integration-metrics-endpoint/)).
  - One user reports a limit email because billable series exceeded active series
    ([issue](https://github.com/lentago/drosera/issues/239), an anecdote), so keep the 1-minute
    interval.

**Better Stack** ([pricing](https://betterstack.com/pricing))

- **Free tier:**
  - 10 monitors and heartbeats combined
  - 1 status page
  - Slack and email alerts
  - 3 GB logs kept 3 days
  - 30 GB metrics
- **Check frequency:** 3 minutes on the free plan, down to 30 s on paid plans
  ([docs](https://betterstack.com/docs/uptime/check-frequency/)).
- **Slack for uptime incidents:** an integration with acknowledge buttons
  ([docs](https://betterstack.com/docs/uptime/slack/)).
- **Paid:**
  - Responder at $34 a month, or $29 billed yearly, which covers on-call with phone and SMS
  - the EU Nano telemetry bundle at $30 a month, or $25 billed yearly, with 30-day retention
  - pay-as-you-go logs at $0.10/GB ingest in the EU
- **Telemetry alerts:** threshold, percentage-change and anomaly alerts on dashboard charts. They
  send email by default, can add call, SMS, push or an escalation policy, and open an incident
  ([docs](https://betterstack.com/docs/logs/dashboards/alerts/)).

**Axiom** ([pricing](https://axiom.co/pricing))

- **Personal plan:** $0 and permanent:
  - 500 GB loading
  - 10 GB-hours of query
  - 25 GB storage
  - 30-day retention
- **Cloud plan:** $25 a month plus usage.
- **Alerting:** threshold, match and anomaly monitors
  ([docs](https://axiom.co/docs/monitor-data/monitors)). Notifiers are Slack (incoming webhook),
  email, webhook, PagerDuty and Opsgenie
  ([docs](https://axiom.co/docs/monitor-data/notifiers-overview)).
- **Team use:** whether the "Personal" plan allows team use was not checked (unverified).

**Datadog** ([pricing](https://www.datadoghq.com/pricing/))

- **Free plan:** up to 5 hosts with 1-day metric retention.
- **Infrastructure Pro:** $15 per host a month billed yearly, or $18 on demand.
- **Logs:** $0.10/GB ingested, plus $1.70 per million events indexed with 15-day retention ($2.55
  on demand).
- **Synthetics:** API tests at $5 per 10k runs billed yearly, or $7.20 on demand.
- **Our estimate:** one host plus a 1-minute check (43,200 runs a month) plus a few million log
  events is about $40–60 a month.

**AWS-native**

- **Pipeline:**
  - The app writes JSON lines to stdout, and on ECS Fargate the `awslogs` driver ships them to
    CloudWatch Logs
    ([docs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_awslogs.html)).
  - Lines that carry an `_aws` EMF block become custom metrics. The `x-amzn-logs-format` header is
    optional
    ([docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Generation_PutLogEvents.html)),
    and since 2023 CloudWatch extracts EMF from structured logs without a special header
    ([announcement](https://aws.amazon.com/about-aws/whats-new/2023/01/amazon-cloudwatch-metric-extraction-structured-logs/)).
    Extraction through `awslogs` on Fargate is expected to work but should be confirmed with one
    test task (unverified).
  - CloudWatch alarms publish to SNS. Amazon Q Developer in chat applications (formerly AWS
    Chatbot) forwards SNS notifications to Slack channels. A Slack workspace admin must approve it,
    and it needs an IAM role
    ([docs](https://docs.aws.amazon.com/chatbot/latest/adminguide/what-is.html)). It costs nothing
    extra; you pay only for SNS and CloudWatch ([pricing](https://aws.amazon.com/chatbot/pricing/)).
- **CloudWatch prices** (us-east-1, [pricing](https://aws.amazon.com/cloudwatch/pricing/)):
  - free each month: 5 GB of logs, 10 custom metrics, 10 alarm metrics, 3 dashboards and 100
    canary runs
  - logs: $0.50/GB ingest and $0.03/GB-month storage
  - custom metrics: $0.30 per metric a month for the first 10k
  - alarms: $0.10 per standard alarm metric
  - Synthetics: $0.0012 per canary run
  - EMF is billed as log ingestion, log storage and custom metrics
- **Our estimate:**
  - about 40 metric and dimension combinations, so about $9 a month after the 10 free ones
  - logs inside the free 5 GB
  - alarms inside the free 10
  - uptime from about $1 to $10 a month (section 4)
  - total: about $10–25 a month
- **Cost driver:** every dimension combination is a billed metric.

**Google Cloud** ([pricing](https://cloud.google.com/stackdriver/pricing), figures taken from
search snapshots because the live page did not load)

- **Logs:** 50 GiB per project a month free, then $0.50/GiB with 30 days of retention included.
- **Uptime checks:** 1M runs per project free, then $0.30 per 1k.
- **Alerting:** $0.10 per condition a month plus $0.35 per million time series, effective
  2026-05-01 ([cost guide](https://cloud.google.com/monitoring/alerts/cost-control)). Whether
  billing has started was not confirmed.
- **Fit:** only relevant if we host on Cloud Run.

**Fly.io**

- **Metrics:**
  - managed Prometheus on VictoriaMetrics, scraping `[metrics]` every 15 s
  - about 15 days of retention, no extra charge for now
  - Grafana dashboards at fly-metrics.net
  - **no built-in metric alerting**: Fly's docs say to connect an external Grafana to the Fly
    Prometheus API, or to run Prometheus with Alertmanager
    ([docs](https://docs.fly.io/monitoring/metrics))
- **Logs:**
  - searchable for 7 days, in beta and free during the beta
    ([docs](https://docs.fly.io/monitoring/search-logs))
  - for longer retention, the Fly Log Shipper (Vector) forwards the NATS log stream to Loki,
    Datadog and other sinks ([docs](https://fly.io/docs/monitoring/exporting-logs/))

**Railway**

- **Logs:**
  - retention: 7 days on Hobby, 30 on Pro, 90 on Enterprise
  - JSON attributes are searchable
  - 500 lines per second per replica
  - **no log drain**: forward with Vector or Fluent Bit, or push from the app
    ([docs](https://docs.railway.com/observability/logs))
- **Alerts:**
  - monitors on CPU, RAM, disk and egress (Pro plan) send email and webhooks
  - webhooks also fire for failed deploys and crashes
    ([docs](https://docs.railway.com/guides/alerts-crashes-failed-deploys))

**Render**

- **Logs:**
  - retention: 7 days on Hobby, 14 on Pro, 30 on Scale and Enterprise (plan names as on that page)
  - log streams to external providers ([docs](https://render.com/docs/logging))
- **Notifications:** email or Slack for failed deploys, an unhealthy service and disk over 80%.
  There are **no alerts on CPU, memory or custom metrics**
  ([docs](https://render.com/docs/notifications)).

### AWS-native compared with Grafana Cloud and Better Stack, for 3 people

**AWS-native: for**

- One account for IAM, billing and audit, which the company already runs. No extra vendor enters
  the mainnet key-custody review.
- Logs land in CloudWatch for free once we run on ECS.
- Slack delivery is free.
- Alarms are a regional AWS service, so they are dependable.

**AWS-native: against**

- **Price per metric:** about $0.30 per metric and dimension combination, which punishes
  per-route and per-status breakdowns.
- **More setup:**
  - SNS topics
  - an IAM role for the chat client
  - Slack admin approval
  - every alarm written in IaC
- **Weaker UX:** querying and dashboards are weaker than in Grafana.
- **Route 53 health checks:** the alarms must live in us-east-1, and notifications can lag by
  several minutes.
- **Lock-in:** EMF ties the metrics format to AWS, so leaving AWS means rewriting the metrics
  adapter. The path only makes sense if the host is on AWS.

**Grafana Cloud**

- $0 for T1 and about $19 a month on mainnet.
- Metrics, alert rules, Slack and uptime live in one UI, and it works from any host.
- Its weak spots: shipping logs is per host work, free retention is 14 days, and the free plan
  allows 3 users.

**Better Stack**

- The best uptime, on-call and status-page product of the three, with Slack on the free tier.
- Free log retention is only 3 days, and Slack for telemetry alerts is unconfirmed.
- Paging costs $29–34 per responder a month.
- It fits as the second uptime checker or as the mainnet pager.

**Verdict for a team of 3:** Grafana Cloud is the least effort for metrics, alerts and uptime on
any host. AWS-native is a reasonable choice only if we host on ECS and the company wants everything
inside AWS. It costs about $10–25 a month and roughly a day or two more of IaC work (my estimate).

## 4. Uptime monitoring of the public HTTPS URL

| Option | Free | Fastest interval | Slack | Paid | Notes |
| --- | --- | --- | --- | --- | --- |
| Grafana Synthetic Monitoring | 100k API runs a month (a 1-minute check from one probe uses about 43k) | 1 min (not checked whether faster is possible) | yes, through Grafana alerting | $5 per 10k API runs on Pro | can alert on failures, TLS expiry and latency ([docs](https://grafana.com/docs/grafana-cloud/testing/synthetic-monitoring/), [pricing](https://grafana.com/pricing/)) |
| Better Stack Uptime | 10 monitors and heartbeats | 3 min free, 30 s paid | yes, free | $29–34 per responder for phone and SMS | includes a status page ([docs](https://betterstack.com/docs/uptime/check-frequency/)) |
| UptimeRobot | 50 monitors | 5 min free, 60 s on Solo | free plan has "only 5 integrations"; whether Slack is one is unverified | Solo €9–10 a month | commercial use allowed on free ([help](https://help.uptimerobot.com/en/articles/11604710-who-should-use-uptimerobot-s-free-plan), [pricing](https://uptimerobot.com/pricing/)) |
| Route 53 health check | 50 on AWS endpoints | 30 s, or 10 s as the paid fast option | through a CloudWatch alarm, SNS and Q Developer | $0.50 (AWS endpoint) or $0.75 (non-AWS), plus $1 or $2 per optional feature (HTTPS, string match, fast interval) | metrics only in us-east-1; SNS can lag several minutes ([pricing](https://aws.amazon.com/route53/pricing/), [docs](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/monitoring-health-checks.html)) |
| CloudWatch Synthetics | 100 canary runs | 1 min | same as above | $0.0012 per run (a 5-minute canary is about $10 a month), plus the Lambda it runs on (not quantified) | runs as a Lambda in our account ([docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Canaries.html)) |
| Google Cloud uptime checks | 1M runs per project | not checked | not checked | $0.30 per 1k runs | only if we are on GCP ([pricing](https://cloud.google.com/stackdriver/pricing)) |
| Datadog Synthetics | none | not checked | yes | $5 per 10k runs billed yearly, $7.20 on demand | ([pricing](https://www.datadoghq.com/pricing/)) |

The Route 53 health-check intervals are general AWS knowledge and were not re-checked here.

**How to check:** hit a cheap public route, such as `GET /supported` or a dedicated health route,
every 1–3 minutes. The 99% target allows about 7.2 hours of downtime in a 30-day month, so that
granularity is enough to measure it. For mainnet, run two checkers from different vendors, with at
least one outside the alerting backend, so an outage of the monitoring vendor can't hide ours.

## Leaning

### Minimal stack for T1

It is $0 and works on any host:

1. **Logger:** the hand-rolled JSON-lines logger to stdout, behind `Logger`. Logs stay in the
   host's log store: CloudWatch Logs on ECS, or 7–30 days on a PaaS. T1 needs no separate log
   backend.
2. **Metrics:**
   - `@prometheus-io/client` in `adapters/`, serving `/metrics` behind a bearer token
   - default Node metrics on
   - labels as in the table at the top
3. **Alerts:**
   - Grafana Cloud Free with a hosted Metrics Endpoint scrape every minute
   - six alert rules: the five AD-18 conditions plus "scrape down / no data"
   - one Slack contact point
4. **Uptime:** a Grafana Synthetic Monitoring HTTP check every minute from one probe (about 43k of
   the 100k free runs), sent to the same Slack contact point.

### If the hosting ADR picks AWS (ECS Fargate)

The stack above works unchanged: Grafana scrapes the public URL, and logs go to CloudWatch for
free.

The all-AWS variant is the alternative when the company wants a single vendor:

- EMF metrics
- CloudWatch alarms
- SNS and Q Developer for Slack
- a Route 53 health check

It means replacing the metrics adapter with EMF fields in the logger, paying about $10–25 a month,
and defining the alarms in IaC.

### What changes for mainnet

- **Retention:** Grafana Cloud Pro, at $19 a month, keeps metrics for 13 months and logs for 30
  days, so the 99% figure and incident history outlive the 14-day free window.
- **Logs:**
  - ship them to a central store with 30+ days of retention: Loki through the host's shipper or
    Alloy, or CloudWatch on AWS
  - switch the logger to pino if the process pushes logs itself
  - add `redact` paths as a safety net
- **Paging:** Slack is not a pager. For breaker open, low balance and pending settlements, add
  phone or SMS through Grafana IRM (3 free users) or a Better Stack Responder ($29–34 per user a
  month).
- **Uptime:** add a second, independent checker, such as Better Stack Free or UptimeRobot Free.
- **Routing:** split by the `network` label. Testnet alerts go to Slack only; mainnet alerts go to
  Slack and the pager.
- **Traces:** add OTel traces only if a real debugging need appears.

## Unverified points to settle before or during 0027

- **Better Stack:** can telemetry (dashboard) alerts post to Slack, or only email, call, SMS and
  escalation?
- **UptimeRobot:** is Slack available on the free plan?
- **Axiom:** may a team use the "Personal" plan, and can it scrape Prometheus?
- **AWS:**
  - Does EMF extraction work through `awslogs` on Fargate? Test with one task.
  - What does the Lambda behind a canary cost?
- **Google Cloud:** custom-metric pricing and a Slack notification channel were not checked on the
  live page.
- **Datadog:** do OTel metrics bill as custom metrics, and how does the Agent run on a PaaS?
