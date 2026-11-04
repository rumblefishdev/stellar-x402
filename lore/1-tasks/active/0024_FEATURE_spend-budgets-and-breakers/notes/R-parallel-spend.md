---
title: "Parallel spend of one balance"
type: research
status: mature
tags: [facilitator, fees, budgets]
history:
  - date: "2026-10-29"
    status: mature
    who: akot
    note: "Research for the 0024 design (agent report, read only)."
---

# 0024 gray area B: fee griefing by spending one balance in parallel

Read-only research, 2026-10-29. Repo at `d264c60` (branch `lore-0066-archived-state-restore-fee`).

## What the code does today (grounding)

- **Nothing sees an in-flight payment.** Upstream `@x402/stellar` 2.28.0 `_verify`
  (`dist/esm/exact/facilitator/index.mjs` ~L265-420) has no balance check of its own: the balance
  is checked only because `simulateTransaction` of `transfer` fails when it is short
  (`invalid_exact_stellar_payload_simulation_failed`). The simulation runs against the latest
  ledger, so it can't see transactions that are signed but not yet included. Upstream `settle()`
  has no concurrency guard either, though it also picks between several signers. The pool
  simulates again on the channel (`expectTransfer` in `settle.ts`) and is just as blind.
- **N nonces make N keys.** The settlement key is `network:payer:nonce` (`ports/settlement-store.ts`).
  `PostgresSettlementStore.claim` is `INSERT … ON CONFLICT (key) DO NOTHING`, so N payments with
  N nonces are all claimed.
- **Order in `settle.ts`:** cached `get` → `check` (upstream simulation) → `claim` →
  `beforeSubmit` → `submit` (pool simulation, `onSigned` → `addHash`, send).
  When `beforeSubmit` refuses, the record moves `claimed → rejected`, so the payment is used up and
  the buyer must sign a new one. A guard placed in the hook therefore burns the buyer's payment. A
  guard that refuses before or inside `claim` leaves the same payment retryable as it is.
- **One settling process per network.** Only the channel-lease holder settles; without the lease
  `/settle` answers 503 (`settlement/lease.ts`, AD-17). Every claim therefore happens in one
  process. The exception is lease handover: the old holder drains submissions it has already sent,
  and fencing (0071) is still open.
- **Store facts:**
  - `listNonFinal(network)` exists, backed by the partial index `settlements_non_final`.
  - `payment_requirements` is jsonb holding `asset` and `amount`.
  - `SpendStore.reserve` already has the pattern a per-(payer, asset) guard needs: lock a scope
    row `FOR UPDATE` with a 2 s `lock_timeout`, sum, then insert.
  - `SpendStore` counts fee stroops in rolling windows. It does not count token amounts against a
    balance, so it is the wrong shape to reuse for (b).
- **A balance that costs no extra call:** `SimulateTransactionSuccessResponse.stateChanges`
  (stellar-sdk 16.3.0) gives `before`/`after` `LedgerEntry` for each written entry. For a SAC this
  is the payer's trustline (G) or `Balance` contract data (C), which the check's simulation
  already returns. `Verified` doesn't carry the simulation today.
- **No precedent elsewhere.** Neither upstream nor the x402 docs have a balance-aware in-flight
  guard. Solana's facilitator only deduplicates identical payloads in memory.

## Threat refinements

1. **Neither (a) nor (b) stops a payer racing itself off-facilitator.** The payer can drain its
   balance with its own `transfer` in the same ledger, or through another facilitator. That costs
   the attacker one transaction per failure, against our failure of up to 250,000 stroops. The
   per-payer budget and breaker bound it, but payers are cheap to make (sybils), so the
   asset/payTo breakers must not be trippable this way. Hence (c) is needed whatever else is
   chosen.
2. **Balance is not the only state that can run out.** A C-address smart wallet may enforce
   spending policies in `__check_auth` (allowances, session-key limits), and a wasm token may have
   stateful transfer rules. Two payments that each fit the balance can still fail jointly on
   chain. (b) can't see these; (a) can.
3. **A race in the "final" window.** tx1 lands and its record turns final between payment 2's
   simulation and its claim. With (a), the pool's re-simulation after the claim sees the
   post-tx1 state and refuses for free (an RPC lagging behind is the only gap). With (b), the
   in-flight sum must also count `success` records whose `ledger` is after the ledger the balance
   was read at, or it under-counts.

## Options

