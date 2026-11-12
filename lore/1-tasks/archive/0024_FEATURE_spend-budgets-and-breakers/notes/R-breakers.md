---
title: "Circuit breakers that can't be turned against other users"
type: research
status: mature
tags: [facilitator, fees, budgets]
history:
  - date: "2026-10-29"
    status: mature
    who: akot
    note: "Research for the 0024 design (agent report, read only)."
---

# 0024 gray area C: circuit breakers that can't be turned against other users

Read-only research for task 0024 (ADR 0007, spine AD-18). Repo state: branch
`lore-0066-archived-state-restore-fee`, merged with develop at d264c60.

## 1. What exists today

| Piece | State | Where |
|---|---|---|
| Port | `recordFailure(scope, now) -> consecutive count`, `recordSuccess(scope)` resets it, `openBreaker(scope, until)` (the later end wins), `breakerOpenUntil(scope, now)` | `apps/facilitator/src/ports/spend-store.ts` |
| Postgres | One `spend_scopes` row per scope (`failures integer`, `breaker_until bigint`). `recordFailure` **ignores `now`**: a count never ages, so 5 failures spread over a month open a quiet asset's breaker | `apps/facilitator/src/adapters/postgres.ts:632-668`, `postgres-schema.ts:103-108` |
| Config | `BREAKER_FAILURES=5`, `BREAKER_COOLDOWN_MS=600000` (10 min) | `apps/facilitator/src/config.ts:213-215` |
| Wiring | `beforeSubmit` always allows; `onFinal` is a no-op ("Spend budgets plug in here with 0024") | `apps/facilitator/src/main.ts:494-498` |
| What `onFinal` gets | A `SettlementRecord`: `state` (`success, failed, rejected, expired`), a fixed `errorReason` (`settle_exact_stellar_transaction_failed`, …), `feeCharged`. **No result code and no cause.** | `ports/settlement-store.ts:22-50`, `settlement/settle.ts:54-100,498-512` |
| What the pool knows | `SubmitResult.errorCode` = the transaction-level code only (e.g. `txFailed` inside `txFeeBumpInnerFailed`). The attempt rows store it; the record does not. The operation result (`InvokeHostFunctionResultCode`) and the diagnostic events are dropped. | `packages/signer-pool/src/submitter.ts:856-866,903-912`, `src/types.ts:30-70` |

So the breaker data has not been wired yet. Attributing failures needs the pool to read one level deeper,
and a field on the record or the `onFinal` call to carry the cause.

## 2. Which failures cost us, and whose fault they are

### 2.1 Only included-and-failed transactions cost a fee

| Outcome | Pool status | Fee charged | Count for breakers? |
|---|---|---|---|
| Applied OK | `success` | yes | success signal only |
| Included, failed (`txFeeBumpInnerFailed` → `txFailed` → op `INVOKE_HOST_FUNCTION_*`) | `failed` | **yes**: the inclusion fee plus the non-refundable resource fee. The refundable fee (rent, events) is 0 on failure. | **yes, the only kind** |
| `txBadSeq` (channel sequence), `txInsufficientFee` (our bid) | `rejected` | no | no: ours, cost 0. Pool-health alert in 0027 |
| `txTooLate`, ledger or time bound passed | `expired` | no | no |
| Simulation, fee-ceiling, balance-change or ledger-bound refusal before send | `rejected` (pre-submit) | no | no |
| No answer | `pending`, then `resolved` | maybe | count when it resolves as `failed` (`origin: "resolved"`) |

"Fee too low", "ledger bounds" and "channel sequence" never reach a breaker: they cost nothing and
they are our bugs or the network's, not a payer's, asset's or seller's. They belong in 0027 alerts.

### 2.2 Classifying a `failed` transaction

The layers we can read:

1. **Operation result** (always in `resultXdr`): `InvokeHostFunctionResultCode`:
   - `TRAPPED` (-2): any host error. This covers a contract panic, `Error(Contract,#n)`,
     `Error(Auth,…)` and a failed `__check_auth`.
   - `RESOURCE_LIMIT_EXCEEDED` (-3): apply used more CPU, memory or I/O than the simulation declared.
   - `ENTRY_ARCHIVED` (-4): an entry was archived between the simulation and apply.
   - `INSUFFICIENT_REFUNDABLE_FEE` (-5): rent or events cost more than the simulation said.
