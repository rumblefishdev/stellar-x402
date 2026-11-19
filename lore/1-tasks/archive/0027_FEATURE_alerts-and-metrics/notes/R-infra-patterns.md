---
title: "What #114 takes from the sibling projects' infra/"
type: research
status: developing
tags: [monitoring, cloudwatch, cdk, infra]
links:
  - ../README.md
  - G-alarm-list.md
  - S-pr112-spine.md
history:
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "Read the explorer's and the Prices API's infra/ before #114's code: what we copy, what we change and why."
---

# What #114 takes from the sibling projects' infra/

Read on 2026-11-04: `~/Projects/soroban-block-explorer/infra` at `a8bde63a` and
`~/Projects/stellar-prices-api/infra` at `7799bb32`. Same team, same shared AWS account, same
region (eu-central-1). Their code comments record what broke and why; most of what follows is
theirs.

## Taken as is

| What | From | Why |
| --- | --- | --- |
| `envs/<env>.json`, `src/bin/<env>.ts` reads it, `createApp(config)` validates it and builds the stacks | explorer `src/bin/production.ts`, `src/lib/app.ts` | One typed file per environment, checked before any construct exists |
| `validateConfig()` collects every error and throws once | explorer and Prices `types.ts` | A bad config fails synth with every reason, not one per run |
| Stacks named `${prefix}-<Stack>`, `env = { account: CDK_DEFAULT_ACCOUNT, region: config.awsRegion }` | explorer `app.ts` | The region comes from the config, never `--region` |
| `diff-<env>` with `--strict` | explorer Makefile | Without it `cdk diff` hides entries with non-ASCII characters (their 0312) |
| `deploy-<env>` prints the full diff, then `deploy --all --require-approval broadening` | explorer Makefile | A deploy of all stacks ships every pending change, a parked one too (their 0312 "stowaway") |
| Per-stack targets with `--exclusively` | Prices Makefile | Without it a stack's deploy also deploys the stacks it imports from (their 0141) |
| `bootstrap` with a no-op app and the explicit `aws://<account>/<region>` | Prices Makefile (their 0297) | A bare `cdk bootstrap` synthesizes the app first. The account is already bootstrapped (decision 3), so the target only documents it |
| ASCII only in anything that reaches the template | explorer `cloudwatch-stack.ts` | `cdk diff` reads non-ASCII back as `?`, so every such string shows as a change forever; a diff that's always noisy gets skimmed |
| SNS topic + `chatbot.SlackChannelConfiguration`, the workspace and channel IDs from SSM through `ssm.StringParameter.valueForStringParameter`, the parameter names in the config and checked to start with `/` | both | The repo is public; the IDs stay out of it, and synth needs no AWS access |
| Chatbot role with `CloudWatchReadOnlyAccess` | both | Chatbot reads the alarm's graph with it |
| Chatbot `loggingLevel: ERROR` | Prices (their 0112) | The default `NONE` makes the last hop unauditable: three SNS publishes reached nobody and no log said why |
| No `addToResourcePolicy` on the topic | explorer | An `AWS::SNS::TopicPolicy` replaces the topic's default policy; theirs muted every alarm twice (2026-08-18, 2026-08-27). The default policy lets same-account alarms publish |
| `FILL(m, 0)` for a silence alarm, `BREACHING` kept as a backstop | Prices (their 0222) | A `BREACHING`-only silence alarm didn't fire on a 3-hour halt. They measured that `FILL` needs no datapoint in the window |
| `MISSING`/`IGNORE` rather than `NOT_BREACHING` on a Level alarm whose source can stop | Prices, rollup tiers | Seven false "recovered" messages when the probe failed (our decision 19 takes `IGNORE`) |
| An alarm description names what covers its silence (`withLivenessNote`) | Prices `lambda-baseline.ts` | An OK that means "nothing ran" has to say so; ours names the witness from G-alarm-list |
| `PutMetricData` on `*` with a `cloudwatch:namespace` condition | Prices `eventbridge-stack.ts` | The action has no resource-level scoping |
| A Node Lambda as plain `.mjs` with `Code.fromAsset`, no bundling, `retryAttempts: 0`, its own log group with a retention | explorer `galexie-protocol-watch.ts` | Synth stays offline and fast; the next scheduled run is the retry |
| EventBridge Scheduler (`aws-scheduler`) for the schedule | explorer | Same as above |
| Synth tests: `createApp` with `envs/*.json`, `CDK_OUTDIR` in a temp dir, assertions on the template JSON | explorer `testnet-environment.test.ts` | Tests the config we deploy, not a fixture |
| vitest `testTimeout: 30_000` | explorer `vitest.config.ts` | A full synth took over 5 s on their CI runner |
| README: `AWS_PROFILE`, SSM parameters set once by hand, `/invite @aws` | explorer | The steps outside the code |

## Changed, and why