| Option | Prevents | Cost / complexity | Multi-instance correctness | False positives on legit traffic | Fit with ports |
|---|---|---|---|---|---|
| **(a1) Single-flight, refuse.** Partial UNIQUE index on `(network, payer, payment_requirements->>'asset') WHERE state IN ('claimed','signed','pending')`; the 23505 becomes a new `ClaimResult` `{claimed:false, busy}`, answered before any record exists | All same-payer parallel failures, balance and stateful auth/policies alike (C-address, wasm) | 1 migration (`CREATE UNIQUE INDEX CONCURRENTLY`, which fails if duplicate in-flight rows exist at build time), port + adapter + `settle.ts` branch, new reason. No RPC | Exact: the DB enforces it, across handover too | High for fan-out agents: a second parallel payment is refused (retryable as is, no record). About one settlement per ledger per (payer, asset) | `SettlementStore.claim` grows one result variant. Not in `SpendStore` or the hook |
| **(a2) Single-flight, queue.** As (a1), but on `busy` wait (poll as `replay` does) for the blocker to turn final, then claim again, within `SETTLE_BUDGET_MS` | Same as (a1) | (a1) plus a wait loop. Holds HTTP connections (rate limits bound them). No RPC | Same as (a1) | Low until depth exceeds the budget/ledger time (about 4-5 deep at 30 s). Then a retryable `…_payer_busy`/timeout with no record | Same, plus logic in `settle.ts` |
| **(b) Reserve in-flight amounts against balance.** In `claim`'s transaction: lock (payer, asset), sum the amounts of non-final records plus `success` after `L_bal`, admit if `sum + amount ≤ balance(L_bal)` | Same-payer balance overcommit only | Balance source per kind: the SAC from the check's `stateChanges` (free; mind trustline liabilities and native reserves); wasm needs an extra `balance()` simulation, which a malicious token can fake. Lock and sum SQL, new partial index `(network, payer)` | Correct if done in a DB transaction. An in-process version relies on the lease plus seeding from `listNonFinal` | Lowest: a funded payer keeps full parallelism; only an overcommit is refused (`insufficient_funds`-style) | `Verified` must carry the balance; `claim` takes a guard. Not `SpendStore` (wrong unit) |
| **(c) Attribute failures to the payer.** A failed SAC transfer feeds payer budget, payer breaker and all budgets, never the asset/payTo breaker; only wasm-token failures feed asset/payTo breakers. A dynamic "re-simulate after failure" classifier is rejected, because the attacker can refill the balance before the re-simulation | Turning failures into a USDC/seller-wide denial of service, including the off-facilitator front-run residue | Policy only, in `onFinal`: an asset-kind lookup (SAC check via the contract instance, cacheable) | Breaker state is in `spend_scopes`, already shared | None. It removes one: legit sellers are no longer cut off by others' races | `recordFailure(scope)` as is; the scope choice is policy |
| **(d) a2 + c, then b for G+SAC** | All of the above; b restores fan-out where balance is the only mutable state | Two admission paths (index for C/wasm, lock+sum for G+SAC) | Exact | Low | As (a) and (b) |

## Recommendation

- **Ship (a2) + (c) in 0024.**
  - (a2): single-flight per (network, payer, asset), enforced by a partial unique index inside
    `claim`, with a bounded wait-and-retry within the settle budget. Past the budget the answer is
    a retryable reason with no record (e.g. `settle_exact_stellar_payer_busy`, message "another
    payment from this payer in this asset is settling; send the same payment again").
  - (c): SAC failures feed only payer scopes, and only wasm failures can open the asset and
    payTo breakers.
- **Why this pair:**
  - It is the only mechanism that also covers stateful C-address wallets and wasm tokens, and it
    adds no RPC.
  - It stays correct across instances and lease handover because the DB enforces it.
  - The pool's post-claim re-simulation closes the "final" window for free.
  - (c) is needed regardless, because neither (a) nor (b) stops off-facilitator front-running
    from sybil payers.
- **Rec (b) for G-address payers on SAC assets (`stateChanges` balance) as a follow-up if
  measured fan-out matters.** Measured fan-out means agents paying many sellers in parallel from
  one USDC balance hitting `payer_busy`. It is the one place where balance is the only mutable
  state and is trustworthy to read.
- **Rec (a1) instead of (a2)** if holding connections is unwanted. The refusal is retryable and
  burns nothing.
- **Do not put the guard in `beforeSubmit`:** a refusal there rejects the record and burns the
  buyer's payment.
