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

This page has every alarm: a section for each one that is on, and the [alarms that are off](#the-alarms-that-are-off)
with the task that turns each on. [Every metric](#every-metric) lists the catalog's metrics and
the alarms that read them. The [uptime figure](#the-uptime-figure) is under Uptime.

## The alarms that are on

| Alarm                     | Group         | On since             | Fired on purpose                                                                                                                        |
| ------------------------- | ------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `emf-validation`          | `telemetry`   | 2026-11-06           | `make fire-test` after each Alarms deploy (delivery test, seen): 2026-11-06 08:39:50 and 11:18:30, 2026-11-09 12:22:01 and 15:13:28 UTC |
| `emf-parsing`             | `telemetry`   | 2026-11-06           | Not fired: `AWS/Logs` takes no hand-written point ([Drills](#drills))                                                                   |
| `uptime`                  | `uptime`      | 2026-11-06 11:16 UTC | 2026-11-09, the stop window ([Drills](#drills)): ALARM 13:34:24, OK 13:48:24 UTC                                                        |
| `uptime-flapping`         | `uptime`      | 2026-11-06 11:16 UTC | 2026-11-09, the stop window ([Drills](#drills)): ALARM 13:37:34, OK 14:08:34 UTC                                                        |
| `balance-low`             | `watch`       | 2026-11-06 11:16 UTC | 2026-11-06, a fake point ([Drills](#drills)): ALARM 11:20:10, OK 11:25:10 UTC, both seen in Slack                                       |
| `balance-critical`        | `watch`       | 2026-11-06 11:16 UTC | 2026-11-06, the same fake point: ALARM 11:20:35, OK 11:25:35 UTC, both seen in Slack                                                    |
| `watch-errors`            | `watch`       | 2026-11-06 11:16 UTC | Not fired: `AWS/Lambda` takes no hand-written point ([Drills](#drills))                                                                 |
| `watch-no-invocations`    | `watch`       | 2026-11-06 11:16 UTC | 2026-11-09, the stop window ([Drills](#drills)): ALARM 13:41:52, OK 13:51:52 UTC                                                        |
| `protocol-changed`        | `protocol`    | 2026-11-09 12:19 UTC | 2026-11-09, fake points for both networks ([Drills](#drills)): ALARM 13:55:22, OK 13:59:22 UTC                                          |
| `protocol-upgrade-coming` | `protocol`    | 2026-11-09 12:19 UTC | 2026-11-09, fake points for both networks ([Drills](#drills)): ALARM 13:55:15–13:55:52, OK 13:59:15–13:59:52 UTC                        |
| `facilitator-silent`      | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, the stop window ([Drills](#drills)): ALARM 13:42:49, OK 13:47:49 UTC                                                        |
| `gauges-silent`           | `facilitator` | 2026-11-09 12:19 UTC | Not fired: it needs gauges missing while sweeps run ([Drills](#drills))                                                                 |
| `http-500`                | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:00, OK 14:09:00 UTC                                                           |
| `rpc-stalled`             | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:33:26, OK 13:47:26 UTC                                         |
| `rpc-on-fallback`         | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:43:00, OK 13:48:00 UTC                                         |
| `balance-stale`           | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:29:38, OK 13:47:38 UTC                                         |
| `pending`                 | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:31:12, OK 13:47:12 UTC                                         |
| `sweeps-stopped`          | `facilitator` | 2026-11-09 12:19 UTC | Not fired: it needs sweeps that run but list nothing ([Drills](#drills))                                                                |
| `settlement-expired`      | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:29, OK 14:09:29 UTC                                                           |
| `landed-after-expired`    | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:15, OK 14:09:15 UTC                                                           |
| `history-gone`            | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:33, OK 14:09:33 UTC                                                           |
| `submit-failed`           | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:43, OK 14:09:43 UTC                                                           |
| `refused-after-verify`    | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:58, OK 14:09:58 UTC                                                           |
| `failure-ours`            | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:42, OK 14:09:42 UTC                                                           |
| `signer-failures`         | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:34, OK 14:09:34 UTC                                                           |
| `store-outage`            | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:05, OK 14:04:05 UTC                                                           |
| `hook-failures`           | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:37, OK 14:09:37 UTC                                                           |
| `queue-waiting`           | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:31:42, OK 13:47:42 UTC                                         |
| `channel-quarantined`     | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:29:22, OK 13:47:22 UTC                                         |
| `pool-health`             | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:30, OK 14:14:30 UTC                                                           |
| `breaker-opened`          | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point for each kind ([Drills](#drills)): ALARM 13:49:05–13:49:17, OK 14:09:05–14:09:17 UTC                           |
| `budget-nearing`          | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:31, OK 14:19:31 UTC                                                           |
| `commit-unmatched`        | `facilitator` | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:50, OK 14:09:50 UTC                                                           |
| `openbao-down`            | `host`        | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:31:24, OK 13:46:24 UTC                                         |
| `disk`                    | `disk`        | 2026-11-09 15:11 UTC | 2026-11-09, fake points at 85% ([Drills](#drills)): ALARM 15:26:16, OK 15:36:16 UTC; `audit-disk` (90%) stayed OK                       |
| `audit-disk`              | `host`        | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:39:32, OK 13:49:32 UTC                                         |
| `facilitator-failed`      | `host`        | 2026-11-09 12:19 UTC | 2026-11-09, for real: the stop window's own stop (exit 130, fixed by #163), ALARM 13:46:53; then a fake point; OK 14:09:53 UTC          |
| `watchdog-restart`        | `host`        | 2026-11-09 12:19 UTC | 2026-11-09, a fake point ([Drills](#drills)): ALARM 13:49:09, OK 14:09:09 UTC                                                           |
| `probe-silent`            | `host`        | 2026-11-09 12:19 UTC | 2026-11-09, the stop window ([Drills](#drills)): ALARM 13:42:31, OK 13:46:31 UTC                                                        |
| `telemetry-silent`        | `host`        | 2026-11-09 12:19 UTC | 2026-11-09, the stop window ([Drills](#drills)): ALARM 13:40:23, OK 13:48:23 UTC                                                        |
| `credentials-stale`       | `host`        | 2026-11-09 12:19 UTC | 2026-11-09, fake points in the stop window ([Drills](#drills)): ALARM 13:31:13, OK 13:46:13 UTC                                         |
| `certificate`             | `host`        | 2026-11-09 12:19 UTC | Not fired: every hour holds the real days left ([Drills](#drills))                                                                      |
| `log-volume`              | `logVolume`   | 2026-11-09 12:19 UTC | Not fired: `AWS/Logs` takes no hand-written point ([Drills](#drills))                                                                   |
| `memory`                  | `memory`      | 2026-11-09 15:11 UTC | Not fired: a `Minimum` alarm can't be faked while the agent writes real samples ([Drills](#drills))                                     |

A network-scoped alarm has the network at the end of its name (`balance-low-testnet`), and
`breaker-opened` its kind after the network (`breaker-opened-testnet-payer`). `log-volume` ends in
its log group (`log-volume-app`, `log-volume-metrics`). `http-500` and the server's alarms carry
no network. AWS commands below use the `stellar` SSO profile (`aws sso login --profile stellar`)
and `--region eu-central-1`.

## The alarms that are off

Built in `infra/` and defined in the alarm list, but their group is off in
`infra/envs/production.json` until what they read exists. Each gets its section here, and is fired
once, by the task that turns it on.

| Alarm                | Group           | Turned on by                                                                           |
| -------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `account-effects`    | `watchSecurity` | 0127, the theft section                                                                |
| `account-state`      | `watchSecurity` | 0127, the theft section                                                                |
| `backup-age`         | `backups`       | 0026, once the first pgBackRest backup is made                                         |
| `backup-secret-read` | `watchSecurity` | 0127, the secret-read section, once 0026 creates the backup secret                     |
| `channel-held`       | `channelHeld`   | 0089 builds `channel_longest_hold_seconds`; 0027 owns the alarm (alarm list, Deferred) |
| `snapshot-age`       | `snapshots`     | 0026, once OpenBao's daily snapshot has run                                            |
| `upstream-changed`   | `upstream`      | 0029, `make check-series GROUP=upstream` in the 3 hours after a 08:00 UTC run          |
| `upstream-silent`    | `upstream`      | 0029, as above                                                                         |
| `wal-failing`        | `backups`       | 0026, once pgBackRest archives WAL (its decision-71 criterion)                         |
| `wal-stale`          | `backups`       | 0026, as above                                                                         |

**The logs.** The facilitator, the tunnel, Postgres, OpenBao and the deploy write their output to
files under `/var/log/x402/` on the server, and the CloudWatch agent ships them ([runbook, The CloudWatch agent](runbook.md#the-cloudwatch-agent)):
the facilitator's lines are the stream `facilitator` in `/x402/production/app`, one JSON object
each, named by its `event`. `journalctl -u x402@production` keeps only the unit's start and stop.
The watchdog, the host probe, the credentials helper and the snapshot job still log to the
journal (`journalctl -u <unit>`).
To find an event in Logs Insights, on `/x402/production/app`:

```
fields @timestamp, @message | filter event = "rpc_failover" | sort @timestamp desc | limit 50
```

On the server, the same lines, the rotated files included (10 of 100 MB, compressed after the
first): `sudo zgrep -h '"event":"rpc_failover"' /var/log/x402/production/facilitator.log*`. The
file also holds the metric lines, which the agent ships apart; leave them out of a `tail` with
`sudo grep -v '^{"_aws":' /var/log/x402/production/facilitator.log | tail -n 50`.

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
that messages reach Slack. That message says "Delivery test" and needs no action. A deploy that
adds alarms also sends one OK message from each new alarm when it first reads data; that is the
deploy, not a fault.

### emf-parsing

CloudWatch couldn't parse a line in `/x402/production/metrics` as JSON, so its metrics are
missing. The steps are those of [emf-validation](#emf-validation): find the line, find the writer
that changed, fix it.

## Uptime

The uptime probe, a Lambda in the Uptime stack, reads
`https://x402-facilitator.sorobanscan.com/health` through Cloudflare every minute and publishes
`ready` (1 or 0) to `x402-watch`. Its log is `/aws/lambda/x402-production-uptime-probe`, and each
line says what it read (`reason`).

### The uptime figure

A minute counts as up only when the probe read `ready` (decision 5; a missing point counts as
down). From `uptime`'s start, 2026-11-06 11:16 UTC, to 2026-11-09 15:33 UTC: 4,557 of 4,577
minutes, **99.56%**. All 20 down minutes are the drill's planned stop (13:27 to 13:46 on
2026-11-09); without it, 100%: the 2026-11-06 13:09 deploy lost no minute. To read it again
(`Minimum` of `ready` per minute; count the minutes at 1 over all minutes in the window):

```sh
aws cloudwatch get-metric-statistics --region eu-central-1 --namespace x402-watch \
  --metric-name ready --period 60 --statistics Minimum \
  --start-time 2026-11-06T11:16:00Z --end-time 2026-11-07T11:16:00Z
```

One call returns at most 1,440 points, so read a day at a time.

### uptime

The facilitator was not ready to settle for 7 minutes in a row. A deploy's usual downtime stays
under that. Missing points count as down, so a probe that stops publishing fires it too.

1. Open the URL. A 502 or a Cloudflare error page points at the tunnel; a JSON body with
   `"ready": false` points at the facilitator (no lease, or the signer or the RPC check failing).
2. On the server, the [runbook's status commands](runbook.md#what-is-where):
   `systemctl list-units 'x402*'`, then the end of `/var/log/x402/production/facilitator.log`
   without its metric lines (The logs, above) and `facilitator.err.log`.
3. A failed or looping `x402@production`: the [watchdog](runbook.md#the-watchdog) and
   [facilitator-failed](#facilitator-failed) say how it ended. The tunnel:
   `/var/log/x402/production/cloudflared.log`.
4. If the facilitator answers ready and the probe still reads 0, read the probe's log.

### uptime-flapping

The facilitator was not ready in 10 of the last 30 minutes without a 7-minute run of downtime:
it keeps going down and coming back. Usually a crash loop that restarts fast enough to pass the
probe now and then, a lease that moves, or a tunnel that drops.

1. The restarts and how each ended: the `facilitator_failures_total` and `watchdog_restarts_total`
   lines in `/var/log/x402/host/metrics.log`; the [watchdog](runbook.md#the-watchdog) section
   says where the reason is logged.
2. Then `/var/log/x402/production/cloudflared.log`.

## The off-server check

The Watch stack's Lambda, `x402-production-watch`, runs every 5 minutes in AWS, so it works while
the server is down (ADR 0013). It has three sections, run at once:

- **balance:** each served network's fee account through RPC with `checkFacilitatorBalance`,
  published as `spendable_stroops`;
- **protocol:** Horizon's root for each network in `watch.protocol` (testnet and mainnet), served
  or not, published as `protocol_version` and `protocol_supported_version`;
- **upstream:** once a day, the run at 08:00 UTC: the conformance gate's pin from this repo's
  `develop`, and four upstream x402 files at that pin and on upstream `main` (the x402 spec, the
  Stellar `exact` scheme, the suite's Stellar routes and the discovery spec, task 0029),
  published as `upstream_files_changed`, the count that differ.

A network a section can't read publishes nothing, so its alarms keep their state and
`watch-errors` fires instead; the other sections still publish. The upstream section fails at most
once a day, which `watch-errors` can't count on its own: `upstream-silent` covers it.

Its log, and a run by hand:

```sh
aws logs tail /aws/lambda/x402-production-watch --since 30m --profile stellar --region eu-central-1
aws lambda invoke --function-name x402-production-watch --payload '{}' \
  --cli-binary-format raw-in-base64-out --profile stellar --region eu-central-1 /dev/stdout
```

A run by hand with `--payload '{"scheduledTime":"<today>T08:00:00Z"}'`, after 08:00 UTC, runs the
upstream section too. Use today's date: every point is stamped with that time, and CloudWatch
refuses a point more than 2 hours ahead, so a later date fails all three sections.

Each run logs `watch_balance` with the spendable balance in stroops and `watch_protocol` with
both versions, the 08:00 run `watch_upstream` with the pin and the files that differ, or
`watch_section_failed` with the section, the network and the error.

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

The check failed in 2 of its last 3 runs, so a section was not published: the balance (read
through the RPC) or the protocol (read from Horizon). That section's alarms keep their last state
meanwhile; the other section still published.

1. Read the log for `watch_section_failed`: it names the section, the network and the error.
   Endpoint URLs are left out and shown as `rpc(<network>)` or `horizon(<network>)`.
2. `no answer in 30000 ms` or a connection error: the RPC (`watch.rpcUrls` in
   `infra/envs/production.json`) is down or slow. Testnet's is SDF's public one.
3. `Account not found`: the fee account doesn't exist. On testnet that follows testnet's reset;
   Friendbot creates it again ([OpenBao](runbook.md#openbao), step 6).
4. `AccessDenied` on `PutMetricData`: the function's role changed; redeploy the Watch stack.
5. The protocol section: `status 5xx`, a timeout or `no protocol versions` means that network's
   Horizon (`watch.protocol` in the infra config) is down or answering something else; mainnet's
   counts too, though we don't serve it yet. Check it in a browser; it usually passes by itself.

While this alarm stays in ALARM, a failure of the other section sends no new message: both share
it. Read the log for every `watch_section_failed` until it is back to OK, not only the first one.

### watch-no-invocations

The check hasn't run for 15 minutes, so the balance and protocol alarms see nothing.

1. The schedule: `aws scheduler get-schedule --name x402-production-watch` (state `ENABLED`,
   `cron(0/5 * * * ? *)`).
2. The function: it exists, and its `Throttles` metric is 0 (it is limited to one run at a time).
3. If the Watch stack was deleted or never deployed, deploy it (`make deploy-production-watch` in
   `infra/`). On a fresh account, deploy Watch before Alarms ([infra/README.md](../infra/README.md)).

### upstream-changed

Upstream x402 `main` changed, since the gate's pin, a file the gate's suite rests on or the
discovery spec. Nothing breaks for us: the gate still runs the pinned suite. It means a seller or
buyer on the newest x402 libraries may no longer match what we tested.

1. Read the 08:00 run's `watch_upstream` line: `changed` lists the files.
2. Read the change upstream: `https://github.com/x402-foundation/x402/commits/main/<file>`.
3. If it changes what a payment or a listing looks like, bump `UPSTREAM_COMMIT` in
   `conformance/src/upstream.ts` and rerun the gate (`conformance/README.md`); the next 08:00 run
   publishes 0 and the alarm goes back to OK. If not, say in the channel why the pin stays.

While it stays in ALARM, a later upstream change sends no new message: read the daily
`watch_upstream` line until the pin moves.

### upstream-silent

The upstream section published nothing for two days, so `upstream-changed` sees nothing.

1. Read the 08:00 runs for `watch_section_failed` with `section: upstream`: the error names the
   file.
2. `answered 404`: upstream moved or deleted a file, a change to read like `upstream-changed`;
   update `FILES` in `infra/src/watch/upstream.ts` and deploy the Watch stack.
3. `answered 429` or `5xx`, or a timeout: GitHub refused or was slow; it usually passes by itself.
4. `expected one commit`: `conformance/src/upstream.ts` no longer holds exactly one commit hash.

## The facilitator

The facilitator writes its metrics as EMF lines (#112) in the stream `facilitator` of
`/x402/production/metrics`, every minute for its gauges and sweeps, and at once for each event.
A stopped process writes nothing: Level alarms then keep their last state and Event alarms read
OK, so [facilitator-silent](#facilitator-silent) is the one that says so. The events named below
are the `event` field of its log lines (The logs, above). The pool's own events
(`channel-quarantined`, `sequence-resync`, `send-retry`, `fee-raised`) are counted in
`pool_events_total`, not logged, so the log doesn't name their channel yet (task 0125). Only
`sequence-resync` has a `type` dimension in `x402-facilitator`; the others go into the network's
total alone. Each count is in the `type` field of its EMF line, so Logs Insights on
`/x402/production/metrics` finds them:

```
filter type = "fee-raised" | stats sum(pool_events_total) by bin(5m)
```

### facilitator-silent

No sweep line from the facilitator for 15 minutes, though it writes one every minute: the process
is down, its start hangs or fails (a crash loop included), or its lines don't reach CloudWatch. It
fires beside [uptime](#uptime) when the process is down.

1. If `uptime` fires too, follow it: the process is down.
2. If not, the facilitator runs but its lines don't arrive: on the server,
   `systemctl status x402@production`, then check [telemetry-silent](#telemetry-silent) and the
   agent.

### gauges-silent

One of the facilitator's gauges sent no point for 15 minutes while the sweeps did: its read keeps
throwing, and that gauge's own alarm keeps its last state. The gauges are
`settlement_oldest_open_seconds`, `pool_queued`, `pool_quarantined`, `rpc_on_fallback`,
`rpc_stalled_seconds` and `balance_reading_age_seconds`, and `channel_longest_hold_seconds` once
the `channelHeld` group is on.

1. In the CloudWatch metrics console, namespace `x402-facilitator`, find the gauge with no recent
   point.
2. Find the error in the app logs around the time it stopped; its event names the read.

### http-500

The facilitator answered status 500 on some route: an error it doesn't classify, so it counts it
as ours. A burst sends one message. A 503 isn't counted: `verify-rpc-unavailable` covers
`/verify`'s, and a lease or drain 503 on `/settle` is routine.

1. In Logs Insights on `/x402/production/app`, the `level = "error"` lines around that time:
   `fields @timestamp, event, @message | filter level = "error" | sort @timestamp desc | limit 50`.
2. Fix the cause, or classify the error so it gets its own answer.

### verify-rpc-unavailable

`/verify` answered 503 `rpc_unavailable`: upstream's call gave no answer within 10 s on every RPC
URL, or the facilitator's ledger read failed on every URL. Sellers can't check payments, so buyers
are refused. A burst sends one message.

1. In Logs Insights on `/x402/production/app`, the `verify_rpc_unavailable` and `rpc_exhausted`
   lines around that time: `rpc_exhausted` names each `RPC_URLS[i]#fingerprint` and why it failed.
2. If every URL timed out and `rpc-stalled` stays quiet, the ledger still moves: check Horizon
   (`horizon.stellar.org` or `horizon-testnet.stellar.org`). Upstream's verify reads it on every
   payment, with no timeout of its own, so a hung Horizon times out every RPC URL.
3. Otherwise fix the endpoint, or reorder `RPC_URLS` ([runbook, Credentials](runbook.md#credentials)).

### rpc-stalled

The latest ledger read through the facilitator's RPC hasn't moved for over 120 s, for 5 minutes:
the active endpoint is frozen or unreachable, and verify and settle read stale state. `ready`
doesn't show this.

1. The `rpc_failover` and `rpc_failback` events say which endpoint is in use. The endpoints are
   named `RPC_URLS[i]#fingerprint`, never by URL.
2. Fix the endpoint, or reorder `RPC_URLS` ([runbook, Credentials](runbook.md#credentials)).

### rpc-on-fallback

The facilitator has run on a fallback RPC endpoint for 15 minutes, every sample: a fallback that
lags answers valid payments with rejections. Its return to OK is the recovery.

1. The `rpc_failover` event says why endpoint 0 failed.
2. Fix it, or reorder `RPC_URLS` so a healthy one comes first.

### balance-stale

The fee account's last good balance reading is older than 300 s. The balance floor then fails
closed: settle refuses every payment with `facilitator_underfunded`, while `ready` stays 1 and
the off-server check may read the balance as fine.

1. Check the RPC first: [rpc-stalled](#rpc-stalled) and [rpc-on-fallback](#rpc-on-fallback).
2. The floor's failed reads are in the app logs. A floor set to anything but 300 s logs
   `balance_stale_threshold_mismatch` at startup.

### pending

A settlement has been open for over 900 s, past the 750 s a record can last at the cap:
reconciliation isn't closing it.

1. The `settlement_reconcile_failed` and `reconcile_failed` events, and the record's rows in
   `settlement_hashes`.
2. Records left by [history-gone](#history-gone) aren't counted, but are counted again after a
   restart until a sweep reads their history.
3. A sweep that hangs after one that left nothing open reads 0 here: that is
   [sweeps-stopped](#sweeps-stopped)'s.

### sweeps-stopped

No reconciliation sweep listed the open records for 5 minutes: sweeps fail or hang, so a stuck
settlement stays stuck. A live process writes 0 here, so this isn't the process being down.

1. The `reconcile_failed` events.
2. If a sweep hangs, restart the facilitator while `/settle` is idle:
   `sudo systemctl restart x402@production` (it drains first).

### settlement-expired

A settlement expired: reconciliation found none of its transactions landed by its ledger bound,
so the payer's payment didn't settle and the payer has to sign a new one. One is rare; several
mean submissions don't land.

1. The `reconcile_finished` event and the record's `settlement_hashes` for its attempts.
2. The `fee-raised` and `send-retry` counts around that time (counts only, task 0125), and the
   RPC ([rpc-stalled](#rpc-stalled)). In Logs Insights on `/x402/production/metrics`:

   ```
   filter type in ["fee-raised", "send-retry"] | stats sum(pool_events_total) by type, bin(5m)
   ```

### landed-after-expired

A transaction landed after its record was marked expired: the payer may have been told the
payment failed while it settled.

1. The `settlement_landed_after_expired` event names the record.
2. Reconcile it with the payer: the money moved once, on chain.

### history-gone

A settlement record has hashes the RPC's history no longer reaches, so it stays open until someone
closes it. Every restart or deploy reports each such record again, and this sends one message for
them, so read the log for each record.

1. The `settlement_history_gone` events: match each `settlementKey` against the records already
   being handled.
2. Check its hashes on Horizon, and close the record by hand (0019 decision 22).

### submit-failed

Settle failed with `unexpected_settle_error` before anything was sent: the payer got status 200
with `success: false`, which [http-500](#http-500) doesn't see.

1. The `settlement_submit_failed` event has the error. It is a bug or an outage we don't classify
   yet.

### refused-after-verify

Settle refused, at the pool, a payment that verify had accepted: the fee went over its cap, or the
ledger bound passed while it waited.

1. The `settlement_refused_after_verify` event has the reason.
2. A wait: check [queue-waiting](#queue-waiting). A fee: check the fee settings.

### failure-ours

A settlement failed for a reason put down to us, not to the payer, the seller or the asset.

1. The `spend_failure_ours` event has the reason.

### signer-failures

OpenBao didn't give a usable signature (sealed, denied, or a wrong key): settlement fails. The
check after start counts each retry, and this sends one message for them.

1. The `signer_failed` event has the reason and the step.
2. OpenBao's state: [openbao-down](#openbao-down), then its audit log
   ([runbook, OpenBao](runbook.md#openbao)).

### store-outage

A write to Postgres failed: a settlement record, or the spend store. Settle answers may be missing
from the records, and the spend policy may be blind.

1. On the server, the alarm's network's database: `systemctl status x402-db-testnet@production`
   and `/var/log/x402/production/postgres-testnet.log` for testnet.
2. The `settlement_record_failed` and `spend_store_failed` events name the operation.

### hook-failures

A settlement hook threw: the spend policy's fee count, failure count or breaker may have missed a
final settlement, so budgets and breakers count low.

1. The `settlement_hook_failed` event names the hook and the error.
2. If the store is the cause, `spend_store_failed` too ([store-outage](#store-outage)).

### queue-waiting

Settle has waited for a free channel for 3 minutes, every sample: every channel is busy or out of
the pool.

1. Check [channel-quarantined](#channel-quarantined) and the traffic.
2. If load holds them rather than faults, add channels ([runbook, OpenBao](runbook.md#openbao)).

### channel-quarantined

A channel was taken out of the pool since the facilitator started, so the pool settles with fewer
channels.

1. The pool takes a channel out only when the RPC still answers, at the end of the read's
   timeout, that the channel's account doesn't exist; a read that fails or times out keeps the
   channel. So the usual cause is a channel account that is gone, such as after a testnet reset,
   or an RPC behind on a new account. `pool_quarantined` in `x402-facilitator` says how many are
   out.
2. The `settlement_submit_failed` event names the channel: its error reads
   `Account not found: <channel>`, and [submit-failed](#submit-failed) fires beside this alarm.
   In Logs Insights on `/x402/production/app`:
   `filter event = "settlement_submit_failed" and @message like /Account not found/`.
3. Look the channel up on Horizon (`/accounts/<channel>`). If it is gone, make new channels with
   `create-channels.ts` ([runbook, OpenBao](runbook.md#openbao), step 6) and put their addresses
   in `CHANNELS_TESTNET` ([runbook, Before the first deploy](runbook.md#before-the-first-deploy)).
4. A restart puts the channels back, once the reason is fixed.

### pool-health

Channels resynced their sequence numbers 5 times or more in 5 minutes: something else uses the
channel accounts, or submissions keep failing.

1. `pool_events_total` with `type` `sequence-resync` shows when they happened; the log doesn't
   name the channels yet (task 0125). Each channel account's transactions on Horizon show who
   else used it.
2. Make sure no other process holds the facilitator key. A use no one on the team explains is a
   theft of the key (ADR 0013).

### breaker-opened

A spend breaker opened (0024): a payer's settlements (`-payer`), settlements to one seller
(`-pay-to`), or one wasm token's transfers (`-asset`) failed on chain past their limit, and their
payments are refused for the cool-down.

1. The `spend_breaker_opened` event names the scope.
2. Then the failures that tripped it.

### budget-nearing

A fee budget (asset, other or global) passed its nearing level: at its limit, settlement for that
scope stops until the window rolls (0024).

1. The `spend_budget_nearing` event names the scope, with the used and maximum stroops.
2. Raise the budget only if the traffic is real.

### commit-unmatched

A settled fee counts against no budget: its reservation was never made, or was pruned meanwhile,
so the fee budgets count low.

1. The `spend_commit_unmatched` event has the key and the state; compare it with the settlement
   record.

## The server

The host probe (`x402-host-probe.timer`, every minute) writes the server's checks to
`/var/log/x402/host/metrics.log`, shipped as the stream `host` of `/x402/production/metrics`; the
agent adds memory and disk. A failed check, or a job that never ran, writes a value past its
threshold, so a broken check alarms rather than reading as healthy. With the probe stopped, its
alarms (`openbao-down`, `certificate`, `credentials-stale`, and the backups' and snapshot's)
keep their state, and [probe-silent](#probe-silent) fires. `audit-disk` comes from the agent,
covered by [telemetry-silent](#telemetry-silent); `facilitator-failed` and `watchdog-restart`
are written by the units themselves.

### openbao-down

OpenBao has been down, sealed, or failing its check on testnet's socket for 3 minutes: the
facilitator can't sign, so settlement stops. A signature that fails while OpenBao is up is
[signer-failures](#signer-failures)'.

1. `systemctl status x402-openbao` and `/var/log/x402/openbao/openbao.log`.
2. Unseal or restart it as the [runbook's OpenBao section](runbook.md#openbao) says.

### disk

The server's `/` is over 80% used for 15 minutes. It is shared with ClickHouse and Postgres, and
holds OpenBao's audit volume: at 90% [audit-disk](#audit-disk) fires, the last call before
signing stops. At 80% about 334 GB of 1.67 TB is left, days at any rate seen so far.

1. `df -h /`, then what is ours:
   `sudo du -sh /var/log/x402 /var/lib/docker/volumes/x402-* 2>/dev/null | sort -h`, and the
   images (`sudo docker system df`). The WAL archive and pgBackRest's repository come with 0026.
2. Free what is ours; tell the ClickHouse project's owners if their data is what grew (the Prices
   API watches it as `prices-production-ch-disk-free`).

### audit-disk

OpenBao's audit volume, on `/`, is 90% used or more: [disk](#disk) warned at 80%. The disk is shared with ClickHouse and
Postgres; when it fills, OpenBao refuses the requests it can't audit, and signing stops (ADR 0013).

1. Check that the audit log rotates ([runbook, OpenBao](runbook.md#openbao)): `audit.log.1`
   beside a fresh `audit.log`.
2. `df -h /`, then what is ours:
   `sudo du -sh "$(sudo docker volume inspect -f '{{.Mountpoint}}' x402-openbao-audit)" /var/log/x402`.
   Free what is ours, and tell the ClickHouse project's owners if their data is what grew.

### memory

The server's memory has stayed over 90% used for 15 minutes (`Minimum` of every sample, so a
lasting squeeze, not a merge's spike). ClickHouse shares the machine, held to its own limit.

1. `docker stats --no-stream` for our containers and ClickHouse's, and
   `sudo journalctl -k | grep -i oom` for the kernel's OOM kills.
2. If ClickHouse is what grew, tell its project's owners; if ours, restart what holds it after a
   deploy window is agreed.

### facilitator-failed

`x402@production` ended other than in success: a crash, a failed start, a drain cut short, a
dockerd crash, or the watchdog's kill of a hung process ([watchdog-restart](#watchdog-restart)
fires beside it). A crash after `ready` in cycles of a minute or more never reaches the unit's
start limit, so this is what shows it. A planned stop doesn't fire it: the unit takes Compose's
130 after a stop as a success.

1. Its line in `/var/log/x402/host/metrics.log` has `result` and `exit_status`.
2. Then the end of `/var/log/x402/production/facilitator.log` and `facilitator.err.log` before it
   ([runbook, The watchdog](runbook.md#the-watchdog)).

### watchdog-restart

The watchdog stopped an unhealthy facilitator and restarted its unit. A stopped watchdog sends
nothing here: a hung facilitator is then left to [uptime](#uptime).

1. The app log before the restart, and `journalctl -u x402-watchdog@production`
   ([runbook, The watchdog](runbook.md#the-watchdog)).

### probe-silent

No heartbeat from the host probe for 15 minutes, so the probe's alarms are blind: OpenBao, WAL,
the backups, the snapshot, the certificate and the agent's credentials.

1. If [telemetry-silent](#telemetry-silent) fires too, the agent is the fault: follow it.
2. If not: `systemctl status x402-host-probe.timer x402-host-probe.service` and
   `journalctl -u x402-host-probe -n 30`.

### telemetry-silent

No memory or disk reading from the server's CloudWatch agent for 15 minutes: the agent, its
Roles Anywhere credentials or the server's way out is down, so no log or metric line arrives
either; or its config lost one of the two series.

1. On the server: `systemctl status amazon-cloudwatch-agent x402-cloudwatch-credentials.timer`,
   and the agent's log, `/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log`.
2. Then [credentials-stale](#credentials-stale) and [certificate](#certificate).

### credentials-stale

The agent's credentials file is older than 125 minutes, or missing: the signing helper's hourly
run has failed twice. Its 12-hour keys still ship for now; when they expire, no log or metric line
reaches CloudWatch.

1. `sudo journalctl -u x402-cloudwatch-credentials -n 20`.
2. Then the certificate, the key and the ARNs in `/etc/x402/cloudwatch-credentials.env`
   ([runbook, The CloudWatch agent](runbook.md#the-cloudwatch-agent)).

### certificate

The Roles Anywhere certificate the agent ships logs with has under 30 days left, or its check
fails. When it expires, no log or metric line reaches CloudWatch.

1. Renew it as the [runbook's CloudWatch agent section](runbook.md#the-cloudwatch-agent) says:
   a new key and CSR on the server, signed by the ClickHouse project's CA holder, committed by pull
   request to `deploy/production`.

## Log volume

### log-volume

`/x402/production/app` or `/x402/production/metrics` (the alarm's name ends in `-app` or
`-metrics`) took over 200 MB in an hour: a flood of lines, on the bill and on the server's disk.

1. In Logs Insights on that group, the line that repeats. The app group:
   `stats count() by @logStream, event | sort count() desc | limit 10` (only the facilitator's
   lines have an `event`; the other streams are its own Postgres, tunnel, OpenBao and deploy). The
   metrics group, whose lines have no `event`: `stats count() by @logStream`.
2. Then its cause. `x402-logrotate.timer` keeps the files on the server to 10 × 100 MB each.

## Protocol

The check reads each network's protocol from Horizon (`current_protocol_version`, and
`core_supported_protocol_version`, the highest version the Stellar Core behind that Horizon
supports: SDF's Horizon fleet, so an upgraded Core build there, not the validators' vote). The
alarms compare them with two numbers per network in `watch.protocol` in
`infra/envs/production.json`: `expected`, the protocol we have checked the facilitator against,
and `supported`, the highest Core version we have checked the SDK and the RPC against.
`supported` is never below `expected`. On 2026-11-09 testnet was 30/30 and mainnet 29/30: mainnet
runs 29, its Core supports 30, and testnet has run 30 since 2026-11-03, when an older SDK stopped
reading its ledgers, which no alarm saw (task 0111 moved the SDK to 16.4.1).

### protocol-changed

The network now runs a protocol above the version we run against: it upgraded.

1. On a network we serve (testnet today), check that the facilitator still works: `/health`, and
   a payment through `/verify` and `/settle`. On one we don't serve yet (mainnet), skip this step.
2. Check that `@stellar/stellar-sdk` and the RPC support the new version (their release notes);
   upgrade the SDK if they don't.
3. Raise `expected` for that network to the new version in a PR, and `supported` with it if it is
   lower (the config refuses `supported` below `expected`); merge it and deploy the alarms
   (`make deploy-production-alarms` in `infra/`). The alarm goes back to OK and re-arms for the
   next version.

### protocol-upgrade-coming

The Stellar Core behind the network's Horizon supports a protocol above `supported`, the highest
we have checked: SDF has upgraded its Core, and the validators can vote the upgrade once enough
of them run it. Mainnet was in this state on 2026-11-06 (29, Core supporting 30), before
`supported` was set to 30, the version testnet already runs.

1. Find the upgrade's date in Stellar's announcements (the network's upgrade schedule).
2. Plan a test of the SDK and the RPC against the new version on testnet, which usually upgrades
   weeks earlier, before it reaches a network we serve.
3. Raise `supported` for that network to the new version in a PR and deploy the alarms: this one
   goes back to OK. `protocol-changed` fires on the upgrade itself, with its own `expected`.

## Every metric

Every metric in [`@stellar-x402/metrics-catalog`](../packages/metrics-catalog/src/index.ts), then
the AWS metrics the alarms read. What each one measures and where it comes from is in
[G-metrics](../lore/1-tasks/active/0027_FEATURE_alerts-and-metrics/notes/G-metrics.md). A dimension
set marked "only" is written for those values alone; "none" is a series with no dimension. A metric with no alarm is read in Logs Insights or in
the weekly review. `infra/test/alarms.test.ts` fails when the catalog gains a metric this table
lacks.

| Metric                                  | Namespace          | Kind, unit     | Dimensions                                               | Alarms                                                                                                        |
| --------------------------------------- | ------------------ | -------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `settlement_outcomes_total`             | `x402-facilitator` | counter, Count | `network`, `result`                                      | none                                                                                                          |
| `settlement_refused_after_verify_total` | `x402-facilitator` | counter, Count | `network`, `stage` (stage pool only)                     | [refused-after-verify](#refused-after-verify)                                                                 |
| `settlement_record_failures_total`      | `x402-facilitator` | counter, Count | `network`                                                | [store-outage](#store-outage)                                                                                 |
| `settlement_history_gone_total`         | `x402-facilitator` | counter, Count | `network`                                                | [history-gone](#history-gone)                                                                                 |
| `settlement_landed_after_expired_total` | `x402-facilitator` | counter, Count | `network`                                                | [landed-after-expired](#landed-after-expired)                                                                 |
| `settlement_rewrapped_total`            | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `signer_failures_total`                 | `x402-facilitator` | counter, Count | `network`                                                | [signer-failures](#signer-failures)                                                                           |
| `pool_events_total`                     | `x402-facilitator` | counter, Count | `network`; `network`, `type` (type sequence-resync only) | [pool-health](#pool-health)                                                                                   |
| `settlement_uncertain_total`            | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `settlement_submit_failures_total`      | `x402-facilitator` | counter, Count | `network`                                                | [submit-failed](#submit-failed)                                                                               |
| `settlement_budget_exhausted_total`     | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `settlement_reconciled_total`           | `x402-facilitator` | counter, Count | `network`; `network`, `state` (state expired only)       | [settlement-expired](#settlement-expired)                                                                     |
| `settlement_reopened_total`             | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `settlement_lease_fenced_total`         | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `settlement_hook_failures_total`        | `x402-facilitator` | counter, Count | `network`                                                | [hook-failures](#hook-failures)                                                                               |
| `settlement_already_settled_total`      | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `settlement_nonce_reuse_total`          | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `lease_changes_total`                   | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `store_prune_failures_total`            | `x402-facilitator` | counter, Count | none                                                     | none                                                                                                          |
| `catalog_internal_errors_total`         | `x402-facilitator` | counter, Count | none                                                     | none                                                                                                          |
| `catalog_attempts_total`                | `x402-facilitator` | counter, Count | none                                                     | none                                                                                                          |
| `catalog_upsert_failures_total`         | `x402-facilitator` | counter, Count | none                                                     | none                                                                                                          |
| `catalog_attempt_write_failures_total`  | `x402-facilitator` | counter, Count | none                                                     | none                                                                                                          |
| `catalog_route_template_ignored_total`  | `x402-facilitator` | counter, Count | none                                                     | none                                                                                                          |
| `discovery_unknown_params_total`        | `x402-facilitator` | counter, Count | none                                                     | none                                                                                                          |
| `spend_breaker_opened_total`            | `x402-facilitator` | counter, Count | `network`, `breaker`                                     | [breaker-opened](#breaker-opened)                                                                             |
| `spend_budget_nearing_total`            | `x402-facilitator` | counter, Count | `network` (budget asset/other/global only)               | [budget-nearing](#budget-nearing)                                                                             |
| `spend_failure_attributed_total`        | `x402-facilitator` | counter, Count | `network`, `fault` (fault ours only)                     | [failure-ours](#failure-ours)                                                                                 |
| `spend_commit_unmatched_total`          | `x402-facilitator` | counter, Count | `network`                                                | [commit-unmatched](#commit-unmatched)                                                                         |
| `spend_store_failures_total`            | `x402-facilitator` | counter, Count | `network`                                                | [store-outage](#store-outage)                                                                                 |
| `spend_refused_total`                   | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `balance_read_failures_total`           | `x402-facilitator` | counter, Count | `network`                                                | none                                                                                                          |
| `http_requests_total`                   | `x402-facilitator` | counter, Count | `route`; `status` (status 500 only)                      | [http-500](#http-500)                                                                                         |
| `settlement_sweeps_total`               | `x402-facilitator` | counter, Count | `network`, `outcome`                                     | [facilitator-silent](#facilitator-silent), [gauges-silent](#gauges-silent), [sweeps-stopped](#sweeps-stopped) |
| `settlement_oldest_open_seconds`        | `x402-facilitator` | gauge, Seconds | `network`                                                | [gauges-silent](#gauges-silent), [pending](#pending)                                                          |
| `pool_queued`                           | `x402-facilitator` | gauge, Count   | `network`                                                | [gauges-silent](#gauges-silent), [queue-waiting](#queue-waiting)                                              |
| `pool_quarantined`                      | `x402-facilitator` | gauge, Count   | `network`                                                | [channel-quarantined](#channel-quarantined), [gauges-silent](#gauges-silent)                                  |
| `rpc_on_fallback`                       | `x402-facilitator` | gauge, None    | `network`                                                | [gauges-silent](#gauges-silent), [rpc-on-fallback](#rpc-on-fallback)                                          |
| `rpc_stalled_seconds`                   | `x402-facilitator` | gauge, Seconds | `network`                                                | [gauges-silent](#gauges-silent), [rpc-stalled](#rpc-stalled)                                                  |
| `balance_reading_age_seconds`           | `x402-facilitator` | gauge, Seconds | `network`                                                | [balance-stale](#balance-stale), [gauges-silent](#gauges-silent)                                              |
| `fee_charged_stroops`                   | `x402-facilitator` | counter, None  | `network`                                                | none                                                                                                          |
| `channel_longest_hold_seconds`          | `x402-facilitator` | gauge, Seconds | `network`                                                | `channel-held` (off), [gauges-silent](#gauges-silent)                                                         |
| `openbao_up`                            | `x402-host`        | gauge, None    | none                                                     | [openbao-down](#openbao-down)                                                                                 |
| `wal_failing`                           | `x402-host`        | gauge, None    | none                                                     | `wal-failing` (off)                                                                                           |
| `wal_last_archived_age_seconds`         | `x402-host`        | gauge, Seconds | none                                                     | `wal-stale` (off)                                                                                             |
| `backup_age_seconds`                    | `x402-host`        | gauge, Seconds | none                                                     | `backup-age` (off)                                                                                            |
| `snapshot_age_seconds`                  | `x402-host`        | gauge, Seconds | none                                                     | `snapshot-age` (off)                                                                                          |
| `certificate_days_left`                 | `x402-host`        | gauge, None    | none                                                     | [certificate](#certificate)                                                                                   |
| `host_probe_heartbeat`                  | `x402-host`        | gauge, None    | none                                                     | [probe-silent](#probe-silent)                                                                                 |
| `credentials_age_seconds`               | `x402-host`        | gauge, Seconds | none                                                     | [credentials-stale](#credentials-stale)                                                                       |
| `watchdog_restarts_total`               | `x402-host`        | counter, Count | none                                                     | [watchdog-restart](#watchdog-restart)                                                                         |
| `facilitator_failures_total`            | `x402-host`        | counter, Count | none                                                     | [facilitator-failed](#facilitator-failed)                                                                     |
| `mem_used_percent`                      | `x402-host`        | gauge, Percent | none                                                     | [memory](#memory), [telemetry-silent](#telemetry-silent)                                                      |
| `disk_used_percent`                     | `x402-host`        | gauge, Percent | `path`                                                   | [audit-disk](#audit-disk), [disk](#disk), [telemetry-silent](#telemetry-silent)                               |
| `ready`                                 | `x402-watch`       | gauge, None    | none                                                     | [uptime](#uptime), [uptime-flapping](#uptime-flapping)                                                        |
| `spendable_stroops`                     | `x402-watch`       | gauge, None    | `network`                                                | [balance-critical](#balance-critical), [balance-low](#balance-low)                                            |
| `protocol_version`                      | `x402-watch`       | gauge, None    | `network`                                                | [protocol-changed](#protocol-changed)                                                                         |
| `protocol_supported_version`            | `x402-watch`       | gauge, None    | `network`                                                | [protocol-upgrade-coming](#protocol-upgrade-coming)                                                           |
| `upstream_files_changed`                | `x402-watch`       | gauge, Count   | none                                                     | [upstream-changed](#upstream-changed), [upstream-silent](#upstream-silent) (off)                              |
| `account_state_mismatches`              | `x402-watch`       | gauge, Count   | `network`                                                | `account-state` (off)                                                                                         |
| `account_effects_unexpected`            | `x402-watch`       | counter, Count | `network`                                                | `account-effects` (off)                                                                                       |
| `backup_secret_reads`                   | `x402-watch`       | counter, Count | none                                                     | `backup-secret-read` (off)                                                                                    |
| `Errors`                                | `AWS/Lambda`       | AWS's own      | `FunctionName` `x402-production-watch`                   | [watch-errors](#watch-errors)                                                                                 |
| `Invocations`                           | `AWS/Lambda`       | AWS's own      | `FunctionName` `x402-production-watch`                   | [watch-no-invocations](#watch-no-invocations)                                                                 |
| `EMFParsingErrors`                      | `AWS/Logs`         | AWS's own      | `LogGroupName` `/x402/production/metrics`                | [emf-parsing](#emf-parsing)                                                                                   |
| `EMFValidationErrors`                   | `AWS/Logs`         | AWS's own      | `LogGroupName` `/x402/production/metrics`                | [emf-validation](#emf-validation)                                                                             |
| `IncomingBytes`                         | `AWS/Logs`         | AWS's own      | `LogGroupName`, each of our log groups                   | [log-volume](#log-volume)                                                                                     |

## Drills

How an alarm was fired on purpose, so it can be done again. Times are UTC. The delivery test
(`make fire-test`) is under [emf-validation](#emf-validation).

### 2026-11-06: the balance alarms

- **Before:** say in `#stellar-x402-bot` that a drill is starting, so no one tops up or reads
  `balance-critical` as a theft. Check that the latest real `spendable_stroops` is above 25 XLM
  (250,000,000 stroops), or the next real point won't clear the alarms, and that `watch-errors`
  and `watch-no-invocations` are OK: without the check's next point both alarms stay in ALARM.
  Write the fake point for `stellar:testnet` only, never for a pubnet network.
- **How:** one fake `spendable_stroops` point of 50,000,000 stroops (5 XLM), below both
  thresholds (25 and 10 XLM), written by hand at 11:19:01 with the `stellar` SSO profile:

  ```sh
  aws cloudwatch put-metric-data --profile stellar --region eu-central-1 --namespace x402-watch \
    --metric-data \
    '[{"MetricName":"spendable_stroops","Dimensions":[{"Name":"network","Value":"stellar:testnet"}],"Value":50000000,"Unit":"None"}]'
  ```

- **What happened:** `Minimum` over the 11:15 period read 5 XLM. `balance-low-testnet` went to
  ALARM at 11:20:10 and `balance-critical-testnet` at 11:20:35; the check's next real point
  (99,988,728,192 stroops) put both back to OK at 11:25:10 and 11:25:35. Slack showed the four
  messages, each naming the fee account and the top-up step, in `#stellar-x402-bot`.
- **What it shows:** the alarms' thresholds, statistic and path to Slack. Not the check's own read
  of a low balance, which
  [infra/test/watch-balance.test.ts](../infra/test/watch-balance.test.ts) covers against a faked
  RPC.
- **In the metric's history:** CloudWatch can't delete the fake point, so `spendable_stroops` for
  `stellar:testnet` reads a 5 XLM minimum at 11:15 to 11:20 on 2026-11-06. It is the drill's, not a
  real balance.

### 2026-11-09: the stop window and fake points

- **Before:** posted in `#stellar-x402-bot` about 10 minutes ahead. All 47 alarms OK, no settlement
  open (`settlement_oldest_open_seconds` 0), no deploy running (`x402-deploy@production`
  inactive), the Watch function's reserved concurrency 1.
- **The stop window,** 13:26:45 to 13:45:43. On the server:

  ```sh
  sudo systemctl stop x402@production
  sudo systemctl stop x402-host-probe.timer x402-cloudwatch-credentials.timer amazon-cloudwatch-agent
  ```

  and the Watch function held at reserved concurrency 0, so the schedule's runs never started:

  ```sh
  aws lambda put-function-concurrency --region eu-central-1 \
    --function-name x402-production-watch --reserved-concurrent-executions 0
  ```

  The credentials timer stops too, so it can't start the agent mid-window. Back: `sudo systemctl
reset-failed x402@production`, the agent, the credentials timer and the probe timer started, then
  `x402@production`; the reserved concurrency back to 1, the stack's value. `/health` read
  `ready` at 13:46:44.

- **Fake points,** with `aws cloudwatch put-metric-data` and the admin SSO profile, testnet's
  dimensions (the protocol alarms both networks'):

  | When                         | Metric (namespace)                                                                                                                                                | Dimensions                    | Value                                            | For                                                                                                  |
  | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
  | Every minute, 13:28 to 13:43 | `pool_queued`, `rpc_on_fallback`, `rpc_stalled_seconds`, `settlement_oldest_open_seconds`, `balance_reading_age_seconds`, `pool_quarantined` (`x402-facilitator`) | `network`                     | 1, 1, 200, 1000, 600, 1                          | `queue-waiting`, `rpc-on-fallback`, `rpc-stalled`, `pending`, `balance-stale`, `channel-quarantined` |
  | The same minutes             | `credentials_age_seconds`, `openbao_up`, `disk_used_percent` (`x402-host`)                                                                                        | none; `path` `/`              | 8000, 0, 90                                      | `credentials-stale`, `openbao-down`, `audit-disk`                                                    |
  | Once, 13:48:19 to 13:48:26   | each Event alarm's counter, with its alarm's dimensions                                                                                                           | as the alarm                  | 1 (`pool_events_total` for `sequence-resync`: 5) | the 18 Event alarms                                                                                  |
  | 13:49 and 13:55              | `protocol_version`, `protocol_supported_version` (`x402-watch`)                                                                                                   | `network`, testnet and pubnet | testnet 31 and 31, pubnet 30 and 31              | the 4 protocol alarms                                                                                |

  The Level alarms' points went in while their producers were stopped: a `Minimum` alarm can't
  be moved while real samples arrive.

- **What happened:** 37 alarms went to ALARM between 13:29:22 and 13:55:52 and back to OK by
  14:19:31, each in the table above, all seen in Slack. `uptime` fired 7.5 minutes after the
  stop. With the agent stopped, `probe-silent` and `facilitator-silent` fired from its silence as
  much as from the probe's and the facilitator's.
- **What it shows:** the silence alarms against a real stop, and the other alarms' thresholds,
  statistics and path to Slack. Not that each producer writes the bad value; the unit tests cover
  that.
- **Found:** a planned stop of `x402@production` ended `failed` (Compose's 130 after systemd's
  stop signal) and counted `facilitator_failures_total`, so `facilitator-failed` fired at
  13:46:53 for the window's own stop. Fixed by #163 (`SuccessExitStatus=130`).
- **Not fired:** `gauges-silent` and `sweeps-stopped` need a partly broken process (gauges
  missing while sweeps run, sweeps that run but list nothing), which neither a stop nor a fake
  point can cause safely; `log-volume`, `emf-parsing` and `watch-errors` read `AWS/` namespaces,
  which take no hand-written point; `certificate` reads the hour's `Maximum`, and every hour holds
  the probe's real days left.
- **In the metrics' history:** CloudWatch can't delete a point. The values above, from 13:28 to
  13:55 on 2026-11-09, are the drill's, not real readings.

### 2026-11-09: the disk alarm

- **After the deploy** that turned `disk` (80%) and `memory` (90%) on and raised `audit-disk` to 90%
  (15:11:44 UTC, decision 73): `make fire-test` at 15:13:28, seen in Slack; each new alarm sent one
  OK when it first read data (15:13).
- **How:** one fake `disk_used_percent` point of 85% on `/` a minute, 15:15:46 to 15:30:03, with
  the admin SSO profile: above `disk`'s 80%, below `audit-disk`'s 90%.
- **What happened:** `disk-root` went to ALARM at 15:26:16, after 3 five-minute periods above 80%,
  and back to OK at 15:36:16 on the real 60%. `audit-disk` stayed OK: the warning comes first.
- **Not fired: `memory`.** It takes the `Minimum` of every sample, and the agent writes a real one
  (about 3%) every minute, so a fake point can't move it without stopping the agent again.
- **In the metrics' history:** `disk_used_percent` for `/` reads 85% from 15:15 to 15:30 on
  2026-11-09: the drill's, not a real reading.
