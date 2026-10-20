---
title: "PR #41: the reviews, the fixes and the testnet runs"
type: research
status: mature
spawns: []
tags: [facilitator, settlement, review]
links:
  - ../README.md
  - S-design-decisions.md
history:
  - date: 2026-10-16
    status: mature
    who: claude
    note: "Moved out of the task README when 0009 became a directory (Adam's third review)."
---

# PR #41: the reviews, the fixes and the testnet runs

What each round of review found and changed, in order. The decisions themselves are in
[S-design-decisions.md](S-design-decisions.md).

## Rebase onto develop after 0018 merged (2026-10-14)

`main.ts` got `buildChecks(config, rpc, fees)`, from which `createVerifier` (`/verify`) and
`createChecker` (`/settle`) are built, and the pool takes the same `fees.pool`. `createChecker`
keeps 0018's envelope check, upstream deadline and string `payer`, and throws when upstream names
no payer for a valid payment, as 0018 does for `unexpected_verify_error`. Facilitator 145 tests
after the rebase, and the testnet `scripts/settle-smoke.ts` passed all 5 checks again.

Adam's four handoff points from 0018's PR #33 then took it to 148: the settle floor through
`buildChecks`, the real-checker `payer` test, and the refusal warning; `accepted` differs in
`settle.test.ts` and `settle-route.test.ts`. Each fix's mutant (the `/verify` minimum at
`/settle`, `accepted` passed as the requirements to the settler or used for the amount, no
refusal metric) fails 1–24 tests.

**Modified tests:** the budget test "answers a retryable timeout…" also expects the record
`rejected` with `…_timeout` and one `onFinal` (decision 11). `main.test.ts` no longer expects 501
from `/settle`. It and `verify-route.test.ts` pass `settle` and `extensionResponses` stubs to
`start()`. `config.test.ts` expects `settleBudgetMs`. `settle.test.ts` and `settle-route.test.ts`
give the payload an `accepted` whose amount differs from the requirements.

## First review (2026-10-14)