2. **Diagnostic events** (`getTransaction` `diagnosticEventsXdr`): present only when the RPC
   server has `ENABLE_SOROBAN_DIAGNOSTIC_EVENTS`. They carry the `Error(type, code)`, the contract
   of the failing frame, and for the SAC its `ContractError`: 5 AuthenticationError,
   9 AllowanceError, 10 BalanceError, 11 BalanceDeauthorizedError, 13 TrustlineMissingError.
   **Third-party mainnet RPCs often leave this off, so the design needs a fallback that works
   without them.**

Who is at fault, by what can change between the simulation and apply:

| Cause | Typical signature | Fault | Who can cause it |
|---|---|---|---|
| Parallel spend of one balance (0009, 3rd review) | TRAPPED, SAC 10 on `from` | **payer** | the payer only (SAC `require_auth`s `from`) |
| C-account `__check_auth` that depends on the PRNG or the ledger (0009, 7th review) | TRAPPED, `Error(Auth,…)` or an error in the payer's contract frame; sometimes RESOURCE_LIMIT_EXCEEDED | **payer** | the payer contract's owner |
| Payer's trustline revoked or frozen by the issuer | SAC 11 on `from` | payer (issuer) | issuer |
| Seller removed or lost a trustline, or was deauthorized | SAC 13 or 11 on `to` | **payTo** | the seller or the issuer |
| A wasm token that behaves differently on chain, or a token whose cost grows with state | TRAPPED in the token frame, RESOURCE_LIMIT_EXCEEDED, INSUFFICIENT_REFUNDABLE_FEE | **asset** | the token's author, or anyone, if the token's cost depends on state they can write |
| A wasm token with no `require_auth` on `from` (unverified, 0009 6th review) | anything | asset; the "payer" is whatever address the attacker named | anyone |
| A SAC with a G payer: RESOURCE_LIMIT_EXCEEDED, INSUFFICIENT_REFUNDABLE_FEE, ENTRY_ARCHIVED | op code only | **ours** (simulation-to-apply drift, archival) | nobody on purpose; alert |
| Zero amount (`"0"`) | token-dependent | payer, or asset for wasm | payer |

Key point: **for a SAC the code is the host's, so a transfer failure is never the token's fault.**
It belongs to the payer, the seller, the issuer or us. The USDC asset breaker in the current design
counts failures that nobody behind USDC caused, and that is what lets someone turn it against
everyone else.

**Fallback without diagnostics:** count the failure against the payer; for a wasm token, also
against the asset. Never count an unknown failure against `payTo`. It is safe because the payer
scope can only hurt the attacker, and a wasm asset scope only hurts that token's users. A
popular wasm token still needs the rate guard below.

## 3. Ways to count

