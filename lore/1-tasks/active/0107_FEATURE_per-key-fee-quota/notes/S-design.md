---
title: "0107 design: a monthly quota and fee budget per account, as in Prices"
type: synthesis
status: mature
spawned_from: notes/S-research.md
spawns: []
tags: [facilitator, fees, budgets, api-keys, portal, hub]
history:
  - date: "2026-11-23"
    status: developing
    who: akot
    note: "Decisions 1-13 made by akot in the design session; Claude's calls (14-25) wait for his check. Builder check done: its two findings changed decisions 2, 3 and 5."
---

# 0107 design: a monthly quota and fee budget per account, as in Prices

Research: [S-research](S-research.md) and the R- notes it cites. The task's decisions are numbered
as in the README's "Design Decisions".

## Intent

On pubnet a seller calls `/verify` and `/settle` with an API key, one per Discord account (0105,
0106), but the spend policy ignores whose key it is. One key with free payer addresses can still
fill `asset:USDC` and refuse USDC for every seller (0024's "Shared budget exhaustion by Sybil
self-payments"). That is why `config.ts` refuses pubnet until 0107.

0107 counts every keyed settlement against its account, as stellar-prices-api counts a key's
requests (akot: "very similar to prices-api"). An account gets a plan with a monthly quota of
payments, sees its use in the hub's x402 tab, and is refused when the quota is spent. Accounts on
the free plan share one budget, so many Discord accounts can use up the free traffic but not the
room of accounts the operator raised.

## Goals

1. Close "Shared budget exhaustion" and "Targeted `payTo` budget exhaustion" for keyed traffic on
   pubnet. Raised accounts keep settling while free accounts are refused.
2. Bound what one account can cost us in a day, whatever its payments cost, so no account can
   take another's room in `global`.
3. Give the seller Prices' model: a named plan, payments per calendar month, a hard stop, and the
   use shown in the hub.
4. Keep the loss bounded the way it is today: reserve the ceiling, commit the fee charged, fail
   closed.

## Non-goals

- Charging past the quota (0108). Until then the operator changes an account's plan by hand,
  after the seller writes to us.
- Serving pubnet: one process for both networks is 0126; nothing reads pubnet keys before it.
- A ban, a check at `/verify`, alarms or metrics per account (decisions 7, 10, 11).
- Changing testnet: it stays keyless, with 0024's budgets and accepted residual.

## Anti-goals (failure even if it works)

- One account's payments, or many free accounts' together, refuse a raised account's payments.
- A key's replacement starts a new count (0106's third criterion was ticked on this).
- A budget is exceeded under concurrency, or a fee paid on chain counts in no window.
- A settlement on pubnet counts in no account.

## Constraints (from the code, R-codebase-map)

- Order in `settle()`: checks, claim, `beforeSubmit`, submit, final record, `onFinal`. A
  `beforeSubmit` refusal sends nothing, signs nothing and gets no `onFinal`.
- `beforeSubmit` gets `ctx.caller.owner` (`discord:<id>` or `operator:<name>`) on pubnet, nothing on
  testnet. The record stores no owner; `onFinal` settles a reservation by its id `<key>#<reopened>`.
- `reserve` takes one transaction. It locks every scope row in sorted order, `global` always, sums
  each limit's window, and rolls back on the first full one. The amount reserved is the ceiling
  `MAX_FEE_STROOPS`.
- The store keeps one rolling window today (24 h) and sums stroops only. The pruner keeps
  `max(2 × window, 7 days)`.
- The portal's role `x402_portal` reads only `api_keys` and `api_key_copies`.

## Approaches (akot chose A, decision 13)

- **A. Two more scopes in 0024's spend store.** Chosen.
  - `account:<owner>` is counted from the start of the UTC month and summed over 24 h; `free` is
    summed over 24 h.
  - The portal reads the account's use through a SQL view of those rows.
  - One accounting path, exactly-once as 0024 built it.
  - Cost: each reserve counts a month of the account's rows under `global`'s lock. That is at
    most 1,000 rows on the free plan. The builder check found 0050's measurement of 13 ms for a
    sum over 100,000 rows; the plan measures the count again.
