---
title: "Codebase map for 0024"
type: research
status: mature
tags: [facilitator, fees, budgets]
history:
  - date: "2026-10-29"
    status: mature
    who: akot
    note: "Research for the 0024 design (agent report, read only)."
---

# 0024 Spend budgets and circuit breakers: codebase map

Read-only research at branch `lore-0066-archived-state-restore-fee` (merged with develop at d264c60).
Paths are relative to the repository root. "F" = `apps/facilitator`.

## 0. Headline findings

1. **There is no in-memory store any more.** 0064 (commit 813460d, "drop the memory store and STORE")
   deleted `F/src/adapters/memory.ts`. The only `SpendStore` is `PostgresSpendStore`
   (`F/src/adapters/postgres.ts:533`). Every settle test runs against a real PostgreSQL schema per
   file (`F/test/database.ts:33`, `testDatabase()`; `TEST_DATABASE_URL` or compose's
   `127.0.0.1:15432`). The task's "tests with the in-memory store" is stale: either test against
   PostgreSQL (the house style) or write a small fake `SpendStore` for policy unit tests.
2. **A `beforeSubmit` that throws (e.g. `55P03`) is not a 500 today.** It becomes a refusal with
   `settle_exact_stellar_refused`, the record moves `claimed → rejected`, `onFinal` is NOT called
   (`F/src/settlement/settle.ts:750-766`). The task's "answer it with 503 + retry, a retry with the
   same id is safe" is not reachable with the current hook contract: `BeforeSubmitResult` has only
   `allow` / `allow:false + errorReason` (`F/src/settlement/hooks.ts:23-32`), and a claimed record
   can never be re-run (0009 decision 2: no reopen operation). A "retry" always means a new payment
   (new nonce, new key, new reservation id).
3. **A reserve whose COMMIT answer was lost leaks.** If `reserve` rejects after its COMMIT actually
   landed, the hook throws → refused → no `onFinal` → the reservation stays counted until it leaves
   the window (and is pruned after `max(2×window, 7 d)`). The hook must release best-effort itself.
4. **On-chain failures can't be told apart.** Every included-but-failed tx becomes
   `state: "failed"`, `errorReason: settle_exact_stellar_transaction_failed`. The pool's `errorCode`
   is transaction-level (inner `txFailed` for a Soroban op failure), never the
   `InvokeHostFunctionResultCode` (trapped / resourceLimitExceeded / entryArchived /
   insufficientRefundableFee) and never diagnostic events; and for `failed` it is dropped before the
   store (`F/src/settlement/records.ts:189-191`), and not on `SettlementRecord` at all. So a
   balance race, an auth failure and a token trap look identical to `onFinal`.
5. **Asset kind (SAC vs wasm) is known nowhere** in `F/src` or `packages/*/src` (grep for
   `StellarAsset`/`SAC` finds only docs/comments). The hook has no RPC handle.
6. **Breaker counter semantics in the adapter:** `recordFailure(scope, now)` ignores `now`
   (`postgres.ts:632` takes only `scope`); the count is consecutive with no time decay, reset only
   by `recordSuccess`. `openBreaker` doesn't reset `failures`, so after the cooldown the next single
   failure re-opens it at once unless the policy resets (implicit half-open).
7. **Only the lease holder settles** (0025, `F/src/http/app.ts:140-147`, `settle.ts` `held()` check
   in `onSigned`). So a per-(payer, asset) single-flight guard could live in process memory, except
   across a lease hand-over (fencing is 0071, still open).
8. **`/verify` never consults budgets or breakers.** A payment over budget or behind an open breaker
   passes `/verify`, the seller serves, and `/settle` refuses: work given away (the same argument
   that made `RATE_LIMIT_SETTLE >= RATE_LIMIT_VERIFY`, `F/src/config.ts:251-256`).

## 1. What the hooks receive and return

### `BeforeSubmitContext` (`F/src/settlement/hooks.ts:7-21`)

