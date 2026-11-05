# infra

The facilitator's AWS side, in CDK (task 0027): the logging role the server's CloudWatch agent
assumes, the alarms and their path to Slack, and the uptime probe. Everything is in
`eu-central-1` on the team's shared account, deployed by hand with SSO; no workflow holds AWS
credentials (0027 decision 3). The account's existing default bootstrap is used.

The alarms are listed, with the reasoning behind each shape, in
[the alarm list](../lore/1-tasks/active/0027_FEATURE_alerts-and-metrics/notes/G-alarm-list.md);
the metrics they read in [`@stellar-x402/metrics-catalog`](../packages/metrics-catalog). Where
this code came from in the sibling projects is in
[R-infra-patterns](../lore/1-tasks/active/0027_FEATURE_alerts-and-metrics/notes/R-infra-patterns.md).

## Stacks

No stack takes anything from another (decision 27): alarms find metrics, log groups and functions
by name, so each one deploys alone.

| Stack                       | What                                                                                                                                                                                                                        | Changes                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `X402-production-Telemetry` | IAM Roles Anywhere trust anchor (the ClickHouse project's client CA), profile, the logging role, `/x402/production/app` and `/x402/production/metrics` (30 days, kept on a stack delete, not on a failed create's rollback) | Rarely: IAM on a shared account |
| `X402-production-Alarms`    | SNS topic `x402-production-alarms`, Amazon Q Developer (Chatbot) to `#stellar-x402-bot`, the alarms of the groups that are on                                                                                               | Thresholds, groups going on     |
| `X402-production-Uptime`    | `x402-production-uptime-probe`: reads `/health` every minute, publishes `ready` to `x402-watch`                                                                                                                             | The probe's code                |

The logging role trusts only `CN=x402-cloudwatch-agent-production` from that CA, and only on
our trust anchor. It can only create streams in and write to the two log groups, and put metrics
in `x402-host`, all from the server's IP. It reads nothing and can't reach a secret.

The `x402-host` condition binds `PutMetricData` only. An EMF line written with `PutLogEvents` to
`/x402/production/metrics` can name any namespace, `x402-watch` included, so the role doesn't
guard the off-server alarms. Their statistics do, since a forged point can't hide a real one from
`Minimum` (a balance, `ready`) or `Maximum` (a count), and so do the `AWS/Lambda` alarms on the
Lambdas' silence (G-alarm-list, "Statistics"). A forged point can still hold an alarm in ALARM, so
#115's check also posts each theft finding to the topic itself (decision 64).

The same path reaches the shared account's other namespaces, such as `SorobanBlockExplorer/Indexer`,
which other projects alarm on, and EMF lines can create custom metrics there without limit. Their
owners are told before `host` goes on (decision 65). `log-volume` is the ceiling: it goes on with
`host`, and synth refuses `host` without it.

## Before the first deploy

1. `aws sso login --profile stellar && export AWS_PROFILE=stellar` (the account that profile points to).
2. Node 22 and `pnpm install --frozen-lockfile` at the repo root.
3. The SSM parameters the stacks read at deploy, plain `String`, set once by hand in
   `eu-central-1`. They stay out of this public repo:

   | Parameter                             | Value                                                                                          |
   | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
   | `/x402/production/server-ip`          | The server's public IPv4, bare (no `/32`): the box `/soroban/production/ch-ip` points at       |
   | `/x402/production/slack-workspace-id` | `T…`, the same workspace as the explorer's (`/soroban-explorer/production/slack-workspace-id`) |
   | `/x402/production/slack-channel-id`   | `C…`, `#stellar-x402-bot`                                                                      |

   ```bash
   aws ssm put-parameter --region eu-central-1 --type String --name /x402/production/server-ip --value <IPv4>
   ```

4. In Slack, `/invite @aws` in `#stellar-x402-bot`. The workspace is already authorized in Amazon
   Q Developer on the account, so no console step. A channel configuration made by hand for the
   same channel should be removed first.

## Commands

From `infra/`:

```bash
make synth-production           # no AWS access needed
make diff-production            # all stacks, --strict
make deploy-production          # prints the full diff, then deploys all stacks
make deploy-production-alarms   # one stack: -telemetry, -uptime, -alarms (diff first, --exclusively)
make fire-test                  # the delivery test, after every deploy of the alarms
make check-series GROUP=host    # before a group goes on
make check-emf-disabled         # once, when the alarms first go on
make telemetry-arns             # what the server's credential helper is started with
```

Every deploy is agreed separately: the account is shared. After a deliberate delete of the Telemetry stack, its log
groups stay, and a new deploy fails on them until they are imported (`cdk import`) or deleted. Read the diff for removals too:
`--require-approval broadening` stops only on IAM widening.