| Model | Turned against others | Notes |
|---|---|---|
| Consecutive count, success resets (now) | Trivial: 6 parallel spends land in one ledger, and the `onFinal` order across instances is arbitrary, so 5 failures in a row is easy. No time decay, so slow drips add up. | Good only at low volume |
| Failures in a time window (resilience4j `TIME_BASED`, Hystrix rolling 10 s) | Same exposure if failures aren't attributed | Fixes the decay bug; the port already passes `now` |
| Failure **rate** with a minimum volume (resilience4j `failureRateThreshold` 50 %, `minimumNumberOfCalls`; Hystrix `requestVolumeThreshold` 20, `errorThresholdPercentage` 50) | Strong for popular scopes: the attacker has to outnumber real successes, and each failure first passes the per-payer breaker and the budgets | Weak at low volume, but then there are few victims |
| Distinct payers per window (quorum) | Medium: Sybil payers are cheap (a G account's reserve comes back on merge; C payers are a contract instance each; a wasm token with no `require_auth` makes payers free) | Needs a failure row per payer, a new table |
| ERC-7562 reputation (`opsSeen` and `opsIncluded`, ×23/24 every hour, throttled when `seen/10 > included + 10`, banned at `+50`) | Strong: a ratio with slack and decay, and failures go to the entity at fault | GREP-040: an entity that **passes the second validation, then fails** in the bundle is banned at once (`opsSeen = 10000`). That is our case: both simulations passed. EREP-015: a paymaster isn't penalized for an account's failure. |

**A per-payer breaker: yes.** It is the only scope where one attacker can't hurt anyone else, and it
is where parallel spends and flaky C payers belong (0009). Key it `payer:<addr>` for a SAC (auth is
enforced). For a wasm token, key it by payer and asset, e.g. `payer:<addr>/<C…>` (`/` can't
appear in a StrKey, and the `payer:${string}` template type accepts it). This stops a junk token
with no `require_auth` from tripping a victim's G address for every asset. It is a backstop: the
real fix for the balance race is a single in-flight settlement per (payer, asset), which is
separate in 0024.

## 4. Threshold, cooldown, half-open, backoff, several instances

- **Prior art.** resilience4j defaults: 50 % failure rate, 100 calls minimum, 60 s open, 10
  probe calls when half-open, optional exponential `IntervalBiFunction` for the open time.
  Hystrix defaults: 20 requests in 10 s, 50 % errors, 5 s sleep window, one probe.
- **Half-open without new state.** When the breaker ends, keep a strike count. The first
  attributed failure after it closes reopens it at once, for longer (this is half-open with one
  failed probe). An attributed success, or 24 h with no open, clears the strikes. No probe slot
  to hand out across instances.
- **Backoff.** open = base × factor^strikes, with a cap. Compute it in SQL in `openBreaker`, and
  add a strike only when the breaker isn't already open: `breaker_until <= now`. Then two
  instances opening it together count once, and `GREATEST` keeps "the later end wins".
- **Several instances.** Everything goes through `spend_scopes`. The count is read and changed
  in one statement (`INSERT … ON CONFLICT … RETURNING`). Every instance runs `beforeSubmit`
  against the same row. No in-process state.

## 5. SAC and wasm tiers

| Tier | How detected | Asset breaker | Payer key | Rules |
|---|---|---|---|---|
| SAC (`ContractExecutable::StellarAsset`, from the contract instance, cacheable for good) | instance read; already known from simulation | **none**: the code is the host's | `payer:<G/C>` | Failures go to the payer, `payTo` or ours. Budgets bound the issuer and the rest. |
| wasm | anything else | yes, with a rate guard | `payer:<addr>/<asset>` | Unknown failures count against the payer and the asset. Lower budgets (Adam's tiered limits idea; a separate gray area). |

A self-issued SAC whose issuer toggles authorization only hurts that issuer's asset. Its failures
show up as 11 or 13 against `payer` or `payTo`, so a SAC never needs an asset breaker. Testnet
or mainnet USDC needs no allowlist: it is a SAC, so it is protected by kind, not by name
(ADR 0007: no allowlist).

## 6. Options

| Option | Pros | Cons | Complexity | Recommendation |
|---|---|---|---|---|
| **A. As specified now**: consecutive count per asset and `payTo`, 5 failures, 10 min | Already in the port and schema, simple | Trivial to turn against others (6 parallel spends close USDC for every seller; any payer can close a victim's `payTo`). No decay. Counts failures nobody behind the scope caused. | 1 policy file, no port change. Risk: denial of service for every user of an asset or seller | Only if testnet stays closed to the public; not for the public gate or mainnet |
| **B. Attributed and tiered**: count only charged `failed`; put each one on the scope at fault (payer, `payTo`, wasm asset); a window plus strikes with backoff; no SAC asset breaker | An outsider can only trip their own payer scope. Stops parallel spend and flaky C payers. Fits the AD-18 scopes. | Needs the operation result code and the diagnostic events from the pool; without diagnostics, falls back to payer plus wasm asset | Pool `resultCode` returns the op code, error and frame; a `failure` field on the record or `onFinal`; `spend_scopes` gets a window start and strikes; `openBreaker` computes the end. Risk: a wrong classification puts a fault on the wrong scope | Rec for the public testnet gate and mainnet |
| **C. Unattributed, with a quorum of distinct payers and a minimum failure rate** | Needs no classification; resists one payer | Sybil payers are cheap (a reclaimable reserve, C instances, a wasm token with no `require_auth`); a seller is still exposed | New `spend_failures` table (scope, at, payer); counting successes changes `recordSuccess`. Risk: pruning, write volume | Only if result codes can't be read from the pool |
| **D. ERC-7562 reputation**: decaying `seen` and `included` per scope; throttled, then banned with slack | Ratio plus slack protects popular scopes; prior art for one party sponsoring fees | Throttling needs concurrency per scope (lease-like); tuning; still needs attribution to be fair | Two decaying counters per scope; replaces `recordFailure` and `recordSuccess`. Risk: concurrency limiting across instances | As B's asset-scope guard only (take the ratio rule, not the full state machine) |
| **E. No failure breakers; budgets only, plus a budget for failed fees** | Nothing to turn against others beyond the budgets themselves; least code | No fast stop for a token that fails every time; the budgets are themselves keyed by asset and `payTo` | Drop four port methods. Risk: a broken wasm token burns its whole budget | If 0024 has to shrink; pair it with tiered wasm budgets |

## 7. Recommendation (B, with D's ratio on the asset scope)

**Count:** only records that end `failed` with `feeCharged > 0`, from either origin. `rejected`,
`expired`, refusals before submit and timeouts go to 0027 alerts.

**Attribute** (the pool decodes the op code plus `Error(type,code)` and the failing frame's contract
when diagnostics are present):
- `Error(Auth,…)`, the payer contract's frame, SAC 5, 9 or 10, or SAC 11 or 13 on `from` → payer
- SAC 11 or 13 on `to` → `payTo`
- the wasm token's frame, RESOURCE_LIMIT_EXCEEDED, INSUFFICIENT_REFUNDABLE_FEE → asset and payer (wasm)
- a SAC with a G payer, RESOURCE_LIMIT_EXCEEDED, INSUFFICIENT_REFUNDABLE_FEE or ENTRY_ARCHIVED → ours: an alert, no breaker
- unknown → payer, plus the asset if wasm; never `payTo`

**Default numbers** (config):

| Scope | Opens at | Window | First open | Backoff | Cap |
|---|---|---|---|---|---|
| payer (`payer:<addr>`, or `payer:<addr>/<asset>` for wasm) | 3 attributed failures; **1** if it is an auth failure in a C-account frame (ERC-7562 GREP-040: failed after passing validation) | 1 h | 1 h | ×4 | 24 h |
| `payTo` (attributed only) | 3 | 1 h | 1 h | ×4 | 24 h |
| asset (wasm only) | ≥5 attributed failures **and** failures ≥ successes for that asset in the window | 10 min | 10 min (the task's value) | ×2 | 6 h |
| asset (SAC) | none | — | — | — | — |

Strikes reset after 24 h with no open, or on an attributed success in that scope (for the asset
scope, any success). The first attributed failure after a breaker closes reopens it at the next step.

**Port changes (small):**
- `recordFailure(scope, now, windowMs)` counts within a window (column `failures_since`). Today
  `now` is ignored.
- `recordSuccess(scope, now, windowMs)` adds to `successes` in the window instead of resetting
  (asset ratio).
- `openBreaker(scope, now, baseMs, factor, maxMs): Promise<number>` computes the end from `strikes`
  in one statement, and adds a strike only if the breaker isn't already open.
- `SettlementRecord` (or the `onFinal` call) gains `failure?: { opCode; error?; frame? }`. The
  pool's `resultCode` also reads the operation result.
- The scope string `payer:<addr>/<asset>` fits the existing template type.

**Residual:** Sybil payers each get 3 failures before their breaker opens; the global and
per-asset budgets bound the total (a separate gray area). The single in-flight settlement per
(payer, asset) removes the parallel-spend class at its source.

## Sources

- ERC-7562 reputation rules: https://eips.ethereum.org/EIPS/eip-7562
- Stellar fees: failed transactions pay inclusion and non-refundable fees; the refundable fee is 0:
  https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering,
  https://developers.stellar.org/docs/data/analytics/hubble/data-catalog/data-dictionary/bronze/history-transactions
- `getTransaction` `diagnosticEventsXdr` only with `ENABLE_SOROBAN_DIAGNOSTIC_EVENTS`:
  https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction
- SAC `ContractError` codes: https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/builtin_contracts/contract_error.rs
- Launchtube (legacy, superseded by OZ Channels): per-token credit budget in stroops, no
  per-contract breakers: https://github.com/stellar/launchtube
- resilience4j and Hystrix defaults: from their documentation (from memory, not fetched this session).
