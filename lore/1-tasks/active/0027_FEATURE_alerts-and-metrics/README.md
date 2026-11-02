---
id: "0027"
title: "Alerts and metrics"
type: FEATURE
status: active
milestone: 1
related_adr: ["0007", "0011", "0013"]
related_tasks: ["0012", "0014", "0024", "0026", "0020", "0009", "0045", "0049", "0039", "0036", "0038", "0048", "0077", "0089"]
tags: [facilitator, operations, monitoring, priority-medium, effort-large, platform]
links:
  - ../../../../docs/planning/m1-epics.md
  - ../../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.6 (Platform lane)."
  - date: "2026-10-09"
    status: backlog
    who: okarcz
    note: "Added the UptoProxy TTL alert from 0035's future work."
  - date: "2026-10-20"
    status: backlog
    who: okarcz
    note: "0047 (ADR 0013 amended): the low-balance alarm at 25 XLM as a Slack message, and a CloudTrail alarm on reads of the backup secret."
  - date: "2026-10-22"
    status: backlog
    who: stkrolikiewicz
    note: "0039: the uptime check targets the Cloudflare Tunnel hostname on sorobanscan.com."
  - date: "2026-11-02"
    status: active
    who: akot
    note: "Taken at the team meeting."
---

# Alerts and metrics

## Summary

As a facilitator operator, I want metrics and alerts for anything that costs money or can lose a payment, so that I hear about problems before users do.