| Field | Source at call site (`settle.ts:737-748`) | Notes |
|---|---|---|
| `key: SettlementKey` | `` `${network}:${payer}:${nonce}` `` (`settle.ts:691`) | the reservation id (port: "The settlement key; one reservation per settlement", `spend-store.ts:19`) |
| `network` | `deps.network` | |
| `payer` | `verified.payer` = the `transfer`'s `from` (G or **C** address) | port comment says `payer:<G…>` (`spend-store.ts:3`), but C-address payers exist |
| `payTo` | `requirements.payTo` | may be G or C |
| `asset` | `requirements.asset` (token contract `C…`) | |
| `amount: bigint` | `BigInt(requirements.amount)` | token base units; `"0"` passes the HTTP schema (`app.ts:105`, digits only) |
| `maxFeeStroops: bigint` | `deps.maxFeeStroops` = `config.fees.maxFeeStroops` (`main.ts:434`), default 250 000 | the only fee number available pre-submit |
| `paymentPayload`, `paymentRequirements` | raw | the client's tx XDR (with its own `sorobanData`/footprint) can be parsed from here |
| `now` | `now()` at the call | |

Not passed: the `Verified` object (`verify.ts:114-123`: `transaction`, `nonce`, `expirationLedger`,
`currentLedger`), the simulated fee of `/settle`'s check, the pool's own simulation (it happens inside
`submitter.submit`, after the hook), the asset kind.

Fee available before submit: only the ceiling. The pool's simulated fee is known only after the hook.
So a reservation must be at `maxFeeStroops` (or a hook-side estimate from the client's
`sorobanData.resourceFee` + bids, which is client-controlled).

### `BeforeSubmitResult` (`hooks.ts:23-32`)

`{ allow: true }` or `{ allow: false; errorReason: string }`. Refusal → record `claimed → rejected`
with that `errorReason` via `advance` (not `finish`), so **no `onFinal`** (`settle.ts:755-766`). If
the refusal write fails, the record stays `claimed`; later a repeat past the first call's budget
(`endUnsigned`, `settle.ts:302-325, 627-652`) or reconciliation's `interrupted` close
(`reconcile.ts:177-193`, after `createdAt + budgetMs + MARGIN_MS(5 s)`) finalizes it and runs
`onFinal` for a reservation that was never made.

### `SettlementRecord` (`F/src/ports/settlement-store.ts:22-51`)

`key, network, payer, nonce, fingerprint, state, hashes[], paymentPayload, paymentRequirements,
channel?, ledger?, feeCharged?: bigint, errorReason?, successAnsweredAt?, version, createdAt,
updatedAt`. No `payTo`/`asset` columns: read them from `record.paymentRequirements.payTo/.asset`.
No result code, no attempt list (attempts are a separate `store.attempts(key)` call; their
`errorCode` is set only for `rejected`/`expired` and `txBadSeq` rebuilds).

### Final states and fee by path

`FINAL_SETTLEMENT_STATES = success | failed | rejected | expired` (`settlement-store.ts:12-17`).

| Final record | Who writes | `feeCharged` | `errorReason` | Fee paid? |
|---|---|---|---|---|
| `success` | settle `finish` (`settle.ts:500`), reconcile `land`/`resolved` (`reconcile.ts:61-82, 293-312`) | set (`resultXdr.feeCharged()`) | – | yes |
| `failed` | same | set | `settle_exact_stellar_transaction_failed` | yes |
| `rejected` (network refused before inclusion) | settle default branch (`settle.ts:508-513`) | undefined | `…_transaction_submission_failed` | no |
| `rejected` (pool threw a classified error: simulation, fee, no channel, ledger bound, record write, shutdown, rpc unavailable, unsupported credential, unexpected without a send) | `settle.ts:458-490` via `reasonFor` (`settle.ts:857-870`) | undefined | the mapped reason | no |
| `rejected` `…_timeout` | `endUnsigned` (budget or repeat) | undefined | `settle_exact_stellar_timeout` | no |
| `rejected` `…_interrupted` | reconciliation of a hashless claim | undefined | `settle_exact_stellar_interrupted` | no |
| `rejected` hook refusal | settle, **no `onFinal`** | – | hook's reason / `…_refused` | no |
| `expired` | settle or reconcile sweep (`reconcile.ts:227-230`) | undefined | `…_transaction_expired` | no |

`feeCharged` is the fee-bump envelope's total (`submitter.ts:856`, `reconcile.ts:73`), i.e. what
the facilitator actually paid. Rule for `onFinal`: `feeCharged !== undefined` → `commit(key, fee)`,
else `release(key)`.

### `SettlementOrigin` (`hooks.ts:35`)

`"settle"` (finalized inline in `/settle`) or `"resolved"` (pool `resolved` event, reconciliation
sweep, lost-hook rerun `reconcile.ts:126-139`, or a submission that finished after the budget answer:
`call.origin` flips to `resolved` in `outOfBudget`, `settle.ts:716-719`). It doesn't say anything
about fee or failure kind.