10 findings, each checked against the code. Five were real and are fixed (decisions 11–15). Two
were not bugs: the success hash (the pool reports only envelopes it sends, rebuilds only after a
`txBadSeq` that applied nothing, and its last attempt is `hash`) and a muxed `payTo` (upstream
reads the event amount the same way, so `/verify` refuses it first). Three were skipped: the
`settle-smoke.ts` port race (config refuses `PORT=0`, and it's a manual script), sharing `within`
with `withTimeout` (one resolves `undefined`, one rejects with a named error), and `advance()`'s
extra read before each write (left for 0022's durable stores). One helper now logs and counts hook
failures for all three hooks. Facilitator tests 148 → 153; putting each bug back fails 1–5 of
them. The testnet run wasn't repeated for this round; the second round's run covers it.

## Second review (Adam, 2026-10-15, changes requested)

2 blockers reproduced on testnet, 1 before pubnet, 3 before 0022/0024, the `/verify`–`/settle`
disagreement, 11 minor points and the test gaps. All fixed (decisions 16–28), with okarcz's choices
for the two that needed one. `apps/facilitator/README.md` lists every `/settle` answer with what
an integrator should do. `@stellar-x402/signer-pool/testing` exports `FakeRpc`, and
`settle-pool.test.ts` runs `main()`'s `/settle` wiring on the real pool. Facilitator tests
153 → 177, signer-pool 99. Mutants caught: `createChecker(checks)` at `/settle`, a pool without
`fees.pool`, `budgetMs: settleTimeoutMs`, a settler that ignores `addHash`'s `false`, a
fingerprint without the requirements, a no-op `checkSimulation`, `accepted.payTo` in the balance
check, success on every replay (7 tests), a repeat anchored on its own start, no budget-over flag,
`onFinal` for a writer that didn't end the record.

**Modified tests:** `settle.test.ts`: concurrent calls, a repeat after the success and the
known-key repeat expect one success and `…_already_settled` for the rest; the payload's
`accepted` also differs in asset and `payTo`; the stub check returns the nonce and rejects a
payload without one payer entry, as `createChecker` does; "answers a retryable timeout…" became
"ends the record and answers a timeout…" and also checks the retry; "never sends what it answered
as timed out" asserts that the late `onSigned` rejects; the store-failure success expects the
header record; the late success expects `onFinal(…, "resolved")`; the different-fingerprint test
changes only the requirements and expects the hash. `config.test.ts`: 20 s / 30 s defaults, and
the timer range case moves to `LEASE_TTL_MS`. `settle-route.test.ts`: the settler gets an
`AbortSignal`, and the log a key. `port-contracts.ts`: two store contract tests.
`scripts/settle-smoke.ts` expects `…_already_settled` on the repeat and one success among the
concurrent calls.

## Third review (Adam, 2026-10-16, at `ba2903f`) and @karolko9's four points

Adam checked every earlier point against the code: all fixed, `rpc_unavailable` partly. Of 37
mutants, 5 survived. What was left, all fixed here (decisions 29–45), with okarcz's choice for
the success mark (decision 29) and the store-outage rule (decision 30):

- **Must fix:** a repeat answered `…_timeout` for a record it couldn't end (decision 31); the
  checks weren't bounded by the budget, and the claim then ran with a 0 ms bound (decision 32);
  `rpc_unavailable` covered only `RpcTimeoutError` (decision 36); `onFinal` ran before a late
  `beforeSubmit` settled (decision 34); source-account auth entries were refused only by upstream
  (decision 37); five README rows; the spine, ADR 0004 and ADR 0006 against the code; Karol's
  points and the PR body.
- **Should fix and nits:** the repeat's waits past its own budget (decision 33); the
  `addHash`/budget race (decision 35); silent store-read errors (now `settlement_record_failed`);
  two metric prefixes (decision 38); `canonical()` recursion (decision 39); `SETTLE_TIMEOUT_MS`
  (decision 40); logged errors with RPC URLs (decision 41); `main()`'s `/settle` wiring untested
  (decision 42); the `./testing` subpath (decision 43); comments, the port doc for
  `markSuccessAnswered`'s `updatedAt`, ADR header formats, `hooks.ts` and the README for a
  refusal the store couldn't record.
- **Karol:** the no-payer test (in `verify.test.ts`), the merchant cost of "nothing sent →
  `rejected`" (named in ADR 0011), the silent `store.get().catch` (logged), and the PR body.
- **Cross-PR with #45** (Adam's trial merge): the check bound is here; the rebase obligations
  are in decision 45.
- **Out of this PR, recorded in their tasks:** 0022 (durable store: the mark, `addHash`
  atomicity, clock skew, the `addHash` recheck, memory store growth), 0023 (memory store growth
  without a rate limit), 0024 (fee griefing by spending one balance in parallel; `onFinal` after a
  late hook), 0027 (the metric list, outcome counter, `rpc_failovers_total`), 0013 (the store
  outage requirement), 0020 and 0031 (sibling notes).

Facilitator tests 177 → 205, signer-pool 99 → 101. Mutants caught, each by 1–3 tests: `first =
false` on a mark failure, no process-local answered set, no answered set for the pool-result
success, no `budgetOver` recheck after `addHash`, no `left() <= 0` before the claim, an unbounded
check, the claim bounded by `left()` alone, a `pendingUntil` past the repeat's own budget,
`onFinal` before the hook settles, no `.catch` on a poll's read, an unbounded poll read, no
uncertain fallback, `…_timeout` for a record the store couldn't end, an unbounded mark; in
`main()`: no `onSuccess`, no `extensionResponses`, a second fee configuration for the pool; in the
route, dropping the `res.closed` branch.

**Modified tests:** `settle.test.ts` uses the `settlement_` metric names and the `stage` label on
`settlement_refused_after_verify_total`; the hang test's wall-clock bound is 1 s, not 150 ms, for
a loaded runner. `resilience.test.ts`: "throws the first error…" now expects `RpcUnavailableError`
with that error as its `cause`, and the timeout test expects it with an `RpcTimeoutError` cause.
`settle-route.test.ts`'s abort test also runs `afterResponse` after the client left.

## Fourth review (Adam, 2026-10-16, at `0e77d9f`)

Adam checked the third round in the code: 39 of 43 points resolved, 32 of 36 mutants on the money
and security paths killed. One blocker, introduced by the decision 33 fix, and nits:

- **Blocker:** the `unsignedUntil` clamp let a repeat that lost the claim end the winner's
  unsigned record while the winner's budget still ran (decision 46). His probe (budget 60 ms, the
  losing call's check 40 ms, the winner 20 ms later, a late reservation) gave
  `["onFinal", "reserved"]`. Fixed as he suggested; the probe is a test, scaled to 150/100/50 ms
  for a loaded runner, plus one for a winner that gets a channel after the loser's budget. The
  cross-instance case is in 0024.
- **README:** `unexpected_settle_error` and `…_unexpected_balance_changes` can carry an earlier
  hash after a rebuild; the note under the table no longer says the stored hash was sent
  (decision 35's hash never was). `settlement_pending` with no hash also means "not signed yet".
- **Nits:** the decision index lives only in `S-design-decisions.md` (README 187 → 151 lines);
  the facilitator baseline is 103 (0018's end), not 74; the PR body lists the depth cap
  (decision 39) as a `/verify` change too.
- **Non-blocking, to 0049:** `FallbackRpc.call` wraps every all-endpoints failure, JSON-RPC error
  answers included.

Facilitator tests 205 → 207. Mutants caught, each by both new tests: no "first call's budget not
over" return (the old code), and no `Math.min(…, ownEnd)` clamp.

**Modified tests:** none.

## Fifth review (Stan, 2026-10-20, at `53495bb`)

Stan reviewed the Platform points of "Please confirm" (7, 10, 17, 18, 25, 27, 28, 38, 40, 41, 43,
44) and found them fine: the budget and timeout settings, the pubnet + `STORE=memory` refusal,
`settlement_outcomes_total{reason, replay}` and alerting on `stage="pool"` only, which he takes
into 0027. He didn't review the core of `/settle`. Two non-blocking questions:

- **The test-helper lint rule missed relative imports** (`eslint.config.js`): a package's own
  `export * from "./testing.js"` passed. The rule now also refuses `**/testing` and
  `**/testing.js`; two probe files (`./testing.js`, `../testing`) failed lint, `testing.ts` itself
  passes.
- **Hosts still reached the logs** (`logger.ts`), against ADR 0011's "never by host". okarcz chose
  to name them (decision 47): an `RPC_URLS` entry in an error message is logged as
  `RPC_URLS[i]#<fingerprint>`, other URLs keep their host. Where `RPC_URLS` lives on Hetzner, and
  its old values with it, went to 0026.

Facilitator tests 207 → 209.

**Modified tests:** none.

## Rebase onto develop after 0022 merged (2026-10-20)

Develop was 85 commits ahead, with 0022's PostgreSQL adapters (PR #30), 0013's archive and 0028.
Conflicts and how each went:

- **`main.ts`**: develop's `main()` builds PostgreSQL pools or the memory stores and closes once.
  `compose()` now takes the `stores` (memory when absent), and `main()` keeps develop's pools,
  `migrateMain` and idempotent `close()` around this PR's `compose()`. Every commit was rebuilt
  this way, so each one typechecks.
- **The `SettlementStore` port**: develop's precedence list for `addHash` (with
  `HashConflictError`) and this PR's atomicity sentence, both kept. The PostgreSQL adapter gained
  `markSuccessAnswered` in the rebased copy of the commit that added it to the port (decision 48).
- **`main()`'s pubnet refusal** never ran: 0022's config refuses first (decision 18).
- **Task files**: 0009's file became this directory, and develop's "From 0022" bullet moved into
  Future Work; 0022 and 0013 had closed, so this PR's bullets for them were dropped and their
  open points moved to 0019 and 0023 (README Future Work); 0020, 0023 and 0024 keep both sides.

Facilitator tests 209 → 305 against PostgreSQL 18 (`TEST_DATABASE_URL`; 67 in its suite).

**Modified tests:** `main.test.ts`'s pubnet test expects the config's message, `STORE must be
postgres outside testnet`.

## Testnet

`scripts/settle-smoke.ts`, friendbot keys, fresh channels.

- **After the rebase** (2026-10-14), all 5 checks passed: a real XLM-SAC payment settled,
  `SUCCESS` on chain; the same request again got the same hash; the same payload with other
  requirements got `…_nonce_already_used`; two concurrent calls for a new payment submitted one
  transaction; `/verify` of the settled payment fails.
- **After the second review** (2026-10-15), all 5 passed: the payment settled (`841e647f…`,
  `SUCCESS` on chain); the same request again got `…_already_settled` with that hash; the same
  payload with other requirements got `…_nonce_already_used` with that hash; two concurrent calls
  for a new payment submitted one transaction (`52c7e746…`), one answered `success` and the other
  `…_already_settled`; `/verify` of the settled payment fails.
- **After the third review** (2026-10-16, on the code of this commit before it was committed,
  fresh friendbot keys): the first run stopped at the first `/settle`, a 500 from
  `UpstreamTimeoutError`: the testnet RPC didn't answer upstream verify within 10 s, and this
  branch has one RPC URL and no failover (#45). The second run passed all 5: the payment settled
  (`2553afad…`, `SUCCESS` on chain); the same request again got `…_already_settled` with that
  hash; the same payload with other requirements got `…_nonce_already_used` with that hash; two
  concurrent calls submitted one transaction (`3fd2b0a4…`), one `success` and one
  `…_already_settled`; `/verify` of the settled payment fails (`…_simulation_failed`).
- **After the fourth review** (2026-10-16, on the pushed head `accb133`, fresh friendbot keys):
  all 5 passed on the first run: the payment settled (`ecfabb9c…`, `SUCCESS` on chain); the same
  request again got `…_already_settled` with that hash; the same payload with other requirements
  got `…_nonce_already_used` with that hash; two concurrent calls submitted one transaction
  (`7c3409f2…`), one `success` and one `…_already_settled`; `/verify` of the settled payment
  fails (`…_simulation_failed`).

## Issues encountered

- **A repeat failed the checks once the payment had landed.** The first testnet run showed it:
  the payment's nonce is used on chain, so upstream's simulation fails, and the retry after
  `settlement_pending` got `invalid_exact_stellar_payload_simulation_failed` instead of the stored
  outcome. Fix: a known key is answered from its record before any check (decision 1).
- **Flaky test from time bounds.** Test transactions built with `setTimeout(60)` changed when a
  second ticked, so a repeat had another fingerprint and was correctly refused. The fixtures use
  fixed time bounds.
- **`main.test.ts`'s spawned-process test** timed out once in a full parallel run and passed
  alone and on the next full run: a loaded machine, not a code problem.
