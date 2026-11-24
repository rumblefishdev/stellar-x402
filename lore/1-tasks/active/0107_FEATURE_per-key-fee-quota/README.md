---
id: "0107"
title: "Give each API key holder a free quota and a fee budget apart from the shared ones"
type: FEATURE
status: active
owner: akot
milestone: 2
related_adr: ["0007", "0013"]
related_tasks: ["0024", "0105", "0106", "0108"]
tags: [facilitator, fees, budgets, before-pubnet, priority-high, effort-medium, platform]
links:
  - ../../../../docs/adr/0007-fee-abuse-containment.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0024: per-key budgets close the shared-budget exhaustion on pubnet."
  - date: "2026-11-23"
    status: active
    who: akot
    note: "Work starts, with a design first: the decisions in \"Decisions to make here\"."
---

# Give each API key holder a free quota and a fee budget apart from the shared ones

## Summary

On pubnet each key holder (one Discord account, 0106) gets a free quota of settlements, on the
model of Coinbase CDP (1,000 a month, then $0.001 each), and its settlements count in a budget of
its own rather than in 0024's shared `asset:<C…>` and `tier:other` ones (decided by akot,
2026-11-03). Then a caller's self-payments use up only its own quota, which is what closes 0024's
"Shared budget exhaustion by Sybil self-payments" on pubnet. Charging past the quota is 0108 and
doesn't block pubnet: until then the operator raises an account's limit by hand.

## Research (2026-11-23)

Summary and inputs to the design: [S-research](notes/S-research.md). The notes:

- [R-codebase-map](notes/R-codebase-map.md): where the budgets are counted, the reservation, repeats
  and reopens, and the seams an owner scope fits into.
- [R-fee-numbers](notes/R-fee-numbers.md): pubnet's typical settlement (12,203 stroops, measured), the
  ceiling, a new balance's rent, and the arithmetic for the defaults. Scripts in
  [notes/fee-scan](notes/fee-scan/).
- [R-prior-art](notes/R-prior-art.md): CDP, PayAI, OpenZeppelin Channels, Launchtube, paymasters and
  free-tier APIs, with their sources.
- [R-prices-api](notes/R-prices-api.md): how stellar-prices-api counts its monthly quota.
- [R-threats](notes/R-threats.md): what each option closes and leaves in the threat model.
- [R-recipient-balance](notes/R-recipient-balance.md): who pays to create a recipient's token balance
  on other chains, in the x402 specs and at other facilitators (for decision 4).

## Implementation

- Per account: settlements per calendar month (1,000 by default) and a fee budget under it, so a
  key whose settlements cost the ceiling stops before it costs 1,000 ceilings. Every included
  settlement counts, a failed one too.
- One budget for all free quotas together, so many Discord accounts use up only the free traffic,
  not the accounts whose limit the operator raised.
- `global` stays, as the bound on the total loss; its value is set from the sum of the quotas and
  the float (ADR 0013).
- Past the quota, `/settle` refuses with a reason of its own before anything is signed; the
  operator raises one account's limit (config or the registry, to decide).
- Events for 0027: an account nearing and reaching its quota, the shared free budget nearing its
  limit.