### `onFinal` contract (`hooks.ts:52-60`, `records.ts:50-61`)

Fire-and-forget: `runHook` catches sync and async errors, logs `settlement_hook_failed`
`{hook, network, settlementKey, error}` and counts `settlement_hook_failures_total{hook}`
(`records.ts:39-42`). `/settle` doesn't await it. Runs once for the writer that made the record final
(`records.ts:127-136`). After a crash a lost `onFinal` is only recovered for keys in the in-process
`unconfirmed` set (a final write that threw); a restart forgets them (`records.ts:96-103`) — the
task's "acceptable for T1" bullet.

## 2. Wiring today, and how settle calls the hooks

- `compose()` (`F/src/main.ts:454`) wires no-op spend hooks (`main.ts:493-499`):
  `beforeSubmit: async () => ({ allow: true })`, `onFinal: async () => {}`, `onSuccess:
  cataloger.onSuccess`, with the comment "Spend budgets plug in here with 0024". `stores.spend`
  (a `PostgresSpendStore` on the `reserve` pool) is already in `opts.stores` there.
- `buildSettlement` (`main.ts:359`) passes the same hooks to `createRecords` (`main.ts:382`, shared
  with the reconciler, so reconciliation's `onFinal` goes through the same object) and to
  `createSettler` (`main.ts:431`).
- `F/test/settle-pool.test.ts:142-144` also wires no-op hooks.
- Pools: `main` (10), `reserve` (3), `rateLimits` (3), `discovery` (3) (`main.ts:557-561`).

### Order inside `settle()` (`settle.ts:657-799`)

known-key lookup → `deps.check` bounded by `left()` → claim (bounded by `max(left(), storeGraceMs)`)
→ `beforeSubmit` bounded by `left()` → `left() <= 0` check → `submit()`.

### Timeouts (0009 decisions 20, 21, 34, 46)

- `bounded(hook, left())` (`settle.ts:749, 828-841`); `left()` = `SETTLE_BUDGET_MS` (default
  30 000, `config.ts:174`) minus time since the call started (checks and claim included).
- On `OutOfTimeError` → `outOfBudget(hook)` (`settle.ts:751, 716-729`): `budgetOver = true`, origin
  `resolved`, `endUnsigned(key, hook)` moves `claimed → rejected …_timeout` and runs `onFinal` only
  after the hook's promise settles (`settle.ts:313-316`, decision 34). The hook isn't cancelled.
- A repeat in the same process never ends an unsigned record before the first call's budget
  (`createdAt + budgetMs`, `settle.ts:616, 627-638`, decision 46). Across instances, a repeat
  judges `firstEnd` by its own clock and may run `onFinal` (release) before the first instance's
  late `reserve` lands → reservation counted forever (until window). Task bullet: refuse a reserve
  after its release.
- Throw/reject (not a timeout) → `hookFailed("beforeSubmit", …)` + refusal
  `settle_exact_stellar_refused` (`settle.ts:752-753`). **Never a 500.** The route answers 200 with
  `success: false` (`app.ts:171-172` comments: only throws from `settle` are 500).

## 3. On-chain failure classification

- Pool: `SubmitResult { status, hash, channel, ledger?, feeCharged?, errorCode?, attempts }`
  (`packages/signer-pool/src/types.ts:68-83`). `errorCode` = `resultCode(resultXdr)`
  (`submitter.ts:900-911`): outer tx result switch name, or the inner one for a fee bump. For a
  Soroban failure that is `txFailed`; the operation result (`InvokeHostFunctionResultCode`) is not
  read; `resultMetaXdr` / diagnostic events are not read.
- `status: "failed"` → `errorReason = SETTLE_REASONS.failed` (`settle.ts:58, 508-513`); the
  attempt is marked `landed` with **no** `errorCode` (`records.ts:189-191`). Reconciliation's
  `land` (`reconcile.ts:61-82`) also only sets `failed`.
- Distinguishable today: fee-free pre-chain refusals by reason (`…_simulation_failed`,
  `…_unexpected_balance_changes`, `…_fee_exceeds_maximum`, `…_timeout`, `…_expired`,
  `…_submission_failed` with `txBadSeq`/`txInsufficientFee` in the attempt row). Not
  distinguishable: balance race vs auth failure (PRNG / ledger-dependent `__check_auth`) vs token
  trap vs archived-entry/resource-limit — all are `failed` + `txFailed`.
- Consequence for "balance-race failures counted against the payer, not the asset": needs new data
  (op result code at minimum; diagnostic events for a reason) through the pool → `SubmitResult` →
  record (schema change) → `onFinal`. Or a heuristic: count every `failed` against the payer scope
  too, and against asset/payTo only when the payer is not the repeat offender.
- `FakeRpc` (`packages/signer-pool/src/testing.ts`) can make every included tx fail
  (`failOnChain = true`, result `txFailed`) and sets `resourceFee` (default 40 000).

## 4. SpendStore adapter semantics (PostgreSQL only)

Schema (`F/src/adapters/postgres-schema.ts:87-108`, migration `0004_spend_window` at 129-135):
- `spend_reservations(id PK, amount bigint, at bigint, state text DEFAULT 'reserved' CHECK (state IN
  ('reserved','committed')))`, index on `at`. Comment: a status, "so refusing a reserve after its
  release (0024) can add 'released'" — that needs a migration changing the CHECK; migrations must
  lock in `reserve`'s order (`postgres-schema.ts:16-20`) and stay transactional (online runner is
  0080).
