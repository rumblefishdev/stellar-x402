---
title: "PR #112 architecture spine: the facilitator's metrics"
type: synthesis
status: developing
tags: [monitoring, cloudwatch, emf, metrics, architecture, spine]
links:
  - ../README.md
  - G-metrics.md
  - G-alarm-list.md
  - R-log-path-spike.md
history:
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "Consensus from the GSD gray-area research, decided 1a/2a/3a/4b/5a/6a. The invariants that keep #112-#115 from diverging; everything else is seed or deferred."
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "v2 after an unanchored re-review: network scoping, dimension sets, the writer's timing and shutdown, gauges computed at read time, and what the later PRs inherit. Supersedes v1's AD-1 to AD-5."
  - date: "2026-11-04"
    status: developing
    who: akot
    note: "AD-3: scope checked by the compiler, a ProcessMetrics root and a NetworkMetrics child, in place of a runtime drop watched by an alarm."
---

# PR #112 architecture spine: the facilitator's metrics

The consistency contract for the 0027 stack (#112-#115). It fixes only the invariants that two
independently built PRs, or two call sites, could otherwise choose incompatibly. The metric and
alarm lists are in [G-metrics](G-metrics.md) and [G-alarm-list](G-alarm-list.md); this note says
how the code that emits and alarms on them is shaped.

## Paradigm: catalog-as-contract, scoped to identity

One typed catalog declares every metric's identity, and the emitter (#112), the agent config and
host probe (#113), the alarms (#114) and the off-server Lambdas (#115) all check themselves against
it. It covers the identity class of failure: a name, namespace, unit, dimension or dimension value
written in one place and restated by hand in another. The sibling projects lost alarms to exactly
that (a reworded log filter, an `Environment` value that didn't match). It doesn't cover alarm
behaviour (delivery, latching, missing data), which stays per alarm in #114. A catalog that owned
alarm defaults would erase the per-alarm reasoning, and the same sibling project reverted such a
refactor for that reason.

## Architecture decisions

Each `AD` names what it **Binds**, what it **Prevents**, and the **Rule**.

### AD-1: the catalog is its own package, for all three namespaces
- **Binds:** the facilitator (#112), the host probe (#113), the CDK (#114), the Lambdas (#115).
- **Prevents:** names, dimensions and `network` values drifting between emitter and alarm.
- **Rule:**
  - `packages/metrics-catalog` holds only data and types. Its only dependency is
    `@stellar-x402/config`, so `network` values are the CAIP-2 strings from `STELLAR_NETWORKS`
    (`stellar:testnet`), never retyped.
  - It declares the `x402-facilitator`, `x402-host` and `x402-watch` namespaces and their metrics.
  - It owns identity only: no thresholds, periods or `treatMissingData`.
  - #114 joins the workspace (an `infra` glob) and asserts on the synthesized template that every
    alarm's namespace, metric and dimensions exist in the catalog.
  - #113's `sh` probe can't import TypeScript, so a test runs it with fakes and checks each name
    it writes against the catalog.

### AD-2: one entry schema, with dimension sets and a scope
- **Binds:** the emitter, the EMF builder, #114's alarms.
- **Prevents:** an undeclared metric or dimension compiling; an alarm that needs metric math to
  read a series that could have been emitted whole; a dimension set CloudWatch drops.
- **Rule:** each metric is one `as const` entry. Roughly:
  `{ namespace, name, kind: "counter"|"gauge", unit, scope: "network"|"process",
  sets: { dims: string[]; when?: { [label]: readonly string[] } }[],
  values?: { [dim]: readonly string[] }, emit: "eager-first"|"aggregated" }`.
  - **`unit`** is fixed for the metric's life. Alarms omit `Unit`, since a mismatch leaves an
    alarm in INSUFFICIENT_DATA.
  - **`scope`:** `network` puts `network` in every set of the metric; `process` never carries it.
    `http_requests_total` is `process`, since a route serves both networks after 0077.
  - **`sets`:** a line carries every set whose `when` matches its labels. A set is written only if
    every one of its dimensions has a valid value, so CloudWatch never receives one it would
    drop. Each alarm reads one series (per network, for a network-scoped metric) without metric
    math, except where G-alarm-list says math (`store-outage`). Examples:
    - `http_requests_total`: `[route]` always, plus `[status]` when `status` is `500`.
    - `spend_budget_nearing_total`: a set without `budget` when `budget` is `asset`, `other` or
      `global`.
  - **`values`:** the closed set for each billed dimension, including `other`. A value outside it
    is written as `other` and logged once. A host dimension that #113 names later, such as a disk
    mount, may stay open (any non-empty string) until then. Every facilitator dimension is
    closed.
  - **Log fields:** labels that are in no set are written as log fields, unrestricted.

### AD-3: the `Metrics` port: counters, pulled gauges, and network scoping
- **Binds:** every call site, the EMF adapter, `memoryMetrics()`, `compose()`.
- **Prevents:** a call site forgetting `network`, a wrong per-process network once 0077 runs both
  networks in one process, and a stale gauge.
- **Rule:**
  - **Counters:** `increment(name, labels?, by = 1)`.
  - **Gauges:** `registerGauge(name, read)`, where `read` is pulled at sampling time.
  - **Scoping, checked by the compiler:** the root is a `ProcessMetrics`, whose names are the
    catalog's process-scoped ones, and `for({ network })` returns a `NetworkMetrics`, whose names
    are the network-scoped ones (`ProcessCounterName`, `NetworkCounterName` and the gauge
    pair, derived from each entry's `scope`). `compose()` hands each per-network part its child
    and the HTTP app, discovery, the cataloger and the pruner the root. A metric written in the
    wrong scope doesn't compile, so no alarm watches for it. A cast that gets one through: a
    network-scoped name on the root writes no line (no valid set) and the writer logs
    `metric_issue` once; a process-scoped name on a child writes its line, with `network` only a
    log field.
  - **Labels:** only `name` is typed against the catalog. `labels` stays a permissive record, and
    `network` is reserved for `for()`.
  - **Test double:** `memoryMetrics()` itself takes every facilitator name, so a test can hand it
    to a part of either scope; its `for()` child is a plain `NetworkMetrics`, and the parts' types
    do the checking.

### AD-4: the writer's semantics
- **Binds:** the port contract, #113's agent filter, #114's alarm shapes.
- **Prevents:**
  - lost or doubled points;
  - an event lost to a crash;
  - lines cut off at exit;
  - an invalid line that silently disables every not-breaching alarm.
- **Rule:**
  - **Sink:** the writer writes straight to `MainOptions.write` (stdout by default), the sink the
    logger writes to as well, and never goes through the logger: the logger's envelope can't put
    `_aws` first, and its replacer turns bigints into strings.
  - **Line shape:** every line starts `{"_aws":`. That prefix is a constant #113's filter shares.
  - **Values:**
    - finite numbers only;
    - a bigint is converted to a number;
    - a non-finite value drops its line;
    - every dimension value is a non-empty string.
  - **Window:**
    - counters are per-window deltas;
    - the flush is aligned to the wall-clock minute;
    - `Timestamp` is the window start;
    - one minute line per series and log-field set: a counter whose log fields vary (`reason`,
      `replay`) writes a line for each, and CloudWatch sums them, so `Sum` is the minute's count
      but `SampleCount` isn't one per minute. A value written as `other` keys as `other`, so
      unknown raw values add no lines. An `eager-first` series also has the line its first
      increment wrote.
  - **Event-class metrics** (alarm on 1 or more) are `eager-first`: the first increment of a series
    in a window goes out at once as its own line, and later ones add to the minute line. Volume
    stays bounded under a burst, and the deciding point leaves the process before a SIGKILL.
  - **Gauges** are sampled every 10 s and written as a `Values` array (at most 100), so `Minimum`
    and `Maximum` describe the minute. The array semantics are unverified in the docs; check them
    at the first deploy.
  - **Zero seeds:** the only zero written is `settlement_sweeps_total{outcome="listed"}` for each
    configured network. Zeros make an hour billable.
  - **Never throws.** Each public method and each gauge read is isolated, and one failure never
    drops the rest of a tick.
  - **Lifecycle:** `main()` builds the writer, with its seed, after the RPC network check and just
    before `compose()`, which takes it as the root (`memoryMetrics()` when none is given), so a
    startup that hangs after it (the channel check, the lease) still writes its zeros; one stuck in
    the network check, which fails within seconds, writes none. `main()` starts the RPC stall tracker `compose()` builds at the same time. The final
    flush runs at the end of `closeOnce`, after the tracker stops, and is awaited before
    `process.exit`, since a stdout pipe is asynchronous. A `startup_failed` exit writes no final
    flush, so a start that failed writes no liveness point.

### AD-5: gauges are computed when read
- **Binds:** the gauge sources, #114's Level alarms.
- **Prevents:** a gauge that freezes at a healthy value when its source dies.
- **Rule:** an age gauge is `now − timestamp` at read time, so a dead source shows as a rising
  value. The sources:
  - **`settlement_oldest_open_seconds`:** the oldest open record's `createdAt`. `history_gone`
    records are left out, computed at the end of each sweep, the recheck-skip branch included.
  - **`rpc_stalled_seconds`:** the time since the ledger sequence last changed, read through the
    shared `FallbackRpc`. The poller's endpoint moves are accepted. The baseline resets when the
    active endpoint changes or the sequence drops (a lagging fallback, testnet's reset). A failed
    read leaves the age rising.
  - **`balance_reading_age_seconds`:** a pure accessor on the floor. Startup warns when the
    configured `maxStaleMs` isn't the 300 s the alarm assumes.
  - **`rpc_on_fallback`:** compares `active` with endpoint 0's name, never `begin()`.

### AD-6: an alarm goes on only once its signal is emitted
- **Binds:** #112's catalog and #114.
- **Prevents:** an alarm reading OK on a series that doesn't exist yet.
- **Rule:** the catalog may declare metrics ahead of their emitters. #114 switches each alarm group
  on after its series has data, or with `WarmUpConfiguration`. Today only
  `channel_longest_hold_seconds` has no emitter. It needs a signer-pool change, so 0089 ships it as
  its own small PR on #112's port, and its `channel-held` alarm waits for that PR.

## Shape

```mermaid
flowchart LR
  CFG["@stellar-x402/config\nSTELLAR_NETWORKS"] --> CAT
  subgraph leaf["packages/metrics-catalog"]
    CAT["entries: namespace, name, kind, unit,\nscope, sets, values, emit"]
  end
  subgraph fac["apps/facilitator"]
    PORT["Metrics: increment, registerGauge, for(network)"]
    W["EMF writer: aligned minute, eager-first,\nsampled gauges, awaited final flush"]
  end
  CAT --> PORT
  CAT --> W
  PORT --> W
  W -->|"{\"_aws\": ...} lines"| AG["agent (#113)"]
  CAT --> PROBE["host probe test (#113)"]
  CAT --> ALM["CDK alarms + template test (#114)"]
  CAT --> LMB["Lambdas (#115)"]
  AG --> CW["CloudWatch"] --> ALM
```

## Seed (owned by the code)

- The builder is pure and tested against the exact JSON. The adapter holds the state, the timer
  and the I/O.
- `http_requests_total` is counted in a middleware mounted first, on `res.on("close")`:
  - **Status:** the final status when the response finished, or `aborted`.
  - **Route:** from a fixed path-prefix map, never `req.route`.
- `settlement_sweeps_total`:
  - `listed` is counted at `onListed`, not at the end of a sweep;
  - `failed` is counted in the scheduler's catch.
- `settlement_outcomes_total` gets a `result` label (`success` or `error`) at its call site.
- `fee_charged_stroops` is counted where the record's final write wins, plus the
  landed-after-expired path. It is approximate (EMF is at least once), so the weekly review takes
  the database as the source of truth.

## Handed to the later PRs

Decided here, built there. The notes G-metrics and G-alarm-list carry them.

- **#114:**
  - Level alarms use `treatMissingData: ignore`, so a crash isn't reported as a recovery
    (decision 19).
  - Alarms on `EMFValidationErrors` and `EMFParsingErrors` for the metrics group.
  - A one-off check that `EMFDisabledErrors` is 0 on the shared account.
  - The metrics group is kept 30 days, like the app group (decision 18): the log fields read
    with Logs Insights, and the weekly fee review, need it.
  - `store-outage` stays metric math.
  - `delivery-test` on every deploy of the alarm stack.
- **#113:**
  - The agent's host metrics go to `x402-host` with the catalog's dimensions, not the agent's
    default `CWAgent`.
  - Its filter uses the catalog's `EMF_LINE_PREFIX` (`{"_aws":`), which #112 already exports.
- **Open:** a single gauge that goes silent while sweeps continue is caught by no alarm. Decide in
  #114 whether one is worth adding.

## Deferred

- The `channel-held` alarm, until 0089's PR.
- An external dead-man's switch for a host outside AWS, which the sibling projects recommend:
  decide before mainnet, with 0038.
- Whether EMF value arrays aggregate as samples: verify at the first deploy, or fall back to
  writing the minute's minimum and maximum as two metrics.

## What v2 changed

- **v1's AD-1 (catalog):** widened to all namespaces and the shared network values.
- **v1's AD-2 (entry schema):** gained dimension sets, scope, closed values and a fixed unit.
- **v1's AD-3 (port):** gained `for({ network })`. In v1 no call site passed `network`, so every
  network-scoped metric would have been dropped by CloudWatch.
- **v1's AD-4 (emission):** a line per event became eager-first, plus the aligned window, the
  awaited exit flush and sampled gauges.
- **v1's AD-5 (an alarm only once its emitter exists):** now AD-6, with 0089's gauge the one
  metric declared ahead of its emitter.
- **New:** AD-5 (gauges computed when read).