- From 0105: the spend policy's `beforeSubmit` gets the key's owner as `ctx.caller.owner`
  (`operator:<name>` or `discord:<id>`), `undefined` on testnet. The owner is not stored with the
  settlement: `onFinal` gets the record, and a reservation keeps its scopes. The rate limiter
  already counts a pubnet caller by the same owner. The caller is the one whose request reaches
  `beforeSubmit`: on a repeat or a reopen (`ctx.reopened`) that is the owner repeating the
  payload, which may not be the owner of the first request, so the quota has to say whose a
  reopened settlement is. Only the `/settle` route calls `Settle` today, so on pubnet `caller` is
  always set; a caller added later that passes none must be refused or given a scope, not left
  outside every quota (from the review of #185, 2026-11-13).
- Docs: the facilitator README, ADR 0007, the threat model ("Shared budget exhaustion", "Targeted
  `payTo` budget exhaustion").

## Decisions to make here

All made on 2026-11-23, in "Design Decisions" below:
- ~~Whether the per-payer and per-`payTo` budgets apply to keyed traffic~~: decision 2.
- ~~Settlements, fees or both~~: decision 3.
- ~~The month~~: decision 4.
- ~~Whether the facilitator pays for a payment that creates `payTo`'s balance~~: decision 6.
- ~~Whether an operator's revoke bans an owner (0106 decisions 34, 35)~~: decision 7.

## Acceptance Criteria

- [ ] Given a pubnet settlement with a key, when it reserves, then it counts in its account's
      budget and in `global`, not in the shared asset and tier budgets
- [ ] Given an account past its quota, when it calls `/settle`, then it is refused with nothing
      signed, until the month rolls or the operator raises its limit
- [ ] Given many accounts on free quotas, when together they fill the shared free budget, then an
      account with a raised limit still settles
- [ ] Given the quota and budget values, when this task ends, then they are config and recorded
- [ ] Given an account with a key, when it opens the hub's x402 tab, then it sees this month's
      payments, its limit, its plan and the reset date
- [ ] Given an account that used part of its quota, when it revokes its key and gets a new one,
      then its use carries over (0106's third criterion)
- [ ] Given a payment to a C-address `payTo` with no balance of a SAC token, when `/verify` runs,
      then it is refused with `invalid_exact_stellar_pay_to_balance_missing` and the fix

## Design Decisions

Design: [S-design](notes/S-design.md), approved by akot on 2026-11-23. Plan:
[G-implementation-plan](notes/G-implementation-plan.md), to be carried out in a later session.

### From Plan

1 to 13 are akot's, from the design session of 2026-11-23.

1. **As in stellar-prices-api, with the use shown in the hub, in this task.** An account has a
   named plan with a monthly quota of payments, is refused when it is spent, and sees its use in
   the hub's x402 tab. "Monthly Usage · Mainnet" takes the place of the "Mainnet (pubnet)" tile and
   the Testnet tile stays. The hub's part is a pull request of its own in sorobanscan-api-portal,
   as in 0106.
2. **Keyed traffic counts in its account, `free` and `global` only.** `free` applies to an account
   on the free plan. `payer:`, `payTo:`, `asset:` and `tier:other` stay for keyless traffic
   (testnet). The breakers are unchanged on both networks. Another caller's key can no longer
   fill a seller's `payTo` budget. What is left is accepted (akot, after the builder check): a
   seller's own key carries its buyers' payments, so a buyer can use up the seller's quota at
   1,000 × the price, paid to the seller. Charging past the quota (0108) is the fix.
3. **1,000 payments a month, with a hidden fee budget per rolling 24 h under it** (2 XLM on the
   free plan).
   - A payment is a settlement sent to the network, a failed one included. `/verify`, a refusal
     and a replay are not payments.
   - The seller sees payments only.
   - First decided as 5 XLM a month, then changed after the builder check: a monthly budget can be
     spent in one day, so one raised account could fill `global` for everyone, and a seller
     attacked with ceiling-cost payments would be refused for the rest of the month. There is no
     monthly fee budget.
4. **The calendar month in UTC,** from the 1st at 00:00, as Prices' `period.rs` and 0106 decision
   24 have it.
5. **`free` is 25 XLM per rolling 24 h, and `global` starts at 50 XLM per 24 h.**
   - `global` is at least `free` plus the raised accounts' daily fee budgets. The operator checks
     that when granting a plan.
   - A monthly cap on `free` was dropped: it would bound the sum but turn an attack into a month
     without a free tier, for fewer accounts.
6. **A payment that creates `payTo`'s balance stays refused,** with a reason of its own,
   `invalid_exact_stellar_pay_to_balance_missing`, and the fix in its message, in this task. Its
   pubnet figures go into ADR 0007 and the threat model. This is the norm elsewhere: the x402 SVM
   maintainers, PayAI, x402-rs, the NEAR spec and `@x402/stellar`'s 50,000 ceiling all refuse (R-recipient-balance).
7. **No ban, as in Prices.** An operator's revoke stays a revoke (0106 decision 35). The issue cap
   needs no lock (0106 decision 34): the use is the account's, so a key from that race gains no
   quota.
8. **Plans as in Prices.** The definitions are config. An account's plan is a row in the registry
   (no row means Free), and the operator changes it by hand with a command, after the seller
   writes to us. The plan survives a revoke and a new key.
9. **Whoever's request sends the payment pays for it,** the first claim or a reopen. A quota
   refusal doesn't reopen. A pubnet settlement without a caller is refused.
10. **The refusals:**
    - `settle_exact_stellar_quota_exhausted`, `…_spend_limit_account` and `…_spend_limit_free`;
    - the reset instant in the message and `extra.resetsAt` for the monthly quota;
    - HTTP 200 as for every x402 settle refusal;
    - no quota check at `/verify`.
11. **One alarm, the existing `budget-nearing`, which gains `free`.** Nothing per account: no alarm,
    no metric, no event.
12. **One pull request in stellar-x402,** its commits in risk order, and one in the hub.
13. **Approach A:** the account and `free` as two more scopes in 0024's spend store. The portal
    reads a view. The fallback, a counter per (account, month), is kept for the account scope if a
    large plan's sum is too slow.

### Emerged

Claude's calls in the design (14 to 25), approved with it. 26 is the plan's.

14. **Plans Basic (10,000 payments a month, 2.5 XLM of fees per 24 h) and Pro (100,000, 10 XLM),**
    beside Free (1,000, 2 XLM).
15. **The scopes are `account:<owner>` and `free`,** in the order account (the month's payments,
    then the day's fees), `free`, `global`.
16. **The operator's command refuses a plan the config doesn't name.** A row whose plan was later
    removed from the config counts as Free, with an error logged.
17. **`spend_budget_nearing` is logged for the shared budgets only.**
18. **`details.usage` has Prices' shape, payments only.** The fee budget is not shown, and `as_of`
    is the time of the read.
19. **The portal reads the view and `account_plans` only.** The facilitator and the portal read
    the same plan definitions.
20. **The balance-missing reason covers SAC tokens and a C-address `payTo` only.** It is read only
    on the over-the-ceiling path.
21. **The privacy paragraph says what is kept:** the payments and fees counted per account for
    about two months, and the plan row.
25. **A refusal's message and `extra` are stored with the record,** so a repeat answers the same
    (from the builder check).
22. **Pubnet is prepared in M2 and opened later.** That is Claude's reading: SCF's plan has the
    mainnet launch in Tranche #3. akot has not confirmed it.
23. **Three criteria are proposed:** the use in the hub, the use carrying over to a new key, and
    the balance-missing refusal (S-design, the end).
24. **The pruner keeps rows for the longest window,** about 62 days.
26. **In the plan:** `extra.resetsAt` comes from the record's creation time, so a first answer and
    a repeat agree. The plan is read in `beforeSubmit`, and a plan read that fails refuses as a
    store failure does. The plans are one setting, `ACCOUNT_PLANS`, read by both services. The
    pruner keeps the month's rows only on a network that requires a key.

## Implementation Notes

**The count limit's cost (Task 3, measured 2026-11-23).** The count runs under the global scope's
lock, so its time is every reserve's wait. Approach A stands: fallback B isn't needed.

- Setup: 100,000 reservations of one `account:` scope in the month, as a Pro account at its quota,
  each also in `global`. Then 200 reserves one after another, after 10 warm-up ones, each with the
  account's count, its 24 h fees and `global`. PostgreSQL 18.6.
- Result, six runs, on fresh rows and after a VACUUM alike: median 13.8–16.1 ms, p99
  16.3–26.0 ms, the slowest single reserve 33.7 ms. Without the count limit (the last three runs,
  after that phase was added): median 2.3 ms, p99 3.7–3.8 ms.
- So the count adds about 12 ms at 100,000 rows, below the plan's 50 ms at p99. A Free account
  counts at most 1,000 rows.
- Here the planner counts by a parallel sequential scan, since the account is half the table; the
  test prints the plan.
- Re-run against the test database (`127.0.0.1:15432` or `TEST_DATABASE_URL`). It uses a schema of
  its own, dropped at the end:
  `MEASURE_SPEND_COUNT=1 pnpm --filter @stellar-x402/facilitator exec vitest run test/spend-count.timing.test.ts --silent=false`

**The balance-missing refusal on testnet (Task 6, run 2026-11-24).** The refusal and its fix both
work. The run: a local facilitator with `MAX_FEE_STROOPS=100000`, payments of 1,000 stroops of XLM
through its SAC, and a fresh contract as `payTo`. Results:
[pay-to-balance-missing-testnet.json](../../../../apps/facilitator/test/live/results/pay-to-balance-missing-testnet.json).

- The first payment's resource fee was 128,027 stroops, over the ceiling, with no archived entry.
  `/verify` refused it with `invalid_exact_stellar_pay_to_balance_missing` and the fix. `/settle`
  answered the same from its record.
- The seller sent `payTo` 1 XLM from its own account in one transfer
  (`b2c6339a219ba763e7d522a81154e9249b35dd0be7c111f899bb088b6ecef9e3`, 104,829 stroops charged).
  That created the balance. The key the facilitator reads, the SAC's persistent
  `Balance(payTo)`, was in the transfer's read-write footprint and on the ledger after it.
- The payer's next payment cost 14,730 stroops of resources. It verified and settled
  (`86fc98415a36f603484fdb2196a97e6d7c0bc19eee53214b0d549878c971d0ef`, 9,940 stroops charged). The
  first payment stays refused, from its record.
- Re-run in `apps/facilitator`, against a migrated database of its own:
  `DATABASE_URL=<url> npx tsx test/live/pay-to-balance-missing.ts`