- `spend_reservation_scopes(scope, id FK ON DELETE CASCADE, at, amount)`, PK `(scope,id)`, window
  index `(scope, at) INCLUDE (amount)`.
- `spend_scopes(scope PK, failures int, breaker_until bigint)`: the per-scope lock row, the breaker
  counter and the breaker end.

Operations (`postgres.ts:533-668`):
- `reserve` (546-590): one Read Committed transaction on `reservePool`; `SET LOCAL lock_timeout =
  2000ms` (`RESERVE_LOCK_TIMEOUT_MS`, 514); insert reservation `ON CONFLICT DO NOTHING` — a repeated
  id returns `{reserved:true}` without re-checking (557); upsert and `FOR UPDATE` the scope rows in
  sorted order; per-limit window sum (`WINDOW_SUM`, 523-524, `at > now - windowMs`, includes rows
  stamped after `now`); breach → `LimitExceeded` rolls back → `{reserved:false, scope}` (first
  limit in the caller's order that breaches, 572-576). Writes scope rows with `at`, `amount`.
  Rejects: `RangeError` for non-int64 amounts (`assertStroops`, `rules.ts:69-72`); pg `55P03` on
  lock wait > 2 s (test `postgres.test.ts:371-384`); pool connect timeout 5 s
  (`connectionTimeoutMillis`, `postgres.ts:87`); statement timeout 10 s, query timeout 15 s; a
  lost COMMIT answer (outcome unknown). **Every reserve locks `global`**: all reservations serialize
  on one row (by design, 0022).
- `commit` (593-604): one statement updates amount and `state='committed'` (also on an already
  committed row: "committing again replaces the fee"); resolves `false` for an unknown id
  (0022 decision 17). Keeps the reservation's `at`.
- `release` (608-611): `DELETE … WHERE id=$1 AND state='reserved'`; cascades to scope rows. Silent
  no-op for unknown or committed ids. No tombstone: a later `reserve` with the same id succeeds and
  counts again.
- `used` (614-617): window sum on the main pool, no lock.
- `prune` (623-630): `FOR UPDATE SKIP LOCKED`, oldest first, any state.
- `recordFailure` (632-640): upsert `failures + 1`, returns the count; **ignores `now`**; on the
  main pool; it will wait on a scope row a concurrent `reserve` holds `FOR UPDATE` (no lock timeout
  set). `recordSuccess` (646-651) writes only when `failures <> 0`, so it doesn't wait in the usual
  case (test `postgres.test.ts:386-395`). `openBreaker` (653-660): `GREATEST` of ends.
  `breakerOpenUntil` (662-668): `breaker_until > now`.
- Port contract tests: `F/test/port-contracts.ts:616-831` (`spendStoreContract`), run in
  `F/test/postgres.test.ts:178`.

## 5. Config (`F/src/config.ts`)

| Env | Default | Config field | Validation |
|---|---|---|---|
| `SPEND_WINDOW_MS` | 86 400 000 (24 h) | `spend.windowMs` | int ≥ 60 000 (199) |
| `SPEND_GLOBAL_STROOPS` | 5 000 000 000 (500 XLM) | `spend.globalStroops` | stroops ≥ 1, **no upper bound** (200) |
| `SPEND_PER_PAYER_STROOPS` | 50 000 000 (5 XLM) | `spend.perPayerStroops` | same (201) |
| `SPEND_PER_PAY_TO_STROOPS` | 500 000 000 (50 XLM) | `spend.perPayToStroops` | same (202) |
| `SPEND_PER_ASSET_STROOPS` | 2 000 000 000 (200 XLM) | `spend.perAssetStroops` | same (203) |
| `BREAKER_FAILURES` | 5 | `spend.breakerFailures` | int ≥ 1 (214) |
| `BREAKER_COOLDOWN_MS` | 600 000 (10 min) | `spend.breakerCooldownMs` | int ≥ 1 000 (215) |
| `MAX_FEE_STROOPS` | 250 000 | `fees.maxFeeStroops` | (142) |

- A `SPEND_*_STROOPS` above int64 parses, then every `reserve` throws `RangeError` → every
  `/settle` refused with `…_refused`. Add a `<= INT64_MAX` refine.
- At the ceiling reservation (250 000), defaults allow 200 in-flight-or-spent settlements per payer
  per day, 2 000 per payTo, 8 000 per asset, 20 000 global, before commits shrink them to the real
  fee (~30–60 k each).
- No env doc: `SPEND_*`/`BREAKER_*` are not in `F/README.md` nor `deploy/*.env.example` (only
  `config.test.ts:97-103`).
- Pubnet refusal: `config.ts:269-276`, message "stellar:pubnet is refused until spend budgets (0024)
  and the lease fencing token (0071) land"; README `F/README.md:14-15`; tests in
  `F/test/config.test.ts` and `F/test/main.test.ts`.
- `windowMs` → pruner: `main.ts:581-589` passes `spendWindowMs: config.spend.windowMs` (comment "One
  window today; with per-budget windows (0024), the longest of them"); `createPruner` keeps
  `spendHorizonMs(window) = max(2×window, 7 days)` (`F/src/pruner.ts:18, 59-64`). Test
  `F/test/main.test.ts:259-290` ("prunes the stores with the config's windows"; "A budget's window is
  never longer than SPEND_WINDOW_MS, which 0024 keeps"). Each `SpendLimit` carries its own
  `windowMs` (`spend-store.ts:7-16`), so per-budget windows need no port change, only the max into
  the pruner.

## 6. How refusals surface; logs and metrics for 0027

- `/settle` always answers 200 with an x402 body for an outcome; 500 only for a throw from `settle`
  (store before the claim, upstream verify error) (`app.ts:171-172`); 503 `no_lease`/
  `shutting_down` with `Retry-After` before reading the body (`app.ts:140-147`).
- `errorReason` is a free string in `@x402/core` (`SettleResponse.errorReason?: string`).
- README table (`F/README.md:138-160`): "a spend reason from the facilitator's limits — the
  facilitator's spend limits refused it — sign a new payment later; this one is ended" (line 154)
  and `settle_exact_stellar_refused` "the spend-limit check failed with an error of ours — sign a
  new payment, and tell us" (155). No concrete spend codes exist yet; `SETTLE_REASONS`
  (`settle.ts:54-115`) has none. Note at README 180-181: a spend refusal the store couldn't record
  becomes `…_timeout` on repeat.
- Refused-after-verify drift: `REFUSED_AFTER_VERIFY` (`settle.ts:130-135`) logs
  `settlement_refused_after_verify` + metric; spend codes are not in it.
- Logging: `Logger.{debug,info,warn,error}(event, fields)` (`F/src/logger.ts:8-13`), JSON lines,
  identifiers only. Existing events: `settled` (route, with `errorReason`, `payer`),
  `settlement_hook_failed`, `settlement_record_failed`, `settlement_resolved`, `reconcile_finished`.
- Metrics: `Metrics.increment(name, labels)` only, in-memory until 0027 (`F/src/metrics.ts:1-20`):
  "Labels come from closed sets only" — so breaker/budget metrics may carry a scope *kind*
  (`global|payer|payTo|asset`), never an address; addresses go in log lines. Existing:
  `settlement_outcomes_total{reason, replay}` (`settle.ts:803-810`) already counts spend refusals
  by `errorReason`; `settlement_hook_failures_total{hook}`; `settlement_budget_exhausted_total`.
- 0027 (`lore/1-tasks/backlog/0027_FEATURE_alerts-and-metrics.md:42`): "the budget and breaker
  events come from 0024"; backend is CloudWatch via EMF lines on stdout; logs go via the CloudWatch
  agent. So log events (+ closed-label counters) are the right output.
- `ReserveResult` doesn't return usage, so "budget nearing its limit" needs extra `used()` reads
  (one per scope) or a port change returning the sums the reserve already computed.

## 7. Test helpers

- `F/test/settle.test.ts:244-277` `setup(behaviour, overrides)`: real PostgreSQL settlement store,
  fake `Submitter` (`vi.fn`) driving `onSigned`, `vi.fn` hooks, `memoryMetrics`, `jsonLogger` into
  `lines`. `passing` check (143-162), `landing(status)` (207-212), `result(status)` with
  `feeCharged: 41_000n` (197-205). Budget/timer helpers `elapse`, `storeIdle` (226-242), fake timers.
- Hook tests already present: refusal without `onFinal` (793-809), refusal the store can't record
  (811-837), throwing hook → `…_refused` + metric (839-850), `onFinal`/`onSuccess` failure keeps the
  answer (852-865), hung hook within budget (1302-…), "runs onFinal only after a beforeSubmit past
  the budget settles, so a late reservation is released" (1381-1406, and 1580-1604 for the repeat
  case).
- `F/test/settle-pool.test.ts`: `buildSettlement` on the real pool with `FakeRpc` (`PaymentRpc`,
  48-70); can do on-chain failure (`failOnChain`) and fees (`resourceFee`).
- `F/test/settle-route.test.ts:47, 278…`: route tests with `vi.fn<Settle>()` — the "fake settle".
- `F/test/port-contracts.ts` (`spendStoreContract` 616-831), `F/test/postgres.test.ts` (lock and
  pool isolation tests 322-395), `F/test/payment.ts` (`transferPayload`), `F/test/pruner.test.ts`.
- No in-memory `SpendStore` exists; a policy unit test needs a fake or the PostgreSQL store.

## 8. Concurrency guards present

- Settlement claim: atomic insert-if-absent on `network:payer:nonce` (`settlement-store.ts:148`,
  `settle.ts:695-708`); one call per key wins; repeats replay.
- Nothing per payer, per (payer, asset) or per balance. N payments from one payer with N nonces
  are N independent keys; all may pass both simulations and reach `submitter.submit` concurrently
  (0009 third review probe). Parallelism is bounded only by channel count and the HTTP rate limit
  (per IP, `RATE_LIMIT_SETTLE` 600/min).
- In-process per-key maps only: `reads` (poll sharing, `settle.ts:557-575`), `answeredHere`,
  `unmarked`, `unconfirmed` (`records.ts`).
- Spend store: per-scope `FOR UPDATE` serializes reservations (global row always), so budget checks
  are exact under concurrency, but they don't stop N in-flight settlements from the same balance —
  they only cap them at budget/250 000.
- Lease: only one process per network settles (0025); fencing (0071) open. A per-(payer, asset)
  in-flight guard could therefore be in-memory in the lease holder, or a row in the store for
  hand-overs.

## 9. Task assumptions vs code

| Task text | Code says |
|---|---|
| "Tests with the in-memory store" | Removed in 0064 (813460d); tests run on PostgreSQL. |
| "reserve can reject … answer it on purpose, e.g. 503 with a retry … retry with the same id is safe" | Hook throws → `…_refused`, 200, record final; the same payment can't be retried; no 503 path from the hook. Needs a hook-contract change or acceptance that the client signs a new payment (reason code distinct from `…_refused`). |
| "`onFinal` … settles the reservation at the fee actually paid" | `feeCharged` is on the record for `success`/`failed` only; all other finals have none → release. Works. |
| "Breakers … fed by settlement outcomes" / "balance-race failures counted against the payer" | Outcome has no failure kind; `errorCode` for `failed` is dropped and is only `txFailed`. |
| "Limits tiered by asset kind (SAC vs wasm)" | Asset kind isn't computed anywhere; the hook has no RPC. |
| Port: `payer:<G…>`, `payTo:<G…>` | Payer and payTo may be C-addresses. |
| `recordFailure(scope, now)` | Adapter ignores `now`; no decay; no reset on open. |
| `commit` unknown id "resolves false; what the caller does is this task's" | Confirmed (`postgres.ts:593-604`, contract test `port-contracts.ts:749-757`). |
| "release deletes only reserved rows" | Confirmed; no tombstone, so a reserve after release re-counts. |
| pruner gets the longest window | Confirmed single `config.spend.windowMs` today (`main.ts:584`). |
| Hook refusal → no `onFinal` | Confirmed; a hook that reserved and then refuses (e.g. breaker after reserve) must release itself. |
