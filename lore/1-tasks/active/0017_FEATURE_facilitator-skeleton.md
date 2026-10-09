---
id: "0017"
title: "Facilitator skeleton with store ports, settlement hooks and config"
type: FEATURE
status: active
milestone: 1
related_adr: ["0004"]
related_tasks: ["0012", "0009", "0013"]
tags: [facilitator, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 1.1 (Platform lane)."
  - date: "2026-10-08"
    status: active
    who: okarcz
    note: >
      Started the day-1 part only: the types-only PR with the four store ports, the settlement
      hook signatures and the zod config schema. The rest of the skeleton goes to the Platform
      lane owner once the types PR is approved.
  - date: "2026-10-08"
    status: active
    who: stkrolikiewicz
    note: >
      Day-1 types PR #7 approved by all three lanes (Adam for Discovery, Stan for Platform,
      okarcz as author for Payments) and rebase-merged into develop (993edad). okarcz hands the
      rest of the skeleton over to Stan, the Platform lane owner.
---

# Facilitator skeleton with store ports, settlement hooks and config

## Status: Active

> Started 2026-10-08 by okarcz on branch `lore-0017-day1-types` for the day-1 types-only PR
> (first acceptance criterion). PR #7 merged on 2026-10-08; the rest of the skeleton is now with
> Stan (stkrolikiewicz), on branch `lore-0017-facilitator-skeleton`: in-memory adapters, port
> contract tests, the HTTP app with stub routes, `src/main.ts` and the boot tests.

## Summary

As a developer on any of the three lanes, I want a facilitator app that boots, validates its config and wires every part through one composition root, with typed store ports and settlement hooks, so that Payments, Discovery and Platform can build and test their parts in parallel against in-memory fakes.