- **B. A counter per (account, month)**, updated in the same transactions. O(1) reads, but a second
  accounting path that must agree with reservations through releases, late reserves and lost
  `onFinal`s, which is where 0024 spent its effort. Kept as the fallback for the account scope if
  A's sum is too slow (see "Verification").
- **C. A periodically refreshed summary for the card.** Dropped: it has both paths' faults and
  shows stale figures.

## Design

### 1. What a keyed settlement counts in (decisions 2, 8)

`spendLimits` gets the caller and the account's plan. Narrowest first, so a refusal names the
narrowest full budget.

| Traffic | Scopes |
|---|---|
| Keyed (pubnet), plan Free | `account:<owner>` (the month's payments, then the day's fees), `free`, `global` |
| Keyed (pubnet), any other plan | `account:<owner>` (the month's payments, then the day's fees), `global` |
| No key (testnet) | as today: `payer:`, `payTo:`, `asset:`, `tier:other`, `global` |

- Keyed traffic leaves `payer:`, `payTo:`, `asset:` and `tier:other` (decision 2).
- The breakers (payer, `payTo`, wasm asset) are unchanged on both networks.
- A pubnet settlement without a caller is refused before it reserves (decision 9). The reason is
  `settle_exact_stellar_refused`, the code for a bug in the hook.

### 2. Plans (decisions 3, 8)

- **Definitions are config,** a plan name with its payments a month and its fee stroops per 24 h.
  The proposed values are below. The facilitator and the portal read the same definitions.
- **An account's plan is a row** `account_plans(owner, plan, set_at, set_by, note)`, made by a
  facilitator migration. No row means Free.
- **The operator changes it by hand** with a command beside `pnpm keys`, after the seller writes
  to us, as in Prices. The command refuses a plan name the config doesn't have.
- The plan is the account's, not the key's, so it survives a revoke and a new key.

### 3. Windows (decisions 4, 5)

- **An account's payments:** the calendar month in UTC, from the 1st at 00:00:00. That instant
  belongs to the new month, as in Prices' `period.rs` and 0106 decision 24. A reservation counts
  in the month of its `at`, however late it commits.
- **An account's fees, `free` and `global`:** a rolling 24 h, as today's budgets.
- **The pruner** keeps rows for the longest window: about 62 days.

### 4. Counting (decision 3)

- **A payment is a reservation that wasn't released**: one reserved or committed `account:` row
  this month. So a settlement sent to the network counts, a failed one included. A refusal before
  sending, a replay and `/verify` count nothing.
- **The check:** `payments this month + 1 > plan.payments` refuses, and so does `fees in the last
  24 h + ceiling > plan.dailyFeeStroops`. Both are under the same locks as today's sums.
- **There is no monthly fee budget** (akot, after the builder check). The daily one is what keeps
  an account out of others' room in `global`, and under it a seller attacked with ceiling-cost
  payments is refused for a day, not for the rest of the month.
- **`reserve` grows a count limit** beside the stroop sum (`count(*)` on the same index). There is
  no schema change for it.

### 5. Reopen (decision 9)

- **The reopening request's caller reserves**, under `<key>#<n+1>`. The earlier claim's reservation
  was released or never made.
- **A quota refusal is not in `UNSENT_REASONS`, like every spend limit.** The buyer signs a new
  payment once the account has quota again.

### 6. Refusals (decision 10)

All of them come from `/settle`, with HTTP 200, `success: false` and nothing signed, like every
spend refusal. The message names no account, address or XLM amount.

| Cause | `errorReason` | `errorMessage` | `extra` |
|---|---|---|---|
| The month's payments are used up | `settle_exact_stellar_quota_exhausted` | "the account's monthly quota of N payments is used up until <1st, 00:00:00Z>; contact us for a higher plan" | `resetsAt` |
| The day's fee budget is used up | `settle_exact_stellar_spend_limit_account` | "the account's fee allowance is used up for now: its payments cost more than usual; try again later" | – |
| `free` is full | `settle_exact_stellar_spend_limit_free` | "the free plan's shared allowance is used up for now; try again later, or contact us for a higher plan" | – |
| `global` is full | `settle_exact_stellar_spend_limit_global`, as today | as today | – |

- The existing advice ("sign a new payment once ledger N has closed", `retryable: false`) stays
  in front of these messages, as for today's spend limits.
