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
  - date: "2026-11-04"
    status: active
    who: akot
    note: "Decisions 18-20 after comparing with the Prices API and the explorer: metric lines kept 30 days, Level alarms ignore missing data, no CPU metric. Decisions 21-22 from #112's code: hooks and fee run once, scope checked by the compiler."
  - date: "2026-11-04"
    status: active
    who: akot
    note: "#114's plan after reading the siblings' infra/ (notes/R-infra-patterns.md): decisions 23-28 (every alarm in #114, names, the shared CA and CN, groups absent or on, three stacks, gauges-silent), 29-39 emerged, two of them from the reviews."
  - date: "2026-11-05"
    status: active
    who: akot
    note: "From the whole-task review of #111-#115: decision 4 amended (every catalog metric is billed), and the catalog names the disk's dimension `path`, as the CloudWatch agent writes it."
  - date: "2026-11-05"
    status: active
    who: akot
    note: "#114, from the same review: decisions 40-41 (the backups and snapshots groups apart from host, the fee account named in the balance alarms with a testnet top-up in the runbook)."
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
  - The agent reports memory and disk use, since ClickHouse shares the machine; no CPU
    (decision 20).
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
   **Amended** (akot, 2026-11-05, from the whole-task review): every metric in the catalog is
   billed, as #112's catalog already writes it. The 19 counters that were to stay log fields get
   one set each: `network` alone, or no dimension on a process-scoped one. A line with no valid set
   isn't written at all, so keeping them out of CloudWatch would need a log-only line in the
   writer. They cost at most $5.70 a month with one network and $9.30 with two, less in practice
   since the rare ones get data in few hours. An alarm or graph on one needs no code change.
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
   account's address and the runbook's top-up step. #105 moved `SPEND_FLOOR_STROOPS` to 50,000,000
   on 2026-11-03, with its docs, before this PR merges (Oskar's review).
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
11. **Every log line ships** (akot, 2026-11-02): 30 days for app lines, and for metric lines
    since decision 18 (3 days before it). Payers are on chain anyway, and the only
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
    `status` for `500`. The other values write no line at all, so they are in no metric line
    either; `stage: check` and a `payer` budget are in the app log, which logs each such event
    (2026-11-05, from Karol's review of #112). HTTP metrics carry no `network`, since a
    route serves both networks after 0077. Host lines go to `x402-host` and the Lambdas' metrics to
    `x402-watch`, apart from the facilitator's `x402-facilitator`. `disk_used_percent`'s dimension
    is `path` (2026-11-05, from the whole-task review): that is the CloudWatch agent's name for the
    mount point, and the agent can't rename a dimension, so the catalog takes its name.
16. **`rpc_stalled_seconds` comes from a `getLatestLedger` read every 30 s** (2026-11-03). On a
    quiet server nothing else reads the RPC, so the gauge would stop moving exactly when it
    matters.
17. **A stale balance reading has its own alarm** (akot, 2026-11-03). #105's floor fails closed
    once its last good reading is older than `maxStaleMs`, 5 minutes at the default interval, and
    `/settle` then refuses every payment while `ready` stays 1 and the balance off the server looks
    fine. #112 writes `balance_reading_age_seconds` every minute, and `balance-stale` fires above
    300 s. A gauge, not `balance_read_failures_total`: a read that times out waits up to 10 s per
    RPC endpoint, so the failures in 5 minutes vary in number. The floor reads on a timer, so the
    gauge doesn't depend on traffic.
18. **Metric lines are kept 30 days, like app lines** (akot, 2026-11-04; amends decision 11 and
    ADR 0011's Logs). A label that isn't a dimension (`reason`, `state`, `type`) exists only as a
    field in the metric line (decision 4), so 3 days would cut the Logs Insights view of the
    traffic to 3 days, and the weekly fee review reads a week. The sibling projects keep every log
    30 days (the Prices API's Lambdas) or 90 (the explorer's ECS tasks), and neither keeps metric
    lines shorter. The two log groups stay, for their buffering during an AWS outage (ADR 0011).
19. **A Level alarm keeps its state when data stops** (akot, 2026-11-04; changes the
    "not breaching" #111 had for the Level rows, from Oskar's review). Under not breaching, a
    process that dies with a Level alarm in ALARM turns it OK and posts a false recovery to Slack.
    The Prices API hit this (seven tier alarms posted "recovered" for tiers still frozen when
    their probe failed) and moved those alarms to `MISSING` and 1-of-2 evaluation. We take
    `IGNORE` rather than `MISSING`: under `MISSING` an alarm with no data goes to
    INSUFFICIENT_DATA and drops out of the weekly review's question of which alarms are in ALARM
    (decision 12). The silence is covered by its own alarm, named in each row
    (`facilitator-silent`, `probe-silent`, `telemetry-silent`, `watch-no-invocations`). Event and
    Count alarms stay not breaching, since for them no data means nothing happened. `uptime`
    stays breaching: its missing point counts as down (decision 5).
20. **No CPU metric** (akot, 2026-11-04; amends the agent's metrics above and ADR 0011's Host
    metrics). Nothing alarms on CPU, and decision 4 bills only what has an alarm (since its
    amendment, everything written is billed, so a CPU metric would cost with nothing reading
    it). The sibling projects don't collect it either: the explorer removed its CPU widgets (its task 0239), and
    the Prices API watches only free disk on the same Hetzner host. The Prices API already alarms
    on that host's free disk (`prices-<env>-ch-disk-free`); our `disk` alarm reads our mounts, and
    its description names theirs.
21. **#112 fixes the hooks running twice for one record** (akot, 2026-11-04). Counting
    `fee_charged_stroops` in `onFinal` showed that 0019's hooks, the spend policy's `commit`
    among them, could run twice for one record in two races. The sweep ran the hooks of a final
    record that a writer had taken out of `unconfirmed` while it read; it now runs them only while
    the key is still listed, since that writer either wins or puts it back. And a writer that won
    kept a key that a racing writer, whose write threw, had put back, so the next sweep ran them
    again; a write that wins now forgets the key. Fixed in #112 rather than a PR of its own, since
    the fee metric needs it: one commit, `fix(lore-0027): run a final record's hooks and fee
    once`, with a test for each race. It changes settlement behaviour, so #112's description
    names it for review.
22. **The compiler checks a metric's scope** (akot, 2026-11-04; changes the spine's AD-3). The
    root is a `ProcessMetrics` that takes only the catalog's process-scoped names, and
    `for({ network })` returns a `NetworkMetrics` that takes only network-scoped ones. Before, a
    network-scoped metric written through the root wrote no line, and the notes planned a
    `metric-issue` alarm on the writer's warn log to catch it; the in-memory double didn't check
    scope, so no test would have. A wrong scope now doesn't compile, and the alarm is dropped.
    The child no longer re-scopes with a second `for()`, which nothing used.
23. **#114 builds every alarm in the list** (akot, 2026-11-04). The money and security alarms
    (`balance-low`, `balance-critical`, `account-state`, `account-effects`,
    `backup-secret-read`), `watch-errors` and `watch-no-invocations` are in #114 with the rest, in
    a group that stays off until #115's Lambda runs (decision 26). #115 adds the Lambda and
    `docs/monitoring.md`; the Lambda is named `x402-production-watch`, since the two `watch-*`
    alarms read `AWS/Lambda` by that name. One PR holds the whole list and the one alarm helper,
    and an alarm still goes on only with its signal (the spine's AD-6).
24. **One environment file and fixed names** (akot, 2026-11-04). `infra/envs/production.json` is
    `x402@production`. Its `networks` (`["stellar:testnet"]` today) decides which `network` values
    the network-scoped alarms get. Stacks are `X402-production-<Stack>`. Alarms are
    `x402-production-<alarm>`, and a network-scoped one ends with the network's name
    (`x402-production-sweeps-stopped-testnet`), so pubnet renames nothing. The log groups are
    `/x402/production/app` and `/x402/production/metrics`, the topic `x402-production-alarms`,
    the Lambdas `x402-production-uptime-probe` and `x402-production-watch`, and the SSM parameters
    sit under `/x402/production/`.
25. **The logging role trusts the shared CA, for one CN** (akot, 2026-11-04; as ADR 0011). The
    trust anchor is the explorer's ClickHouse client CA, `soroban-internal-ca-2026`, which the
    Prices API's ClickHouse certificates come from too. No sibling uses Roles Anywhere, so ours is
    the CA's first trust anchor. Every certificate the CA signs can reach it, so the trust policy
    accepts only `CN=x402-cloudwatch-agent-production` and only our anchor, and every permission
    needs the server's IP. The CN follows the siblings' `<project>-<component>-<env>`
    (`prices-api-production`) and names the agent, the only holder of the credentials. A CA of our
    own would cost about $400 a month (AWS Private CA; $50 in short-lived mode) or another key to
    guard, for a role that can only write our logs and host metrics from our server. Whoever holds
    the CA key can issue our CN, and one certificate can't be revoked without a CRL: a leaked key
    means a new CN and a Telemetry deploy. ADR 0011 accepts both; look again with 0038 if the role
    ever gains more.
26. **An alarm group is either absent or on with its actions** (akot, 2026-11-04). `alarmGroups`
    in the config: off creates none of the group's alarms, on creates them with their actions. No
    alarm has `actionsEnabled: false`: an alarm without actions is a muted alarm (the explorer's 9
    days, the Prices API's alarm with an empty action list). `make check-series GROUP=<group>`
    lists every series the group's alarms read and fails on one CloudWatch doesn't have, so a
    group goes on once its series have data (AD-6). No `WarmUpConfiguration`: it lasts at most 2
    days, applies only at creation, and its docs don't cover metric math. At the first deploy only
    `telemetry` (the EMF error alarms) is on: `uptime` waits for the probe's first points
    (decision 37), `facilitator` and `host` on #113, `watch` on #115, `channelHeld` on 0089,
    `backups` and `snapshots` on 0026's jobs (decision 40). The groups
    `disk`, `memory` and `logVolume` also need a measured threshold, and `host` the audit
    volume's mount, and synth refuses each one on without it.
27. **Three stacks with no reference between them** (akot, 2026-11-04). Telemetry (the Roles
    Anywhere anchor, profile and role, and the two log groups), Alarms (the topic, Chatbot and the
    alarms) and Uptime (the probe, its schedule and its role). Alarms read metrics by namespace,
    name and dimensions, and the log groups and Lambdas have fixed names, so no stack exports
    anything and each deploys alone with `--exclusively` (the Prices API's 0141). A threshold
    change never shows IAM in the diff, and the probe's code ships without touching an alarm.
    #115 adds its Lambda as a fourth stack.
28. **`gauges-silent`, one per network** (akot, 2026-11-04; closes the alarm list's open item). A
    gauge whose read keeps throwing goes silent while sweeps continue: its Level alarm keeps its
    state (decision 19), and `facilitator-silent` reads the sweeps, so nothing fired. A
    `balance_reading_age_seconds` that stopped would keep `balance-stale` quiet while `/settle`
    refuses every payment. One metric-math alarm per network fires when the sweeps arrive and any
    of the six gauges sent no point for 3 five-minute periods. With the process down the sweeps
    stop too, so it stays quiet beside `facilitator-silent`. About $0.70 a month per network.
    Once `channelHeld` is on, it watches 0089's `channel_longest_hold_seconds` too, whose
    `channel-held` keeps its state the same way (2026-11-05, Karol's review of #114).
29. **The CA is a copied file, the server's IP our own SSM parameter** (2026-11-04). The CA's
    public certificate is copied into `infra/trust/` from the explorer's
    `infra-hetzner/ca/ca.crt`, so a change of trust root goes through review, and a test checks
    that it is a CA and not expired. The IP is `/x402/production/server-ip`, kept out of the repo
    as the explorer keeps `/soroban/production/ch-ip`. It's a parameter of our own, since `ch-ip`
    describes ClickHouse, and our role shouldn't follow ClickHouse to another box.
30. **12-hour sessions, and the IP on the permissions** (2026-11-04). The profile and the role
    allow the 12 hours #113's `aws_signing_helper update` asks for, so the agent keeps shipping
    through a shorter Roles Anywhere outage; a session used anywhere but the server gets nothing.
    `aws:SourceIp` sits on each allowed action rather than in the trust policy: it is the agent's
    own calls the IP limits, and whether Roles Anywhere passes the client's IP to the trust policy
    is untested. The role only writes: `logs:CreateLogStream`, `logs:PutLogEvents` and
    `logs:DescribeLogStreams` on the two groups, and `cloudwatch:PutMetricData` for the namespace
    `x402-host` (the agent's memory and disk). EMF lines need no `PutMetricData`. So #113's agent
    config can't create groups or set their retention. The namespace condition binds
    `PutMetricData` only: an EMF line in the metrics group can name any namespace, `x402-watch`
    included, so it doesn't guard the off-server alarms. Their statistics and the Lambdas'
    `AWS/Lambda` silence alarms do (G-alarm-list, "Statistics"; 2026-11-05, Karol's review of
    #114).
31. **The log groups outlive their stack** (2026-11-04). The app and metrics groups are kept on a
    stack delete: their history is meant to outlive the host (decision 1), so a `cdk destroy`
    shouldn't take it. Not on a first create's rollback (`RETAIN_ON_UPDATE_OR_DELETE`), or the
    empty groups would block the next deploy with "already exists" (the second review). The probe's own group goes with its stack, as the explorer's
    Lambda groups do.
32. **Chatbot's guardrail is read-only** (2026-11-04). The siblings leave it at the default,
    `AdministratorAccess`. The role already limits Chatbot to `CloudWatchReadOnlyAccess`; on a
    shared account the channel's guardrail says the same.
33. **`check-series` waits only on the series written all the time** (2026-11-04). A failure
    counter (`signer_failures_total`, the EMF errors) is written only when the failure happens,
    so it can't show data before its group goes on, and a check that required it would never
    pass. The check fails on a gauge, the sweeps' zero, a Lambda's own metrics or a log group's
    bytes with no data in the last 3 hours, and lists the failure counters: they travel the same
    path, and the catalog checks their names and dimensions at synth.
34. **The shapes the list left open** (2026-11-04). `memory`: `Minimum` over 5-minute periods, 3 of
    3, so it fires on a lasting squeeze, not a ClickHouse merge's spike. `log-volume`: `Sum` of
    `IncomingBytes` per log group over an hour, 1 of 1. Both stay off until their thresholds are
    measured. `disk` and `log-volume` make one alarm per mount and per log group, named after it.
35. **The delivery test fires `emf-validation`** (2026-11-04). `make fire-test` sets an alarm to
    ALARM by hand. `emf-validation` reads a metric written only on a failure, so its next
    evaluation puts it back to OK with no OK message, and no real alarm is touched. The target
    prints the alarm's action history, since a publish SNS refuses shows only there (the
    explorer's 2026-08-27).
36. **The siblings' library ranges, today's versions** (2026-11-04). `aws-cdk-lib ^2.245.0`,
    `constructs ^10.6.0`, `aws-cdk ^2.1114.1`, as both siblings, resolved to 2.275.0, 10.8.1 and
    2.1147.0. `cdk.json` takes the explorer's feature flags, plus the eight newer than its CDK at
    their recommended values; the templates are the same with and without them.
37. **`uptime` goes on after the probe's first points** (2026-11-04, from the second review of
    #114). Missing data breaches it, so an alarm made before `ready` has 7 minutes of points posts
    "not ready" at once. The first deploy makes the probe, and the group goes on once
    `make check-series GROUP=uptime` sees `ready`. Decision 5's condition, the first good deploy,
    was met by #119.
38. **The probe runs at the start of every minute** (2026-11-04, the second review).
    `cron(* * * * ? *)`, not `rate(1 minute)`, which counts from the schedule's creation: a run
    near a minute's edge could land in the next minute and leave one with no point, read as down
    and taken off the 99%. Each point is stamped when its run starts.
39. **#115 publishes every metric on every run, 0 included** (2026-11-04). `check-series` counts
    `x402-watch` as written all the time, so the `watch` group goes on only once each series has
    arrived. A count published only when it isn't 0 would leave `account-effects` and
    `backup-secret-read` reading OK on series that might not exist.
40. **The backup and snapshot alarms are groups of their own** (2026-11-05, from the whole-task
    review). `host` held `wal-failing`, `wal-stale`, `backup-age` and `snapshot-age`, whose jobs,
    pgBackRest and OpenBao's daily snapshot, come with 0026 and don't run yet. The probe writes a
    value past the threshold for a job that never ran (decision 10), so `host` could never go on,
    and `openbao-down`, `certificate`, `probe-silent` and `telemetry-silent` would wait with it.
    `backups` holds the three pgBackRest alarms and `snapshots` holds `snapshot-age`, apart, since
    the two jobs can land at different times.
41. **The balance alarms name the fee account, from the infra config** (2026-11-05, from the
    whole-task review; ADR 0013 asks for the address and the top-up step). `feeAccounts` in
    `infra/envs/<env>.json` holds one `G...` address per served network; synth refuses a missing
    one, one for a network not served, and a failed checksum, so a typo can't send a top-up
    elsewhere. The address is public: `/supported` lists it as the signer. The descriptions point to
    the runbook's new Topping up the fee account, whose testnet merge was tried between two one-off
    accounts. An address change, a key rotation, is a config change and an alarm deploy.
55. **A write that loses or throws after another won keeps the key out** (akot, 2026-11-05;
    from Karol's review of #112; completes decision 21). Decision 21 fixed the order where the
    winner returns last. In the other order, a winner that returned first and a racing write that
    threw or lost after it, the loser put the key back in `unconfirmed`, so the next sweep ran
    `onFinal`, `onSuccess` and the fee count again; with the real spend policy two failed
    settlements recorded 4 failures and opened breakers early. `finalWrite` now counts the writes
    in flight per key and remembers a win until the last of them ends: a win moves the record
    from a non-final state, so a write that throws or loses after it can't be the one that
    committed. Once no write is in flight the win is forgotten, so a reopened record's write
    (0073) that throws is listed as before. A test races a write that throws a moment late with
    one that commits, 200 times on PostgreSQL: before the fix the fee was counted twice by run 3.
56. **The oldest open age has no sample until a sweep has listed** (akot, 2026-11-05; from
    Karol's review of #112). It was set at the end of a sweep and read 0 before the first one, so
    after a restart with the store failing, a 2-hour-old record read 0 for as long as the listing
    failed, and `pending` (a Level alarm) would turn OK at the wrong moment. A gauge read may now
    return no value, which writes no sample and reports no issue; the age has none until a sweep
    lists, so `pending` keeps its state through the gap (decision 19), and `sweeps-stopped`
    covers a listing that keeps failing. It is also set right after `listNonFinal`, from what was
    listed, so a first sweep stuck on the RPC already shows the backlog, and again at the end
    from what the sweep left open.
57. **Label keys are typed from the catalog** (akot, 2026-11-05; from Karol's review of #112;
    amends the spine's AD-3). A mistyped key, `{ faults: "ours" }`, matched no set's `when`, so
    it wrote no line and logged nothing, and decision 22's scope types didn't catch it. Each
    catalog entry now lists its log-only labels in `fields`; with its sets' dims, their `when`
    keys and its `values`, they are the keys the port's `increment` and `registerGauge` accept
    for that name, and a metric with none takes no labels at all. Declaring them showed 20
    metrics writing log fields the catalog didn't name (`reason`, `origin`, `breaker`, ...); all
    are listed now. The writer is unchanged: it still takes any record, and an `undefined`
    value is a label not given.
58. **The catalog holds the series rule beside its data** (akot, 2026-11-05; from Karol's review
    of #112; corrects the spine's AD-1 wording). The spine said `packages/metrics-catalog` holds
    only data and types, while it exports `effectiveSets`, `whenHolds`, `isDimValue` and
    `seriesDims`. The wording changes, not the code: they are small pure functions over the
    catalog that the EMF builder, the alarms and the Lambdas must apply alike, and moving them
    would mean a second package or three copies. The catalog's header already said so.
59. **`createRpcStallTracker` loses its unused `everyMs`** (akot, 2026-11-05; from Karol's
    review of #112). No caller passed it; the tracker polls every `RPC_STALL_POLL_MS`.

60. **A failed settlement reaches an alarm** (2026-11-05, from Karol's review of #114, point 1). An
    `expired` record, an `unexpected_settle_error` answered with status 200, and a hook that threw
    reached none: `failure-ours` needs a fee, `pending` a record past 750 s, `http-500` a 500.
    `settlement-expired` (`settlement_reconciled_total` for `state="expired"`), `submit-failed` and
    `hook-failures` are Event alarms on counters the facilitator already wrote; the three become
    eager-first, and `settlement_reconciled_total` bills `state` for `expired` only.
61. **`http-500` fires on the first error** (2026-11-05, point 3). 5 in 5 minutes let 4 errors pass,
    while `onError` takes anything it doesn't know as ours. It is the plain Event shape, which
    sends one message per burst. `http_requests_total` stays aggregated: making it eager-first
    would write a line per route and status, and a crash after a 500 fires `facilitator-failed`.
62. **`uptime-flapping`, 10 failing minutes of 30** (2026-11-05, point 4). `uptime` needs 7 in a
    row, so a loop that comes up for a minute between restarts (`0 0 0 0 0 0 1`) never fired it.
    Same series, same missing-data rule, in the `uptime` group. One deploy stays under 10; synth
    refuses a count at `uptime`'s run or at the window.
63. **`breaker-opened` per breaker kind** (2026-11-05, point 7). An Event alarm stays in ALARM for
    its window, so one series let payer breakers opened with fresh accounts hide a `pay_to` or
    `asset` one. The catalog bills `breaker`: 3 series per network instead of 1, $0.60 a month
    more per network.
64. **#115 posts each theft finding to the topic itself** (2026-11-05, point 5). Root on the server
    can write a forged `account_effects_unexpected` point every 15 minutes and hold the alarm in
    ALARM, and CloudWatch notifies only on a change, so a real theft would send nothing. The
    off-server check publishes each finding (account, effect or signer change, transaction) to
    `x402-<env>-alarms` straight from AWS, one message per finding, deduplicated by its cursor;
    `account-effects` and `account-state` stay as the backstop for a check that can't publish.
    Its role gets `sns:Publish` on that topic only. #115 builds it.
65. **The log path reaches other projects' namespaces; `log-volume` is the ceiling** (2026-11-05,
    point 6). An EMF line in our metrics group can name any namespace of the shared account, such
    as `SorobanBlockExplorer/Indexer`, which the explorer alarms on, and create custom metrics
    without limit. No IAM condition covers an EMF namespace. The explorer's and the Prices API's
    owners are told before `host` goes on. `log-volume` gets a coarse 200 MB an hour per group,
    set before any measurement, and synth refuses `host` without it.
66. **No protocol-upgrade watch in 0027** (2026-11-05, point 2). The explorer has one after a
    16-hour stall at an upgrade. For the facilitator an upgrade is mostly an SDK update; a watch
    reads the validators' votes, not a metric we have. It is named in G-alarm-list's Deferred, to decide with 0038 before
    mainnet.
67. **Three cuts in `infra/`** (2026-11-05, point 8). The Count shape was `event()` with 5-minute
    periods, N = 3 and a threshold, so it went; `pool-health` is that Event. The fee account's
    check is `StrKey.isValidEd25519PublicKey`, as in the facilitator's config, not 30 lines of
    base32 and CRC16. The config is a zod schema, as in the facilitator and the MCP packages,
    with the same messages and every field's problem at once.

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
`failure-ours`, `commit-unmatched`, `balance-stale`) on 0024 (#105); the not-ready, uptime, host
and real-path criteria on 0026's server and first deploy; the backup-secret read on 0026 creating
the secret; `channel-held` on 0089's gauge; `disk` and `memory` on their first numbers. 0036's
signer is on develop.