**Story:** [M1 Story 1.1](../../../docs/planning/m1-epics.md#story-11-facilitator-skeleton-with-store-ports-settlement-hooks-and-config) · **Lane:** Platform · **Covers:** enables FR1–FR21; AD-1, AD-7, NFR7, NFR8

## Context

- `apps/facilitator/src/index.ts` is a placeholder today (`export {};`).
- This story is what lets the three lanes start in parallel: it fixes the seams (ports, hooks, config) on day 1 and the running skeleton by day 3.
- The spine's layout: `http/`, `settlement/`, `ports/`, `adapters/` under `apps/facilitator/src/` (AD-1, AD-7).
- Related tasks: 0009, 0013.

## Implementation

- Day 1: types-only PR with ports, hook signatures and the zod config schema (fee settings, budgets, rate limits, `FACILITATOR_SECRET`, `CHANNELS`, RPC URLs).
- Express 5 app with stub routes; add `zod` to `apps/facilitator`.
- `src/main.ts` composition root that builds the graph from config and picks memory or real stores.
- In-memory fakes for the four ports; one boot-level integration test with `fake-rpc`.
- A small structured logger interface; the backend is chosen in 0014.

## Acceptance Criteria

- [x] Given a types-only PR with the four store ports (`SettlementStore`, `CatalogStore`, `RateLimitStore`, `SpendStore`) and the operations AD-7 requires, the before-submit and on-success settlement hooks, and the zod config schema, when it is opened on day 1, then all three lanes review and approve it before lane work builds on it
- [x] Given a valid environment, when the app starts, then it reads and validates config once with zod, listens on the configured port and answers stub routes for `/verify`, `/settle`, `/supported` and `/discovery/resources`; `src/main.ts` is the only composition root and the only place that reads `process.env`
- [x] Given a missing or invalid config value, when the app starts, then it exits with an error that names the value and never prints a secret
- [x] Given the test setup, when the integration test boots the app with in-memory fakes of all four ports and `fake-rpc`, then it passes with no network and no database; each port has an in-memory fake in `apps/facilitator`; logs are structured, one event per line, and never contain secrets or full XDR; requests have a body size limit (no RPC is in the graph yet, so the boot test needs no `fake-rpc`; see decision 14)

## Implementation Notes

### Day-1 types PR (branch `lore-0017-day1-types`)

- `apps/facilitator/src/ports/`: `SettlementStore`, `CatalogStore`, `RateLimitStore`,
  `SpendStore`, plus a `Stores` bundle for the composition root.
- `apps/facilitator/src/settlement/hooks.ts`: `SettlementHooks` with `beforeSubmit`, `onFinal`
  and `onSuccess`.
- `apps/facilitator/src/config.ts`: zod env schema, `parseConfig()` into a grouped `Config`, and
  `ConfigError`, which names each bad setting without echoing its value.
- `apps/facilitator/test/config.test.ts`: 8 tests (full `Config` mapping, defaults, trimming,
  missing and invalid values, no value echoed in errors, key checksums, duplicate channels, strict
  numbers, RPC URLs).
- `zod` ^3.25.76 and `@stellar/stellar-sdk` ^16.3.0 (for `StrKey`) added to `apps/facilitator`.
- `deploy/*.env.example`: `STELLAR_RPC_URL` renamed to `RPC_URLS`. The secret variables are left
  for 0020.

### Running skeleton (branch `lore-0017-facilitator-skeleton`)

- `apps/facilitator/src/adapters/memory.ts`: in-memory adapters of the four ports and
  `memoryStores()`, used for `STORE=memory` and in tests.
- `apps/facilitator/src/logger.ts`: `Logger` interface and `jsonLogger()`, one JSON object per
  line on stdout.
- `apps/facilitator/src/http/app.ts`: `createApp(deps)` with the four routes answering 501, a
  JSON 404, a body size limit (413), the client's own body errors (400, 413, 415) passed through
  unlogged with a body code named after the status, and a logged 500 for anything else. An
  answer that already started goes to Express. `AppDeps` is the graph the composition root hands
  over; lanes add their services to it.
- `apps/facilitator/src/main.ts`: `main()` reads `process.env` once, parses the config and starts
  the server; `start(deps)` is what tests call. It only exports.
- `apps/facilitator/src/server.ts`: the process entry point. It calls `main()` and closes the
  server on SIGTERM or SIGINT; a startup failure logs `startup_failed` with the config problems
  and exits with code 1. `src/index.ts` is gone; `dev` and `start` run `server`.
- `apps/facilitator/test/port-contracts.ts`: one contract suite per port, for 0022 to run
  against the durable adapters. `memory.test.ts` runs them against the in-memory adapters.
- `apps/facilitator/test/main.test.ts`: boots the app on memory stores (stub routes, no CORS,
  413, 400, 415 with their body codes and without an `http_error` log, 404, JSON-lines logs
  without the secret), spawns `src/server.ts` with a bad config to check the exit code and that
  no value is printed, and checks it exits 0 on SIGTERM.
- `apps/facilitator/test/logger.test.ts`: the envelope wins over fields; errors keep their stack
  and one level of cause, also when the cause chain is cyclic; an error's `toJSON` snapshot is
  never logged; an unserializable field keeps the event instead of throwing.
- 38 facilitator tests pass (8 config, 22 contract, 5 boot, 3 logger); typecheck, lint, Prettier
  and build pass.

## Design Decisions

### From Plan

1. **Four ports in `apps/facilitator`** with the operations AD-7 lists: atomic `claim`,
   `findByHash`, forward-only compare-and-set `transition`, catalog `upsert` by key and `list`
   with the AD-20 filters, and fixed-window rate-limit counters.
2. **Upstream types on the wire**: records hold `@x402/core` `PaymentPayload` and
   `PaymentRequirements`; the catalog stores and returns `@x402/extensions` `DiscoveryResource`.

### Emerged (confirmed by Adam in the PR #7 review; 5 and 10–13 come from it)

3. **The channel lease lives on `SettlementStore`**: AD-7 fixes four ports and lists the lease
   among the operations the store must support, so there is no fifth port.
4. **A third hook, `onFinal`**: 0024 must settle or release the spend reservation and feed the
   breakers on every final outcome, not only on `success`.
5. **`extensionResponses` and `onSuccess` are separate hooks**: the first version had one
   synchronous `onSuccess` that returned the header and started the catalog write, which then
   ran before the response. Now a pure, synchronous `extensionResponses(record)` returns a typed
   `{ bazaar: { status, reason? } }` for the `EXTENSION-RESPONSES` header, and an async
   `onSuccess` runs after the response (AD-8).
6. **`addHash` is separate from `transition`**: a rebuild adds a hash while the record stays
   `signed`, which a state compare-and-set can't express.
7. **Records keep the payload and requirements**, so a late `success` (startup re-check or
   `resolved` event) can still catalog the resource.
8. **Env names**: `RPC_URLS` (comma-separated, as in the smoke script) replaces
   `STELLAR_RPC_URL`; `STORE` takes only `memory` until 0022.
9. **Interim numeric defaults**, to be confirmed by the owning tasks: `MAX_FEE_STROOPS` 250,000
   (the pool's default), `MIN_VALIDITY_LEDGERS` 12, `SETTLE_TIMEOUT_MS` 30 s, `LEASE_TTL_MS` 30 s,
   body limit 64 KiB, rate limits per minute 120 verify / 60 settle / 120 discovery, a daily spend
   window with 500 XLM global, 5 XLM per payer, 50 XLM per `payTo` and 200 XLM per asset, and a
   breaker after 5 failures with a 10-minute cooldown.
10. **A refusal by `beforeSubmit` ends the record as `rejected`**: `claimed → rejected` with the
    hook's `errorReason`, also when the hook throws; `onFinal` is not called.
11. **`CatalogStore.upsert` merges `accepts`** by `scheme + network + asset`, because one
    settlement knows one requirement; the caller stamps `lastUpdated`. The upstream `scheme`
    filter is left out of T1.
12. **Expired leases can't be renewed**: `renewLease` returns `false` once `now > expiresAt`.
13. **Stricter config**: keys checked with `StrKey`, duplicate channels refused, numbers as plain
    decimals with upper bounds (timers at most 2^31−1 ms), RPC URLs only http(s) and at least
    one, values trimmed, and every error message is ours so none echoes a value.

### Emerged (running skeleton, Stan)

14. **No RPC and no `fake-rpc` in the skeleton**: nothing in the graph calls RPC yet, so the boot
    test proves "no network" without one. The pool and its RPC join the graph with 0009 and
    0020, and those tasks decide how facilitator tests get `FakeRpc` (it sits in
    `packages/signer-pool/test/` and isn't exported; a `./testing` subpath export is the
    suggestion).
15. **A final state is terminal in `transition`**: the port doc said a backward move is dropped;
    a final → final move (e.g. `rejected → success`) is dropped too. The port doc and the
    contract test now say so.
16. **`FEE_ESCALATION_FACTOR` must be above 1**: the pool's constructor refuses a factor of 1 or
    less, so a value of 1 passed the config and then crashed startup with a non-config error.
17. **Stub routes answer 501** with `{ error: "not_implemented" }` until their tasks land; unknown
    routes get a JSON 404.
18. **Hand-rolled JSON-lines logger** instead of pino: enough for T1; 0014 picks the backend and
    may switch.
19. **In-memory spend semantics** (0024 may refine them): `commit` moves the reservation's time
    to `now`, and a window counts reservations with `now - windowMs < time ≤ now`. A lease is
    expired once `now > expiresAt`, matching `renewLease`. The in-memory maps are never pruned
    (marked with `ponytail:` comments).

### Emerged (PR #11 review, Adam)

20. **Every exposable 4xx from body-parser passes through**: only 400 and 413 did, so a client
    could get a logged 500 with `charset=latin1` or an unknown `Content-Encoding` (415) and fill
    the error log. Now `expose` and `4xx` decide.
21. **The `extensions` catalog filter needs an own key with a value**: `?extensions=constructor`
    matched every resource with an `extensions` object. `Object.hasOwn` alone would have let a key
    set to `undefined` match in memory but not in JSON storage, which drops it, so the filter
    checks both. Two contract cases make 0022 behave the same.
22. **`CatalogStore.list` is in insertion order**, and an upsert keeps an entry's place. The test
    already pinned it; the port doc now says so, so offset paging doesn't shift each time a
    resource settles again. 0022 needs a serial or `created_at` order for it.
23. **The log envelope wins over fields**: a field named `level`, `event` or `time` could
    overwrite it.
24. **Logged errors keep `stack` and one level of `Error` `cause`**: a logged 500 had only name
    and message to debug from. A stack adds code locations, not data (its first line is the
    message); non-`Error` causes are left out, since they may hold anything. Only one level,
    because a cyclic cause chain made `JSON.stringify` overflow the stack and the logger throw.
25. **`src/server.ts` is the entry point; `main.ts` only exports**: the
    `import.meta.url === argv[1]` check failed through a symlink (Node resolves the module path
    but not `argv[1]`), so the process exited 0 without starting.

### Emerged (PR #11 review, Oskar)

26. **The logger recognizes an error before its `toJSON`**: `JSON.stringify` calls `toJSON`
    before the replacer, so an AxiosError (stellar-sdk 16's RPC client uses axios 1.18) was logged
    as its snapshot, which holds the request body: the full signed transaction XDR. The replacer
    now checks the holder's original value.
27. **A log call never throws**: a cyclic or otherwise unserializable field logs the event with
    `fields: "unserializable"`. A throw in the HTTP error handler would hand the error to Express,
    which answers with an HTML stack trace while `NODE_ENV` is unset.
28. **`transition` only moves forward, never to the same state**: a same-state update let two
    concurrent callers both win, the second overwriting `channel`. ADR 0006 already says states
    only move forward; the port doc says so now, and two contract cases cover it for 0022.
29. **`server.ts` closes the server on SIGTERM and SIGINT**: Node as PID 1 in a container ignores
    SIGTERM without a handler. The handlers are registered before `main()` runs: the first version
    registered them once the server listened and lost a signal sent right after startup (the boot
    test caught it under load). The drain and the lease release stay in 0025.
30. **The error handler hands an answer that already started to Express** (`res.headersSent` →
    `next(error)`), which ends the connection.
31. **Client error bodies name the status**: `payload_too_large`, `unsupported_media_type`,
    `bad_request`, from `http.STATUS_CODES`, like `not_found` and `not_implemented`.

## Deferred from the PR #7 review

These go to the tasks that own them (Adam's review):

- Port contract tests: rest of 0017 (fakes) and 0022. Done in `test/port-contracts.ts`; 0022
  runs the same suites against the durable adapters.
- The `SpendStore` reservation lifecycle: 0024.
- Wrapping `onSuccess` errors in the caller: 0009.
- A bigint codec for stored amounts: 0022.
- Redacting RPC URLs in logs: 0014.

From Stan's review:

- `onFinal` errors never reach the caller and `/settle` doesn't wait for it: stated in
  `hooks.ts` (993edad); the behavior is built in 0009 and 0024.
- A lost `onFinal` call after a crash leaves the reservation counted until it ages out of the
  rolling window; acceptable for T1. Noted in 0024.
- A `claimed` record with no hash at startup is closed as `rejected`: added to 0019 (f65fac2).

## Deferred from the PR #11 review

- The drain on SIGTERM/SIGINT (refuse new `/settle`, wait for in-flight work, release the lease):
  0025 already has it as an acceptance criterion. The plain close is in `server.ts` (29).
- `SpendStore.commit` for an id with no reservation is a no-op the port doesn't define (Oskar):
  noted in 0024, which owns the reservation lifecycle.
- The in-memory spend and rate-limit maps are never pruned, so each `sum` scan grows with the
  process (Oskar): fine for tests and dev runs, since deployments use the 0022 stores (0026).
  The `ponytail:` comment names the fix.
- A rate-limit window of 0 makes the in-memory counter useless (Oskar): the config schema holds
  `RATE_LIMIT_WINDOW_MS` at 1 s or more, and the port doc now says the window is positive.
