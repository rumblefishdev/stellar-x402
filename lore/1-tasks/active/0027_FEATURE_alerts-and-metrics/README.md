---
id: "0027"
title: "Alerts and metrics"
type: FEATURE
status: active
milestone: 1
related_adr: ["0007", "0011", "0013"]
related_tasks: ["0012", "0014", "0024", "0026", "0020", "0009", "0045", "0049", "0039", "0036", "0038", "0048", "0077", "0089", "0109", "0110"]
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

- The metrics, each with its source, labels and whether it's billed: [G-metrics](notes/G-metrics.md).
  The alarms, each with its shape and missing-data rule: [the alarm list](notes/G-alarm-list.md).
- Five PRs (decision 2): #111 the decisions and ADRs; #112 the adapter and the facilitator's
  signals; #113 log shipping, the agent and the host probe; #114 the alarms, Slack and the uptime
  probe in CDK; #115 the off-server check and `docs/monitoring.md`.
- From 0039 ([ADR 0011](../../../../docs/adr/0011-facilitator-hosting.md), revised): the backend
  is CloudWatch, fed from the Hetzner server.
  - Each of our units appends its output to a file (decision 1), and the CloudWatch agent sends
    the files on with the logging role's credentials from IAM Roles Anywhere. Only the agent holds
    them, so `dockerd` stays untouched and an AWS outage never stops a container.
  - The adapter writes Embedded Metric Format lines to stdout. Dimensions stay low-cardinality
    (`network`, route, outcome, event name), never payer or `payTo`, and the adapter emits only
    listed fields. Check once that extraction works on the agent's path.
  - The agent reports memory, CPU and free disk, since ClickHouse shares the machine.
  - Alarms go through SNS and Amazon Q Developer in chat applications to `stellar-x402-bot`
    (decision 12).