- New reasons go into the metrics catalog's reason list, so they aren't counted as `other`.
- **A refusal's message and `extra` are stored with the record** (Claude's call, from the builder
  check). `BeforeSubmitResult` carries only a reason today; it gains them, so a repeat of a
  refused payment answers the same.

### 7. A payment that creates `payTo`'s balance (decision 6)

- **Still refused.**
- **The refusal names the cause.** When the fee is over the ceiling, the token is a SAC and
  `payTo` is a C-address, `/verify` reads that address's balance entry. If there is none, it
  refuses with `invalid_exact_stellar_pay_to_balance_missing`: "payTo has no balance of this token
  yet, and its first payment, which creates one, costs more than the facilitator pays: send payTo
  a first amount of the token from your own account, then pay again". It sits beside 0066's
  archived entries in `verify.ts`. Only that path reads the entry, so a normal `/verify` costs no
  extra RPC.
- **`/settle`'s re-check answers the same.**
- **Other tokens keep today's message:** their balance key isn't known.

### 8. Use in the hub (decision 1)

- **`account` answers `details.usage`** in Prices' shape: `used`, `remaining`, `limit`,
  `period_start`, `period_end`, `resets_at`, `as_of` (now) and `plan {name, quota_limit,
  quota_period: "month"}`. Payments only: the fee budget is not shown.
- **`usage` is `null` when the read fails,** as Prices'.
- **The portal reads a view, `account_usage`:** owner, month and payments, from the `account:`
  rows. It gets `SELECT` on the view and on `account_plans` only. The runbook's role
  step gains the two grants.
- **Until 0126 the portal reads testnet's database,** where no keyed settlement is counted, so the
  card shows 0. After 0126 it reads pubnet's, with the registry.
