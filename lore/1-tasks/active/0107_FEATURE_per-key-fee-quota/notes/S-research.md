---
title: "0107 research: what it found and what it means for the design"
type: synthesis
status: mature
spawns: [notes/S-design.md]
tags: [facilitator, fees, budgets, api-keys]
history:
  - date: "2026-11-23"
    status: mature
    who: akot
    note: "Synthesis of the five research notes, input to the design."
---

# 0107 research: what it found and what it means for the design

Five notes, cited by letter below:

- **A** R-codebase-map: the code as it was before the build (removed once the build had used it; it is in this branch's history)
- **B** [R-fee-numbers](R-fee-numbers.md): pubnet measurements
- **C** [R-prior-art](R-prior-art.md): other facilitators and APIs
- **D** [R-prices-api](R-prices-api.md): stellar-prices-api
- **E** [R-threats](R-threats.md): the threat model per option

## What the code allows (A)

- **Adding an owner scope needs no rebuild.** The budgets are one function, `spendLimits`
  (`limits.ts:50-71`), and one store call, `reserve` (`policy.ts:202-215`). An owner scope is
  another entry in that list.
- **`beforeSubmit` already gets `ctx.caller.owner` and ignores it.**
- **`onFinal` needs no change.** It commits or releases by reservation id, and the store updates
  every scope row of that id.
- **The store sums stroops only.** A count of settlements needs a `count(*)` beside the window
  sum. That is no schema change: released reservations lose their scope rows, so the count is
  "reserved or included", failed ones included.
- **Each limit already carries its own window** (`SpendLimit.windowMs`), but the policy passes one
  value to all, and the pruner and the nearing log assume one window. A calendar month works with
  the adapter as it is (`windowMs = now − start of the month`). The pruner must then keep rows for
  about 62 days.
- **Nothing reads per-owner settings today.** The registry answers only `ownerOf`. A raised limit
  needs config or a new table.
- **A spend-limit refusal never reopens**, and `/verify` checks no budget.
- **No code recognises a payment that creates `payTo`'s balance**: it fails only on the fee ceiling.
- **The one cost not measured:** a scope whose window is a month sums a month of rows on every
  reserve, under `global`'s lock with a 2 s lock timeout. For one free account that is at most
  1,000 rows. For an account with a large raised limit it can be far more.

## What the numbers say (B)

- **A typical pubnet settlement is charged 12,203 stroops**, about $0.00016 at $0.128 per XLM.
  That is from 131 real x402-shaped USDC payments, measured 2026-11-23.
- **Two figures in our own docs are out of date:**
  - ADR 0013's "41,200 a typical settlement" comes from testnet's `upto` proxy era. At 12,203 the
    100 XLM float covers about 82,000 settlements, not 24,000.
  - 0108's "$0.69 per XLM" is now $0.128. CDP's $0.001 is then 6.4 typical settlements' fee, not
    about one.
- **The worst settlement allowed costs the ceiling, 250,000 stroops (0.025 XLM).** An attacker
  reaches it with an expensive C-address wallet, at no cost to itself.
- **A fresh C-address `payTo` balance has a fee field of about 443,000 and is charged about
  382,000.** At ten times the rent it would cost about 4.3 million. Pubnet's state was 1.645 GB on
  2026-11-23; the rent rate leaves its floor at 2.0 GB.
- **Proposed values, all config:**
  - quota `Q` = 1,000 settlements a month;
  - fee budget `B_key` = 50,000,000 stroops (5 XLM) a month, 4 × the typical cost of `Q`. An
    account at the ceiling stops after 200 settlements, and 1,000 typical ones still fit at ten
    times the rent.
  - shared free budget `B_free` = 25 XLM per 24 h. With `global` at 50 XLM that leaves 25 XLM a day
    for raised accounts, and it carries about 614 free accounts at full quota. Formulas in B §5.

## What others do (C, D)

- **CDP counts only settlements that return 2xx;** verify and failed settles are free. Our task
  counts a failed included settlement too, as OpenZeppelin's Channels does. We pay its fee, so
  that is the right choice for a fee budget.
- **The month:** most free monthly allowances reset on the 1st (Anthropic at 00:00 UTC, Google,
  Mapbox, CDP Node). Prices does the same, in its own `Period` code. OpenZeppelin's 24 h window
  starts at a key's first transaction, which is harder to explain.
- **At the limit everyone stops hard** where no payment method exists (OpenZeppelin, Infura,
  Helius, Anthropic, Prices). A higher limit is granted by hand.
- **Every paymaster pairs a per-user cap with a global one,** and has a distinct error for each.
- **The x402 spec has no code for a quota or a key;** the reason is ours to name.
- **What the refusal says:**
  - OpenZeppelin gives `consumed`, `limit`, `remaining`.
  - Anthropic names the date access returns.
  - Prices can't say anything, because AWS answers for it.
- **Prices counts per key, in AWS, with no counter of its own.** Its rule that a revoked key's
  replacement waits for the next month exists only because a new key would start a new count. We
  count by owner, so that loophole doesn't arise here.
- **Prices has no near-limit warning, no per-key alarm and no ban.** Its hub `account` call
  returns `details.usage` (`used`, `remaining`, `limit`, `period_start`, `period_end`, `resets_at`,
  `as_of`, `plan`), which the hub's components show.

## What the threat model says (E)

- **Counting keyed settlements by owner, in a shared free budget and `global`, closes "Shared
  budget exhaustion" for every account the operator raised.**
- **The free tier itself stays Sybil-able:**
  - 5 Discord accounts at the ceiling refuse free accounts for a day;
  - about 150 accounts do it for a month.
  - The free budget bounds the rate (25 XLM a day), not the sum, so the float alarms and top-ups
    remain the bound on the total.
- **"Targeted `payTo` budget exhaustion" is closed only if no budget below `B_free` is shared by
  callers.** Either the `payTo` budget is kept per caller, or keyed traffic has no `payer:` or
  `payTo:` budget at all.
- **A count-only quota is five times weaker than count plus fee budget:** one account could spend
  25 XLM a month instead of 5.
- **A ban adds little against a Sybil.** A per-owner limit of 0 in the registry would be one,
  without a new state.
- **A reopened settlement is paid by whoever sends it again**, and no account pays for another's.

## Inputs to the design, by decision

1. **`payer:` and `payTo:` for keyed traffic:** keeping them shared leaves the `payTo` attack open
   (E §2). Per caller or none closes it; none is the smaller change.
2. **Unit:** count for the seller, fee budget as the bound (E §1, C).
3. **Month:** calendar month UTC matches 0106 decision 24, Prices and most providers (C, D). The
   burst at the month's edge is bounded by `B_free` per 24 h.
4. **A new `payTo` balance:** paying it means reserving the simulated fee instead of the ceiling,
   against 0024's design. Keeping the refusal costs C-address sellers one step. The refusal can
   say so cheaply when `payTo` is a C-address (A §7).
5. **Ban and lock:** a limit of 0 kept by owner covers the one-account case. The lock is needed
   only for a ban state the portal reads.
6. **Where limits live:**
   - Config needs a facilitator restart per raise, with its drain.
   - A table needs a migration and an operator command (beside `pnpm keys`). It is also where 0108
     would keep an account's paid state.
7. **Reopen:** whoever reopens pays; nothing to build, a test and a sentence in the docs.
8. **What a seller sees:**
   - reasons of our own for the account's quota, the account's fee budget and the free budget;
   - `spend_budget_nearing` for the free budget, with an alarm, as for `global` today;
   - account-level events as log lines only.

## Candidates to leave out of 0107

Each is safe to defer, since none closes or opens an attack. Each costs something:

- **The account's use in the hub's tab** (`details.usage`, and the hub's side in its own repo).
  Cost: until then a seller learns its quota is spent from the refusal.
- **A quota check at `/verify`.** Cost: a seller past its quota serves one response that `/settle`
  then refuses.
- **The refusal's hint for a new `payTo` balance, and paying for it.** Cost: a C-address seller
  sees only "fee exceeds maximum" for its first payment.
- **A counter table instead of summing a month of rows.** Cost: none if a test on PostgreSQL shows
  the sum is fast enough at the raised limits we expect; to measure in the plan.