**Story:** [M1 Story 2.6](../../../../docs/planning/m1-epics.md#story-26-alerts-and-metrics) · **Lane:** Platform · **Covers:** FR14 (AD-18); NFR7

## Context

- The backend comes from 0014; the budget and breaker events come from 0024.
- Related tasks: 0014, 0024, 0026.

## Implementation

- Metrics adapter in `adapters/` fed by pool events and the HTTP layer.
- Alert rules for the five conditions and the rest of [the alarm list](notes/G-alarm-list.md).
- **UptoProxy TTL (from 0035), deferred:** waits until `upto` reaches `/settle` and the deployed
  config names the proxy. Then read its instance and code TTL off the server, in ledgers, and alert
  well below `TTL_EXTEND_TO` (518,400 ledgers), not at it: settlements hold a used proxy's TTL at or
  just under that target, so an alert there would stay on. An operator extends it with
  `stellar contract extend` before it is archived.
- Update `docs/monitoring.md`.
- From 0039 ([ADR 0011](../../../../docs/adr/0011-facilitator-hosting.md), revised): the backend is CloudWatch, fed from the
  Hetzner server.
  - The unit appends the facilitator's stdout and stderr to files (decision 1), and the CloudWatch
    agent sends them on with the logs-and-metrics role's credentials from IAM Roles Anywhere. Only
    the agent holds them, so `dockerd` stays untouched and an AWS outage never stops a container.
  - The adapter writes Embedded Metric Format lines to stdout (namespace `x402-facilitator`).
    Dimensions stay low-cardinality (`network`, route, outcome, event name), never payer or
    `payTo`, and the adapter emits only listed fields. Check once that extraction works on the
    agent's path.
  - The CloudWatch agent on the server reports memory, CPU and free disk, since ClickHouse shares
    the machine.
- From 0039: alarms go through SNS and Amazon Q Developer in chat applications to the team's
  Slack channel. Besides the five AD-18 conditions:
  - "ready to settle" (lease held; since 0019 decision 27 reconciliation runs beside `/settle`);
  - from ADR 0013: OpenBao sealed, down or failing to sign; theft (below, from 0047); and
    OpenBao's audit log disk at 80%;
  - WAL archiving failing: `pg_stat_archiver.last_failed_time` past `last_archived_time`, or the
    last archived segment older than 10 minutes. pgBackRest acknowledges a segment only once it is in the repository,
    so this covers a stuck archive, which fills a disk ClickHouse shares, and WAL that doesn't
    leave the server;
  - the last `pgbackrest backup` or the last OpenBao snapshot older than 26 hours (both run
    daily);
  - the Roles Anywhere certificate expiring within 30 days;
  - low free disk and memory on the server.
- From 0014, changed by decision 5: uptime is a Lambda probe reading `/health` every minute at
  `x402-facilitator.sorobanscan.com` (Cloudflare Tunnel, ADR 0011), so a Cloudflare or tunnel
  outage counts as downtime.
  - The alarm needs more failing minutes than a deploy's worst downtime, which includes the
    migrations and the wait for `ready` (ADR 0011's Consequences). It fires after 7 failing
    minutes in a row; ADR 0011 gives the reasoning.
  - The 99% figure counts a minute as up only when the probe reads `ready`.
  - From 0020: `/supported` answers an object fixed at startup, so its 200 shows only that the
    process is up, not that the RPC answers or the channels can settle. The probe reads `/health`'s
    body for that reason (0026).
  - From 0020: a process whose startup check fails (an RPC down, a channel another key can move)
    exits with `startup_failed` and is restarted in a loop; it never becomes ready, and the probe
    counts a missing answer as down, so criterion 3 covers it (ADR 0011).
- From 0014, amended by 0009 (decisions 44, 47; ADR 0011): RPC endpoints are logged and labelled
  as `RPC_URLS[i]#<fingerprint>` (`rpcEndpointName` in `logger.ts`), never by URL or host. The
  fingerprint tells an entry from the URL it replaced after a redeploy. signer-pool's
  `FallbackRpc.fromUrls` names endpoints by their full URL, which reaches `onSwitch`; name them
  with `rpcEndpointName` before wiring it to logs or metrics (0049).
- From 0009 (PR #41 reviews): the settlement counters, one `settlement_` prefix, labels from
  closed sets (0009 decision 38):
  - `settlement_outcomes_total{reason, replay}`: every `/settle` answer (this task's AC 1);
  - `settlement_already_settled_total`, `settlement_nonce_reuse_total` (counted before any check:
    forged bodies raise it, so don't page on it);
  - `settlement_refused_after_verify_total{reason, stage}`: alarm on `stage="pool"` only;
  - `settlement_budget_exhausted_total{signed}`, `settlement_uncertain_total`,
    `settlement_submit_failures_total`, `settlement_hook_failures_total{hook}`;
  - `settlement_record_failures_total`: the store-outage alarm (0009 decision 30);
  - `pool_events_total{type}`, with `status` on `resolved`, for a "pending settlements" alarm;
  - from 0019: `settlement_reconciled_total{state}` (a record a sweep finished: `rejected`,
    `success`, `failed`, `expired`), and the logs `reconcile_finished` (the counts of a sweep that
    changed or failed something, `open` and `errors` among them; sweeps run every 10 s),
    `reconcile_failed` (a sweep that couldn't list the records), `settlement_reconcile_failed` and
    `settlement_resolve_failed`. `errors` that never drop, or `reconcile_failed` past the alarm
    window, is a record no sweep can check.
    Each hash's attempt state (`settlement_hashes.state`) can be queried for dead attempts and
    rebuilds. Also from 0019's code review:
    - `settlement_history_gone` / `settlement_history_gone_total`: a record whose hashes the RPC's
      history no longer reaches; it stays open until an operator checks it (0019 decision 22).
      `settlement_attempt_mark_failed`: a `sent` hint not written (warn, not an outage);
    - a sweep has no overall time cap when the RPC fails for every record: N records take about
      N × the RPC timeout ÷ 4, and the next sweep waits for it. A cap waits for real backlog
      sizes (deferred);
    - `open` in `reconcile_finished` also counts a record another writer finished during the
      sweep (its compare-and-set lost). The `pending` alarm reads the oldest record's age instead,
      so it doesn't matter there.
    - From Stan's review of PR #57 (0019 decision 36): the deploy checks reconciliation only once,
      through `listed` on `/health`, so an alarm on sweeps that stop listing is the only net for
      one that starts failing later. A sweep that changes nothing logs nothing, so add a counter
      per sweep, e.g. `settlement_sweeps_total{outcome}` (`listed` or `failed`); a missing-data
      rule can then tell "no sweeps ran" from "nothing to do".
- From 0045 (via 0009): `/verify`'s upstream failover logs `rpc_failover` with `rpcEndpointName`
  names (`RPC_URLS[i]#<fingerprint>`). Add a `rpc_failovers_total{from,to}` counter, or an alarm on the log, since a lagging
  fallback answers valid payments with rejections (0045 decision 9). A return to the first URL
  should read as recovery, not a new outage (`rpc_failback`, info).
- From 0047 ([ADR 0013](../../../../docs/adr/0013-facilitator-key-custody.md), amended 2026-10-20):
  - **Low balance:** the fee account's spendable balance (float 100 XLM), decision 7.
  - **Theft:** the accounts' state and Horizon effects, off the server, decision 8.
  - **Reads of the backup secret:** `GetSecretValue` on `x402/production/openbao-backup`, from the
    event history, decision 9.
  - ADR 0011's "Slack is not a pager" still holds for money alerts on mainnet.

## Design Decisions

1. **The agent reads a file the unit writes, not Docker's `json-file` logs** (akot, 2026-11-02).
   `x402@.service` runs Compose in the foreground with `--no-log-prefix --no-color` and appends
   stdout to a file, and stderr to a second one. Lines stay raw, so `_aws` is at the root; a
   `json-file` line wraps them. No new process, `dockerd` stays untouched, and `docker logs` keeps
   working. stdout leaves the journal. Tested locally, the live check waits for the first deploy:
   [R-log-path-spike](notes/R-log-path-spike.md). ADR 0011's Logs section changes with it.
2. **Five PRs** (akot, 2026-11-02): decisions and ADRs, the metrics adapter, the server side, the
   alarms in CDK, and the off-server check with the closing docs. Each opens as a draft that
   describes its scope, and the code follows once the decisions are agreed.
3. **The alarms are CDK in `infra/`, deployed by hand** (akot, 2026-11-02): TypeScript, as in the
   explorer and the Prices API, with the account's existing default bootstrap in both regions.
   An operator deploys with SSO. No workflow has AWS credentials, and 0014's own qualifier went
   with the ECS plan.
4. **Bill what has an alarm, and the traffic picture** (akot, 2026-11-02): per-route counts, settle
   outcomes, one `pool_events_total` without a `type` dimension, and the event types that have an
   alarm, about 11 traffic metrics. The other types stay a field in the log line, read with Logs
   Insights. AC 1 holds as written. A metric costs $0.30 a month only for hours it gets data.
5. **Uptime and readiness come from one Lambda probe, not Route 53** (akot, 2026-11-02). A small
   function in eu-central-1 reads `/health` every minute through the public hostname, parses the
   JSON and publishes `ready` per network. A missing point counts as down, and the alarm fires
   after 7 failing minutes. The 99% figure comes from the same metric. It covers a crash loop, a
   lost lease, the tunnel and Cloudflare, and it doesn't depend on the agent. It costs about $4 a
   month less and needs no us-east-1 stack. The price is one vantage point and every alarm in one
   region: a fault between AWS and Cloudflare reads as downtime. ADR 0011's Uptime section changes
   with it. The probe ships with the alarms (PR 4), apart from the off-server check (PR 5), so an
   RPC or Horizon fault can't take it down and it's ready before the first deploy.
6. **0027 builds the role and the agent** (akot, 2026-11-02): the logging role, the Roles Anywhere
   profile and the log groups in CDK, the agent and the helper in the playbook, and the certificate
   renewal steps in the runbook. The holder of the ClickHouse project's CA only signs the
   certificate. ADR 0011 names 0026 for the role and its certificate, so it changes, and Stan
   needs to know.
7. **Low balance: alarms at 25 and 10 XLM, the floor at 5 XLM** (akot, 2026-11-02). 0024's floor
   took 25 XLM from ADR 0013's alarm, so the alarm fired as settlement stopped. The floor only has
   to refuse cleanly before fees start failing on the network: fees in flight hold about 1.25 XLM
   at 50 channels. ADR 0013's alarm stays at 25 XLM, about 5 days before the floor at 1,000
   settlements a day, and 10 XLM repeats it about a day before. CloudWatch notifies only on a
   change of state, hence two. The check runs off the server, every 5 minutes: it publishes
   `spendableStroops` from `checkFacilitatorBalance`, and the thresholds live in the alarms, so
   `low` and its 100 XLM default go unused. The message gives the network, the balance, the fee
   account's address and the runbook's top-up step. `SPEND_FLOOR_STROOPS` moves to 50,000,000 in
   #105.
8. **Theft is read from the accounts, not from our hashes** (akot, 2026-11-02). The off-server
   check compares the signers and all four thresholds of the fee account and each channel with a
   declared set, and allows only `account_credited` among their Horizon effects. It needs nothing
   from the server, which root could forge, and it keeps no state. On testnet the fee account
   shows 4 effects across its settlements, all from its setup, and a token transfer shows as
   `account_debited`. It can't see the float burned on fees alone, which gains a thief nothing;
   the balance alarms catch that. Channel setup and key rotation fire it, with no suppression, and
   the declared set changes first. Horizon sits behind a small port. ADR 0013's theft rule changes
   with it, which Oskar decides.
9. **Reads of the backup secret come from CloudTrail's event history** (akot, 2026-11-02). The
   off-server check calls `LookupEvents` every 5 minutes over an overlapping window, so the shared
   account needs no trail. Events lag by about 10 to 15 minutes. Every read fires, a drill's too,
   with no suppression. The filter by the secret's name is tested once 0026 creates it.
10. **Host signals are metric lines a probe writes to a file the agent reads** (akot, 2026-11-02).
    A root timer runs `x402-host-probe` every minute: OpenBao up and unsealed, WAL archiving,
    backup and snapshot ages, the certificate's days left, and a heartbeat. The watchdog adds a
    line per restart. Only the agent holds AWS credentials, and OpenBao keeps its socket with no
    TCP port. One failed check doesn't stop the others. Each alarm goes on once its signal exists.
    WAL keeps ADR 0011's rule, with `last_failed_time` past `last_archived_time` in place of a
    rising `failed_count`, which never falls. The disk threshold is read against the first real
    numbers before it goes on, and a disk alarm goes to the explorer team, who own the server.
    Memory gets its threshold after a week of data.
11. **Every log line ships** (akot, 2026-11-02): 30 days for app lines and 3 for metric lines,
    which CloudWatch has already turned into metrics. Payers are on chain anyway, and the only
    client IP is in `rate_limited`, which fires only past a limit and lets anyone with AWS access
    block an address at the edge without a shell on the server. The account is shared, so
    retention and the IP are looked at again before mainnet, with 0038.
12. **Alarms go to `stellar-x402-bot`, and a named person owns them** (akot, 2026-11-02): akot
    first, with Stan as backup once he confirms. Oskar's weekly float review (ADR 0013) also asks
    which alarms are in ALARM, since a shared "the team" owner is how the explorer missed 9 days
    of muted alarms. Testnet alarms are answered in working hours. The phone or SMS route ADR 0011
    asks for on mainnet goes to 0038.

## Acceptance Criteria

- [ ] Given the running facilitator, when it serves traffic, then pool `onEvent` events, per-route request counts and settle outcomes are exported as metrics
- [ ] Given each alert condition: budget nearly used, breaker open, low facilitator balance (`checkFacilitatorBalance`), quarantined channel, pending settlements, when it occurs, then an alert fires on CloudWatch (ADR 0011); each alert has been triggered once on testnet or with a fake
- [ ] Given a process that stays not ready to settle (no lease) longer than the alarm window, when the alarm evaluates, then it fires (ADR 0011)
- [ ] Given the public URL unreachable, or a process in a crash loop, for 7 minutes in a row, when the uptime probe reads `/health`, then the uptime alarm fires, and a deploy within its usual downtime doesn't fire it (ADR 0011)
- [ ] Given a process whose sweeps don't list the records (or don't run) for longer than the alarm window, when the alarm evaluates, then it fires (ADR 0011, 0019 decision 36)
- [ ] Given a signer or threshold change on the fee account or a channel, or an effect on them other than a credit, when the off-server check runs, then an alarm fires, with the server down too (ADR 0013)
- [ ] Given the fee account's spendable balance below 25 XLM and below 10 XLM, when the off-server check runs, then an alarm fires each time (ADR 0013)
- [ ] Given a read of the backup secret, when the off-server check runs, then an alarm fires (ADR 0013)
- [ ] Given OpenBao down or sealed, WAL archiving stuck, a backup or snapshot older than 26 hours, or the certificate under 30 days from expiry, when the condition holds, then an alarm fires (ADR 0011, 0013)
- [ ] Given the agent, the host probe or the off-server check stopped, when the alarm window passes, then an alarm fires
- [ ] Given a deploy of the alarm stack, when it ends, then a test alarm has reached Slack and a person has seen it
- [ ] Given a line from the facilitator on the agent's path, when it reaches CloudWatch, then its metrics exist, checked once on the real path (ADR 0011)
- [ ] Given `docs/monitoring.md`, when this story is done, then it lists every metric and alert