- **The hub (its own pull request, after the facilitator's is deployed):**
  - The "Mainnet (pubnet)" tile becomes "Monthly Usage · Mainnet", from Prices' `UsageFigures` and
    its quota-reached strip ("… until <date>. Contact us for a higher limit"). The Testnet tile
    stays.
  - `src/account/x402/api.ts` reads `details.usage`.
  - The x402 privacy paragraph gains the use counted per account and the plan row.
  - The x402 OpenAPI document gains the four new reasons (three of `/settle`, one of `/verify`).
  - The BFF passes `account` through and needs no change.

### 9. Monitoring (decision 11)

- **One alarm, the existing `budget-nearing`.** `spend_budget_nearing_total` writes its one series
  for `free` too, beside `asset`, `other` and `global`. Without it, free accounts filling `free`
  (half of `global`) would raise nothing.
- **No new alarm, metric or event per account.**
- **`spend_budget_nearing` is logged only for the shared budgets.**

### 10. Values (all config; the task's fourth criterion)

| What | Value | Why |
|---|---|---|
| Free | 1,000 payments a month, 2 XLM of fees per 24 h | CDP's 1,000; the whole quota at the typical fee fits in one day (1.22 XLM) |
| Basic | 10,000 payments a month, 2.5 XLM per 24 h | Claude's proposal; typical use is 0.4 XLM a day |
| Pro | 100,000 payments a month, 10 XLM per 24 h | Claude's proposal; typical use is 4 XLM a day |
| `free` | 25 XLM per 24 h | about 614 free accounts at full quota |
| `global` | 50 XLM per 24 h to start | the rule below |
| `MAX_FEE_STROOPS` | 250,000, unchanged | |

- **`global` ≥ `free` + the sum of the raised accounts' daily fee budgets.** Then no account,
  attacked or with a leaked key, takes more than its own day's budget from the others, and
  `global` is a backstop that never fills. The operator checks the sum when it grants a plan, and
  raises `global` and the float when there is no room (the runbook's step). 0024's rule still
  holds: `global ≤ float − alarm`. At the start, 25 XLM a day holds ten Basic accounts, or two Pro
  and two Basic.
- **A plan's daily fee budget must be at least the ceiling**, as for every budget today.
- **The float on pubnet** (ADR 0013's 100 XLM) goes to the runbook as a note, not decided here.
  Under a sustained attack on `free`, it falls to its alarm in about 3 days.

### 11. Docs

- **Facilitator README:** the plans, the config, the four reasons, and the operator's plan
  command.
- **ADR 0007:** an amendment for 0107, covering what keyed traffic counts in, the plans, no ban,
  the reasons, and the new balance's pubnet figures.
- **Threat model:**
  - "Shared budget exhaustion": the residual moves to the free tier.
  - "Targeted `payTo`": moved, not closed. The seller's own key carries its buyers' payments, so
    a buyer can use up the seller's monthly quota (see "Residual risk").
  - "Fee inflation by rent": the pubnet figures.
  - "A key leaks" and "A new key for a new budget".
- **Spine:** AD-11, AD-18.
- **Runbook:** the plan command, the role's grants, the float note.
- **ADR 0013's "~41,200 a typical settlement":** add pubnet's measured 12,203.
- **0108's XLM price:** $0.69 then, $0.128 now. A note in that task.
- **`config.ts`'s pubnet message** stops naming 0107.

### 12. Delivery (decision 12)

- **One pull request in stellar-x402,** its commits in risk order (`risk-split-pr`), so a review
  can go commit by commit:
  1. moves and refactors;
  2. the store's count limit and per-limit windows;
  3. the plans table, the view and the command;
  4. the policy's scopes and reasons;
  5. the balance-missing refusal;
  6. the portal's `details.usage`;
  7. config, alarm and docs.
- **One pull request in sorobanscan-api-portal,** after the facilitator's is deployed.

## Verification before 0126

Nothing settles on pubnet before 0126, so a keyed settlement can't run end to end. The plan has to
say what stands in for it:

- **The policy:** tests with a caller passed in.
- **The store:** contract tests on PostgreSQL. They cover concurrency at the month's edge and a
  key's replacement continuing the count.
- **The view:** a test on PostgreSQL.
- **The portal:** its tests on the in-memory and PostgreSQL stores.
- **Speed:** a measured reserve with 100,000 rows in one account's month, to confirm A before
  anyone gets Pro.
- **The balance-missing refusal:** on testnet a fresh C-address balance costs about 120,000
  stroops, under the ceiling, so the hosted facilitator never refuses it. It is tried on a local
  facilitator against testnet with a lower `MAX_FEE_STROOPS`, and so is its fix (one transfer
  from the seller's own account).

## Residual risk (accepted)

- **A buyer can use up a seller's quota** (akot, 2026-11-23). The seller's server calls `/settle`
  with the seller's key, so its buyers' payments count in the seller's account.
  - 1,000 purchases spend a free seller's month. That costs the buyer 1,000 × the price, which
    the seller receives. We can't tell it from a popular seller. Charging past the quota (0108)
    is the fix; until then the operator raises the plan.
  - Payments from a wallet built to cost the ceiling spend the seller's daily fee budget in 80
    payments (Free), and refuse it for a day.
- **The free tier is Sybil-able.** 13 Discord accounts paying the ceiling refuse free accounts
  for a day, and about 30 for a month (an account's month is at most 1,000 ceilings, 25 XLM).
  Raised accounts keep settling.
- **`free` bounds the rate, not the sum.** A sustained attack costs up to 25 XLM a day, and the
  float's alarms and hand top-ups bound the total (ADR 0013).
- **An abusive account comes back each month with a new key** (no ban).
- **A C-address seller creates its balance once,** from its own account.
- **An account can spend its quota at the end of a month and again at the start of the next;**
  its daily fee budget and `free` bound that.
- **After its quota, a seller's handler still runs:** `/verify` passes and `/settle` refuses.
  `@x402/express` 2.31.0 then withholds the response it buffered.

## Left to the builder

- Config variable names and format, and how both services get the plan definitions.
- The view's exact SQL, the migration's number and form (the online-migration rules), and the
  command's flags.
- Where the plan is read in the request: in `admit` with the owner, or in `beforeSubmit`.
- The test layout.

## Proposed additions to the task's criteria (Claude's, for akot)

- **The hub:** given an account with a key, when it opens the hub's x402 tab, then it sees this
  month's payments, its limit, its plan and the reset date.
- **A key's replacement:** given an account that used part of its quota, when it revokes its key
  and gets a new one, then its use carries over (0106's third criterion).
- **A new balance:** given a payment to a C-address `payTo` with no balance of a SAC token, when
  `/verify` runs, then it is refused with `invalid_exact_stellar_pay_to_balance_missing` and the
  fix.