- From 0014, changed by decision 5: uptime is a Lambda probe reading `/health`'s body every minute
  at `x402-facilitator.sorobanscan.com` (Cloudflare Tunnel, ADR 0011), so a Cloudflare or tunnel
  outage counts as downtime.
  - The alarm needs more failing minutes than a deploy's worst downtime, migrations and the wait
    for `ready` included: 7 in a row (ADR 0011's Consequences).
  - The 99% figure counts a minute as up only when the probe reads `ready`.
  - From 0020: `/supported` answers an object fixed at startup, so its 200 shows only that the
    process is up. A process whose startup check fails exits with `startup_failed` and restarts
    in a loop. It never becomes ready, and a missing answer counts as down, so the uptime
    criterion covers it.
- From 0014, amended by 0009 (decisions 44, 47; ADR 0011): RPC endpoints are named
  `RPC_URLS[i]#<fingerprint>` (`rpcEndpointName` in `logger.ts`), never by URL or host.
  signer-pool's `FallbackRpc.fromUrls` names them by full URL in `onSwitch`; name them with
  `rpcEndpointName` before wiring that to logs or metrics (0049).
- From 0009 (PR #41 reviews) and 0019: the settlement counters keep one `settlement_` prefix and
  labels from closed sets (0009 decision 38). Each one's alarm, or why it has none, is in the two
  notes. Also from 0019:
  - `reconcile_finished` (a sweep that changed or failed something), `reconcile_failed`,
    `settlement_reconcile_failed` and `settlement_resolve_failed` stay log lines, read with Logs
    Insights. Each hash's attempt state (`settlement_hashes.state`) can be queried for dead
    attempts and rebuilds;
  - a record whose hashes the RPC's history no longer reaches stays open until an operator checks
    it (0019 decision 22). `history-gone` fires once for it, and `pending` leaves it out;
  - `open` in `reconcile_finished` also counts a record another writer finished during the sweep,
    so `pending` reads the oldest open record's age instead;
  - from Stan's review of PR #57 (0019 decision 36): the deploy checks reconciliation once,
    through `listed`, so `settlement_sweeps_total{outcome}` and its alarm are the net for sweeps
    that start failing later. A sweep that changes nothing logs nothing.
- From 0045 (via 0009): `/verify`'s failover logs `rpc_failover` and `rpc_failback` with
  `rpcEndpointName` names. `rpc_on_fallback` is 1 while on a fallback, since a lagging fallback
  answers valid payments with rejections (0045 decision 9), and its OK reads as the recovery.
- From 0047 ([ADR 0013](../../../../docs/adr/0013-facilitator-key-custody.md), amended
  2026-10-20): low balance (decision 7), theft (decision 8) and reads of the backup secret
  (decision 9). ADR 0011's "Slack is not a pager" still holds for money alerts on mainnet.
- Deferred, with backlog tasks: the UptoProxy TTL alarm (0109, from 0035) and a cap on a sweep's
  time (0110, from 0019).
- Update `docs/monitoring.md`.

## Design Decisions

### From Plan

1. **The agent reads files our units write, not Docker's `json-file` logs** (akot, 2026-11-02).
   `x402@.service` runs Compose in the foreground with `--no-log-prefix --no-color` and appends
   stdout to a file, and stderr to a second one. Lines stay raw, so `_aws` is at the root; a
   `json-file` line wraps them. No new process, `dockerd` stays untouched, and `docker logs` keeps
   working. stdout leaves the journal. Our other units do the same, each to its own file and
   stream in the app group: Postgres, `cloudflared`, OpenBao, and the deploy with its migrations,
   so their history outlives the host (akot, 2026-11-03, Oskar's review). Tested locally, the live
   check waits for the first deploy: [R-log-path-spike](notes/R-log-path-spike.md). Its second
   run (Oskar's review) found that a rotation loses up to 250 ms of unread lines, and during an
   outage every app line since the agent blocked, all but a few kept in the rotated file, which we
   accept; and that the agent joins whitespace lines to the line before, which #113's agent config
   turns off. ADR 0011's Logs section changes with it.
2. **Five PRs** (akot, 2026-11-02): decisions and ADRs, the metrics adapter, the server side, the
   alarms in CDK, and the off-server check with the closing docs. Each opens as a draft that
   describes its scope, and the code follows once the decisions are agreed.
3. **The alarms are CDK in `infra/`, deployed by hand** (akot, 2026-11-02): TypeScript, as in the
   explorer and the Prices API, with the account's existing default bootstrap in eu-central-1.
   An operator deploys with SSO. No workflow has AWS credentials, and 0014's own qualifier went
   with the ECS plan.
4. **Bill what has an alarm, and the traffic picture** (akot, 2026-11-02): per-route counts, settle
   outcomes, one `pool_events_total` without a `type` dimension, and the event types that have an
   alarm. The other labels stay fields in the log line, read with Logs Insights. AC 1 holds as
   written. A metric costs $0.30 a month only for hours it gets data. The table is
   [G-metrics](notes/G-metrics.md).
5. **Uptime and readiness come from one Lambda probe, not Route 53** (akot, 2026-11-02). A small
   function in eu-central-1 reads `/health` every minute through the public hostname, parses the
   JSON and publishes its `ready`; what `ready` means with two networks is 0077's (ADR 0011). A
   missing point counts as down, and the alarm fires after 7 failing minutes. The 99% figure
   comes from the same metric. It covers a crash loop, a lost lease, the tunnel and Cloudflare,
   and it doesn't depend on the agent. It costs about $4 a month less and needs no us-east-1
   stack. The price is one vantage point and every alarm in one region: a fault between AWS and
   Cloudflare reads as downtime. ADR 0011's Uptime section changes with it. The probe ships with
   the alarms (PR 4), apart from the off-server check (PR 5), so an RPC or Horizon fault can't take
   it down. It runs from its deploy, but `/health` answers 502 until the first deploy, so the
   alarm's actions go on, and the 99% starts counting, at the first good deploy (Stan's review).
6. **0027 builds the role and the agent** (akot, 2026-11-02): the logging role, the Roles Anywhere
   profile and the log groups in CDK, the agent and the helper in the playbook, and the certificate
   renewal steps in the runbook. The holder of the ClickHouse project's CA only signs the
   certificate. Stan agreed on 2026-11-03 and accepts that his first deploy goes out without
   CloudWatch logs until 0027 lands. ADR 0011 and 0026's text change here to match.
7. **Low balance: alarms at 25 and 10 XLM, the floor at 5 XLM** (akot, 2026-11-02). 0024's floor
   took 25 XLM from ADR 0013's alarm, so the alarm fired as settlement stopped. The floor only has
   to refuse cleanly before fees start failing on the network: fees in flight hold about 1.25 XLM
   at 50 channels. ADR 0013's alarm stays at 25 XLM, about 5 days before the floor at 1,000
   settlements a day, and 10 XLM repeats it about a day before. CloudWatch notifies only on a
   change of state, hence two. The check runs off the server, every 5 minutes: it publishes
   `spendable_stroops` from `checkFacilitatorBalance`, and the thresholds live in the alarms, so
   `low` and its 100 XLM default go unused. The message gives the network, the balance, the fee
   account's address and the runbook's top-up step. `SPEND_FLOOR_STROOPS` moves to 50,000,000 in
   #105, and #105 makes that change before this PR merges (Oskar's review).
8. **Theft is read from the accounts, not from our hashes** (akot, 2026-11-02; Oskar agreed on
   2026-11-02 with three conditions, met here). The off-server check compares the signers and all
   four thresholds of the fee account and each channel with a declared set, and reads their
   Horizon effects. Two effects are allowed, since anyone can cause them: `account_credited`, and
   `claimable_balance_claimant_created`, a claimable balance that names our account (Oskar made
   one on testnet). A balance made from our own account still shows `claimable_balance_created`
   and `account_debited`.
   - It needs nothing from the server, which root could forge. It keeps where it read up to in an
     SSM parameter only its role writes (decision 14), so an outage of any length is read in full
     when it ends. Each read pages back to that point, since a flood of dust credits can push a
     debit off one page.
   - On testnet, a settlement leaves no effect on our accounts: 0006's bench fee account, the op
     source and fee payer of at least 6,800 settlements, has 1,180 effects, all from its setup and
     the `create_account`s that funded the bench; a channel with 33 settlements has 3, all from its
     creation. The token transfer shows only on the payer and the seller.
   - It can't see the float burned on fees alone, which gains a thief nothing; the balance alarms
     and the weekly fee review (decision 13) catch that.
   - Channel setup and key rotation fire it, with no suppression, and the declared set changes
     first. It is one alarm across all accounts, so while one of them holds it in ALARM, a theft
     elsewhere sends nothing new. Per-account alarms would cost about $15 a month at 50 channels,
     so we accept it.
   - Its alarms take the statistic a forged point can't hide a real one behind, since root can
     write metric lines in any namespace ([the alarm list](notes/G-alarm-list.md#statistics)).
   - Horizon sits behind a small port. ADR 0013's theft rule changes with it.
9. **Reads of the backup secret come from CloudTrail's event history** (akot, 2026-11-02). The
   off-server check calls `LookupEvents` every 5 minutes, so the shared account needs no trail.
   Events show up about 10 to 15 minutes late, so each read goes back an hour from where it last
   read in full and counts each event once (decision 14). Every read fires, a drill's too, with
   no suppression. The filter by the secret's name is tested once 0026 creates it.
10. **Host signals are metric lines a probe writes to a file the agent reads** (akot, 2026-11-02).
    A root timer runs `x402-host-probe` every minute: OpenBao up and unsealed, WAL archiving,
    backup and snapshot ages, the certificate's days left, and a heartbeat. The watchdog adds a
    line per restart. Only the agent holds AWS credentials, and OpenBao keeps its socket with no
    TCP port. One failed check doesn't stop the others, and a check that fails, or a job that never
    ran, writes a value past its threshold, so it alarms rather than reading as healthy (Oskar's
    review). Each alarm goes on once its signal exists. WAL keeps ADR 0011's rule, with
    `last_failed_time` past `last_archived_time` in place of a rising `failed_count`, which never
    falls. The disk threshold is read against the first real numbers before it goes on. A disk
    alarm goes to our channel: the server's base setup is Stan's, and our WAL and logs are what
    fills the disk (Oskar's and Stan's reviews). Memory gets its threshold after a week of data.
11. **Every log line ships** (akot, 2026-11-02): 30 days for app lines and 3 for metric lines,
    which CloudWatch has already turned into metrics. Payers are on chain anyway, and the only
    client IP is in `rate_limited`, which fires only past a limit and lets anyone with AWS access
    block an address at the edge without a shell on the server. The account is shared, so
    retention and the IP are looked at again before mainnet, with 0038; the threat model records
    the IP.
12. **Alarms go to `stellar-x402-bot`, and a named person owns them** (akot, 2026-11-02): akot
    first, and Stan as backup, which he confirmed on 2026-11-03: Slack, in working hours on
    testnet. From the first deploy, Oskar's weekly review (ADR 0013) asks which alarms are in
    ALARM, since a shared "the team" owner is how the explorer missed 9 days of muted alarms. The
    rest of that review (fee spend, refill, custody) starts after mainnet. The phone or SMS route
    ADR 0011 asks for on mainnet goes to 0038.
13. **Fee spend is a metric with no alarm** (akot, 2026-11-03, Oskar's proposal):
    `fee_charged_stroops` sums the `feeCharged` of each transaction that landed, success or
    failure. It counts each once: where a record's final write wins, or where a landing after
    `expired` is counted (0088), since that fee is spent too. Summed over 7 days, it is the fee
    spend the weekly review starts with. Set against the balance's change, a gap shows the fee
    account paying for something other than settlements (channel setup, a rotation, or float burned
    on fees), earlier than the balance alarms. The server writes it, so root could forge it; the
    balance it's compared with comes from off the server. An alarm on the gap waits for a few weeks
    of data.

### Emerged

14. **Two read points in one SSM parameter** (2026-11-03, applying Oskar's suggestion of one time
    for all). Horizon's point is a ledger: a run reads `history_latest_ledger` first, then every
    account's effects up to it, and moves the point only once every account was read in full. A
    re-read can count an effect twice, which repeats an alarm but never hides one. CloudTrail's
    point is a time, with the IDs counted in the hour before it, since an event can show up late:
    each read goes back that hour and counts an ID once. Each point moves only after its own read
    succeeds, so a Horizon outage doesn't count secret reads again. A point older than Horizon's
    history fails the run, which `watch-errors` shows. A test shows that a partial read moves
    neither.
15. **A dimension can be billed for some of its values only** (2026-11-03, for decision 4). The
    adapter writes a dimension set only for the values with an alarm: `stage` for `pool`,
    `budget` for `asset`, `other` and `global`, `fault` for `ours`, `type` for `sequence-resync`,
    `status` for `500`. The other values add no metric. HTTP metrics carry no `network`, since a
    route serves both networks after 0077. Host lines go to `x402-host` and the Lambdas' metrics to
    `x402-watch`, apart from the facilitator's `x402-facilitator`.
16. **`rpc_stalled_seconds` comes from a `getLatestLedger` read every 30 s** (2026-11-03). On a
    quiet server nothing else reads the RPC, so the gauge would stop moving exactly when it
    matters.

## Acceptance Criteria

- [ ] Given the running facilitator, when it serves traffic, then pool `onEvent` events, per-route request counts and settle outcomes are exported as metrics
- [ ] Given each alert condition: budget nearly used, breaker open, low facilitator balance (`checkFacilitatorBalance`), quarantined channel, pending settlements, when it occurs, then an alert fires on CloudWatch (ADR 0011); each alert has been triggered once on testnet or with a fake
- [ ] Given a process that stays not ready to settle (no lease) longer than the alarm window, when the alarm evaluates, then it fires (ADR 0011)
- [ ] Given the public URL unreachable, or a process in a crash loop, for 7 minutes in a row, when the uptime probe reads `/health`, then the uptime alarm fires, a deploy within its usual downtime doesn't fire it, and before the first good deploy it sends nothing (ADR 0011)
- [ ] Given a process whose sweeps don't list the records (or don't run) for longer than the alarm window, when the alarm evaluates, then it fires (ADR 0011, 0019 decision 36)
- [ ] Given a signer or threshold change on the fee account or a channel, or an effect on them other than a credit or a claimable balance naming them, when the off-server check runs, then an alarm fires, with the server down too (ADR 0013)
- [ ] Given the off-server check down or failing for any time, when it next succeeds, then it has read every effect and secret read since its last full read, and a partial read moved neither read point
- [ ] Given the fee account's spendable balance below 25 XLM and below 10 XLM, when the off-server check runs, then an alarm fires each time (ADR 0013)
- [ ] Given a read of the backup secret, when the off-server check runs, then an alarm fires (ADR 0013)
- [ ] Given OpenBao not giving a usable signature (sealed, denied, a wrong key), when the facilitator signs or runs its check, then an alarm fires on the first failure (ADR 0013)
- [ ] Given OpenBao down or sealed, WAL archiving stuck, a backup or snapshot older than 26 hours, or the certificate under 30 days from expiry, when the condition holds, then an alarm fires, and a check that fails or a job that never ran fires it too (ADR 0011, 0013)
- [ ] Given the server's disks, OpenBao's audit volume or its memory past their thresholds, when the agent reports them, then an alarm fires (ADR 0011, 0013)
- [ ] Given the agent, the host probe or the off-server check stopped, when the alarm window passes, then an alarm fires
- [ ] Given a deploy of the alarm stack, when it ends, then a test alarm has reached Slack and a person has seen it
- [ ] Given a line from the facilitator on the agent's path, when it reaches CloudWatch, then its metrics exist, checked once on the real path (ADR 0011)
- [ ] Given every alarm in the alarm list, when this story is done, then each has fired once on purpose, on testnet or with a fake, and `docs/monitoring.md` says how and when
- [ ] Given `docs/monitoring.md`, when this story is done, then it lists every metric and alert

**What the criteria wait on:** the spend metrics and their alarms (budget, breaker,
`failure-ours`, `commit-unmatched`) on 0024 (#105); the not-ready, uptime, host and real-path
criteria on 0026's server and first deploy; the backup-secret read on 0026 creating the secret;
`channel-held` on 0089's gauge; `disk` and `memory` on their first numbers. 0036's signer is on
develop.