**The delivery test** (decision 12, ADR 0011): a deploy of the alarms is done only when a person
sees `make fire-test`'s message in `#stellar-x402-bot`. It sets `x402-production-emf-validation`
(or `ALARM=<name>`) to ALARM and prints the alarm's action history: a publish that SNS refused
shows only there. If the history says the action succeeded and Slack shows nothing, Chatbot's log
is in `us-east-1`, `/aws/chatbot/x402-production-alarms`.

## Alarm groups

A group in `envs/production.json`'s `alarmGroups` is either absent or on with its actions; no alarm
exists with its actions off (decision 26).

| Group         | Alarms                                                                                                                                         | On when                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `uptime`      | `uptime`, `uptime-flapping`                                                                                                                    | The probe's `ready` has data, a few minutes after the Uptime stack's deploy (decision 37) |
| `telemetry`   | `emf-validation`, `emf-parsing`                                                                                                                | On                                                                                        |
| `facilitator` | Availability and Settlement, `facilitator-silent`, `gauges-silent`                                                                             | The facilitator's metric lines reach CloudWatch (#113)                                    |
| `channelHeld` | `channel-held`                                                                                                                                 | 0089 emits its gauge                                                                      |
| `host`        | `openbao-down`, `certificate`, `credentials-stale`, `watchdog-restart`, `facilitator-failed`, `probe-silent`, `telemetry-silent`, `audit-disk` | #113's probe and agent run, after its restart window                                      |
| `backups`     | `wal-failing`, `wal-stale`, `backup-age`                                                                                                       | pgBackRest archives WAL and has made a backup (0026; decision 40)                         |
| `snapshots`   | `snapshot-age`                                                                                                                                 | OpenBao's daily snapshot has run (0026; decision 40)                                      |
| `disk`        | `disk` per mount                                                                                                                               | A threshold read against the first numbers, `host.diskMounts` set                         |
| `memory`      | `memory`                                                                                                                                       | A threshold after a week of data                                                          |
| `logVolume`   | `log-volume` per log group                                                                                                                     | With `host` (#113), at a coarse 200 MB an hour until measured (decision 65)               |
| `watch`       | Money and security, `watch-errors`, `watch-no-invocations`                                                                                     | #115's off-server check runs as `x402-production-watch`                                   |

To turn one on: `make check-series GROUP=<group>` until it passes, then set the flag (and any
threshold it needs; synth refuses a group without one), `make deploy-production-alarms`, and
`make fire-test`. The check lists every series the group reads, and fails on one that is written
all the time (a gauge, the sweeps' zero, a Lambda's own metrics) but has no data in the last 3
hours. A failure counter is written only when the failure happens, so it can't be checked
beforehand; it travels the same path, and the catalog checks its name and dimensions at synth.

## Tests

`pnpm --filter @stellar-x402/infra test` synthesizes the stacks from `envs/production.json`, and
with every group on, and checks:

- every alarm's namespace, metric and dimensions against the catalog (`seriesDims`), and the AWS
  metrics against a short list;
- each alarm's shape, statistic, periods and missing-data rule against its row in the alarm list,
  read from the note itself;
- no `Unit`, ASCII only, descriptions under 1,024 characters, every alarm with its actions, OK
  messages only on Level and Silence alarms, no CPU or `metric-issue` alarm;
- the role's trust policy and permissions, the log groups' retention, Chatbot's logging, no
  topic policy, no stack importing from another;
- the probe against a faked `fetch`.

## Not checked before a deploy

- That Chatbot posts to the channel from this stack's configuration: the delivery test.
- That Roles Anywhere accepts the agent's certificate and the role works from the server's IP:
  #113's live check, after this stack is deployed and the certificate is signed.
- Whether CloudWatch aggregates a gauge's `Values` array as samples (`Minimum`, `Maximum`): the
  first deploy of #113.
- That the agent's own series match the catalog: `mem_used_percent` with no dimension and
  `disk_used_percent` with `path` `/` only. #113's config gets there with `omit_hostname` and a
  rollup to `path` with the original dropped (decision 44), tested against the catalog and, in
  #113's spike, against the agent's real `PutMetricData`. `make check-series GROUP=host` shows
  it before the group goes on.
- The metric-math alarms, `store-outage` and `gauges-silent`, fired on purpose. A read-only check
  on 2026-11-04 showed two of their parts: `FILL` returns 0 for a series never written, so a
  Silence alarm fires on one, and `gauges-silent`'s expression returns 1 while one gauge is
  missing. Each alarm is still fired once on purpose (AC).
- That requests from AWS reach `/health` through Cloudflare: the probe's first runs.
