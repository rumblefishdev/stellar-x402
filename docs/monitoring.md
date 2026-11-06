# Monitoring

The facilitator's metrics and alarms live in CloudWatch, in `eu-central-1` on the team's shared
AWS account (ADR 0011, task 0027). Alarms go through SNS and Amazon Q Developer to the Slack
channel `#stellar-x402-bot`. Every alarm's description ends with `Runbook: docs/monitoring.md,
<alarm>`, which points at a section below.

- The metrics, with their names, units and dimensions: [`@stellar-x402/metrics-catalog`](../packages/metrics-catalog/src/index.ts),
  explained in task 0027's [G-metrics](../lore/1-tasks/active/0027_FEATURE_alerts-and-metrics/notes/G-metrics.md).
- Every alarm, with its shape and missing-data rule:
  [the alarm list](../lore/1-tasks/active/0027_FEATURE_alerts-and-metrics/notes/G-alarm-list.md).
- The stacks and the alarm groups: [infra/README.md](../infra/README.md).

This page covers the alarms that are on. Each group's section lands with the PR that turns the
group on. The full list of every metric and alarm, and the uptime figure, come with 0027's closing
PR (decision 68).

## The alarms that are on

| Alarm                  | Group       | On since   | Fired on purpose                                                |
| ---------------------- | ----------- | ---------- | --------------------------------------------------------------- |
| `emf-validation`       | `telemetry` | 2026-11-06 | 2026-11-06 08:39:50 UTC, `make fire-test` (delivery test, seen) |
| `emf-parsing`          | `telemetry` | 2026-11-06 | Not yet                                                         |
| `uptime`               | `uptime`    | #115       | Not yet                                                         |
| `uptime-flapping`      | `uptime`    | #115       | Not yet                                                         |
| `balance-low`          | `watch`     | #115       | Not yet                                                         |
| `balance-critical`     | `watch`     | #115       | Not yet                                                         |
| `watch-errors`         | `watch`     | #115       | Not yet                                                         |
| `watch-no-invocations` | `watch`     | #115       | Not yet                                                         |

A network-scoped alarm has the network at the end of its name (`balance-low-testnet`). AWS
commands below use the `stellar` SSO profile (`aws sso login --profile stellar`) and
`--region eu-central-1`.

## Telemetry

### emf-validation

CloudWatch rejected a metric line (Embedded Metric Format) in `/x402/production/metrics`, so the
metrics on it are missing. Event alarms on them read OK and Level alarms keep their last state, so
the other alarms can't be trusted until it's fixed.

1. In Logs Insights, on `/x402/production/metrics`, around the alarm's time:
   `fields @timestamp, @logStream, @message | sort @timestamp desc | limit 50`.
2. A writer or catalog change is the usual cause: compare with the last deploy (`/health` names
   its commit). The catalog in `packages/metrics-catalog` is the only source of names, units and
   dimensions.
3. Fix the writer and deploy. The alarm reads a metric written only when a line fails, so it
   returns to OK at its next evaluation and sends no OK message.

`make fire-test` (in `infra/`) sets this alarm to ALARM after every deploy of the alarms, to check
that messages reach Slack. That message says "Delivery test" and needs no action.

### emf-parsing

CloudWatch couldn't parse a line in `/x402/production/metrics` as JSON, so its metrics are
missing. The steps are those of [emf-validation](#emf-validation): find the line, find the writer
that changed, fix it.

## Uptime

The uptime probe, a Lambda in the Uptime stack, reads
`https://x402-facilitator.sorobanscan.com/health` through Cloudflare every minute and publishes
`ready` (1 or 0) to `x402-watch`. Its log is `/aws/lambda/x402-production-uptime-probe`, and each
line says what it read (`reason`).

### uptime

The facilitator was not ready to settle for 7 minutes in a row. A deploy's usual downtime stays
under that. Missing points count as down, so a probe that stops publishing fires it too.

1. Open the URL. A 502 or a Cloudflare error page points at the tunnel; a JSON body with
   `"ready": false` points at the facilitator (no lease, or the signer or the RPC check failing).
2. On the server, the [runbook's status commands](runbook.md#what-is-where):
   `systemctl list-units 'x402*'` and `journalctl -u x402@production`.
3. A failed or looping `x402@production`: the [watchdog](runbook.md#the-watchdog) and
   `facilitator-failed` say how it ended. The tunnel: `journalctl -u x402-tunnel@production`.
4. If the facilitator answers ready and the probe still reads 0, read the probe's log.

### uptime-flapping

The facilitator was not ready in 10 of the last 30 minutes without a 7-minute run of downtime:
it keeps going down and coming back. Usually a crash loop that restarts fast enough to pass the
probe now and then, a lease that moves, or a tunnel that drops.

1. `journalctl -u x402@production` for the restarts and how each ended; the
   [watchdog](runbook.md#the-watchdog) section says where the reason is logged.
2. Then `journalctl -u x402-tunnel@production`.

## The off-server check

The Watch stack's Lambda, `x402-production-watch`, runs every 5 minutes in AWS, so it works while
the server is down (ADR 0013). It reads each network's fee account through RPC with
`checkFacilitatorBalance` and publishes `spendable_stroops` to `x402-watch`. A network it can't
read publishes nothing, so the balance alarms keep their state and `watch-errors` fires instead.

Its log, and a run by hand:

```sh
aws logs tail /aws/lambda/x402-production-watch --since 30m --profile stellar --region eu-central-1
aws lambda invoke --function-name x402-production-watch --payload '{}' \
  --cli-binary-format raw-in-base64-out --profile stellar --region eu-central-1 /dev/stdout
```

Each run logs `watch_balance` with the spendable balance in stroops, or `watch_section_failed`
with the network and the error.

### balance-low

The fee account's spendable balance is below 25 XLM, about 5 days of settlements before 0024's
floor stops settlement at 5 XLM. The alarm names the network and the fee account, and its value is
the balance in stroops.

Top it up: [Topping up the fee account](runbook.md#topping-up-the-fee-account). The alarm returns
to OK at the check's next run after the top-up.

### balance-critical

The spendable balance is below 10 XLM, about a day before the floor stops settlement. Top it up
now, as for [balance-low](#balance-low).

If `balance-low` didn't fire first, the balance dropped at once: something other than fees moved
it. Read the fee account's recent transactions on Horizon before topping up, and treat a payment
no one on the team made as a theft of the facilitator key (ADR 0013).

### watch-errors

The check failed in 2 of its last 3 runs, so a balance was not published. The balance alarms keep
their last state meanwhile.

1. Read the log for `watch_section_failed`: it names the network and the error. The RPC's URL is
   left out of the error and shown as `rpc(<network>)`.
2. `no answer in 30000 ms` or a connection error: the RPC (`watch.rpcUrls` in
   `infra/envs/production.json`) is down or slow. Testnet's is SDF's public one.
3. `Account not found`: the fee account doesn't exist. On testnet that follows testnet's reset;
   Friendbot creates it again ([OpenBao](runbook.md#openbao), step 6).
4. `AccessDenied` on `PutMetricData`: the function's role changed; redeploy the Watch stack.

### watch-no-invocations

The check hasn't run for 15 minutes, so the balance alarms see nothing.

1. The schedule: `aws scheduler get-schedule --name x402-production-watch` (state `ENABLED`,
   `cron(0/5 * * * ? *)`).
2. The function: it exists, and its `Throttles` metric is 0 (it is limited to one run at a time).
3. If the Watch stack was deleted or never deployed, deploy it (`make deploy-production-watch` in
   `infra/`). On a fresh account, deploy Watch before Alarms ([infra/README.md](../infra/README.md)).