| What | Theirs | Ours | Why |
| --- | --- | --- | --- |
| Build | Nx (`pnpm nx build`, `npx nx build`) | `pnpm --filter @stellar-x402/infra build`, turbo for CI | The workspace runs pnpm and turbo |
| CDK CLI | `pnpm exec cdk` / `npx cdk` | `pnpm exec cdk` | pnpm |
| Deploy rights | OIDC roles for CI (`deploy-cicd`) | None. An operator with SSO deploys by hand | Decision 3: no workflow holds AWS credentials |
| Bootstrap | Their own run | The account's existing default bootstrap, no qualifier | Decision 3 |
| Alarm actions | Every alarm gets ALARM and OK actions | OK actions only where the shape says (Level, Silence) | G-alarm-list: an OK on an Event or Count alarm proves nothing about the cause |
| Alarms | Hand-written per alarm | One helper, one function per shape, names and dimensions checked against `@stellar-x402/metrics-catalog` | AD-1: the template test checks every alarm against the catalog. Per-alarm reasoning stays per alarm (the spine's paradigm), so the shape functions take the missing-data rule from G-alarm-list rather than hiding it |
| Name/dimension guard | A grep over the Rust sources (explorer `declared-vs-emitted.spec.ts`, its option A) | Option B there: assert on the synthesized template, against the catalog | The explorer recorded B as the move at their second contract; we have about 35 alarms and a typed catalog |
| Chatbot guardrail | Default, `AdministratorAccess` | `CloudWatchReadOnlyAccess` | The role already limits it; the guardrail says the same thing on the channel config itself. Shared account |
| Slack channel | The explorer's and Prices' own | `stellar-x402-bot` (decision 12) under `/x402/<env>/slack-*-id` | Same workspace, already authorized in Chatbot; only the channel is new |
| Server-to-AWS identity | None (their Hetzner box doesn't reach AWS) | IAM Roles Anywhere | ADR 0011: no long-lived keys on the server. Nothing in either repo to copy, so this part is new |
| `cdk.json` | The explorer's flags, for CDK 2.246 | The same, plus the eight newer flags at their recommended values | CDK 2.275 lists them as unconfigured; the templates are the same with and without them (decision 36) |
| Destroy targets | `destroy-<env>` and one per stack | None | A stack delete on a shared account is agreed and run by hand; the log groups are kept on one anyway (decision 31) |

## Not taken

- Cost anomaly monitor and dashboards: the explorer's monitor is the account's one (their 0553), and
  dashboards are deferred (G-alarm-list).
- `--require-approval never` anywhere: neither sibling uses it.
- The explorer's `withActions` that adds OK actions to every alarm (see above).

## Facts from the sibling repos #114 depends on

- The ClickHouse project's client CA is `infra-hetzner/ca/ca.crt` in the explorer repo:
  `O=Soroban, CN=soroban-internal-ca-2026`, ECDSA P-256 with SHA-256, `CA:TRUE, pathlen:0`,
  `keyCertSign, cRLSign`, valid to 2036-05-15. Roles Anywhere takes it as a trust anchor.
- Its `issue-client-cert.sh` signs `CN=<name>` with `CA:FALSE`, `digitalSignature`, `clientAuth`,
  which Roles Anywhere accepts for an end-entity certificate. The CN allowlist is Caddy's
  `CLICKHOUSE_CN_USER_MAP`, so a CN outside it opens nothing on ClickHouse.
- The box's IPv4 lives in SSM as `/soroban/production/ch-ip`, kept out of the repo by convention.
  The facilitator runs on the same box (ADR 0011).
- The Prices API's disk alarm on the same host is `prices-<env>-ch-disk-free`
  (`Prices/Rollup` `ClickHouseDiskFreePercent`), which our `disk` description names (decision 20).
- Library versions: `aws-cdk-lib ^2.245.0`, `constructs ^10.6.0`, `aws-cdk ^2.1114.1` in both
  `package.json` files (locked at 2.246.0/2.1116.0 and 2.257.0/2.1124.1).

## Checked against AWS docs (2026-11-04)

- `EMFParsingErrors`, `EMFValidationErrors` and `EMFDisabledErrors` are `AWS/Logs` metrics with
  the `LogGroupName` dimension, `Sum`. `EMFDisabledErrors` counts EMF events ignored because an
  account policy of type `METRIC_EXTRACTION_POLICY` matches the group, so the one-off check reads
  both the policy (`describe-account-policies`) and the metric.
- `IncomingBytes` has `LogGroupName`, `Sum`, `Bytes`.
- Alarm `WarmUpConfiguration` exists since 2026-09 (in `CfnAlarm` from aws-cdk-lib 2.273): up to
  2,880 minutes in INSUFFICIENT_DATA with no actions, ending early once the window has a datapoint.
  The docs say it applies once, at creation. Neither sibling uses it yet.
