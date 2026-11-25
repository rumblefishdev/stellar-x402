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
  - date: "2026-11-24"
    status: active
    who: akot
    note: "Built and reviewed on the branch (the workspace's tests pass). Left: the hub's card, a pull request of its own in sorobanscan-api-portal."
  - date: "2026-11-24"
    status: active
    who: akot
    note: "Review of #236 by Stanisław and Oskar, 14 points, each checked on the branch: the reopen's double count fixed (decision 34), the docs brought in line (35 to 37), the rest in 0157, 0126, 0108 and 0161."
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

- [R-fee-numbers](notes/R-fee-numbers.md): pubnet's typical settlement (12,203 stroops, measured), the
  ceiling, a new balance's rent, and the arithmetic for the defaults.
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
- Events for 0027: the shared free budget nearing its limit, through the existing `budget-nearing`
  alarm. ~~An account nearing and reaching its quota~~: dropped by decision 11, nothing is
  reported per account but a refusal's log line (decision 35).
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

Nothing settles on pubnet before 0126, so the ticked ones rest on tests, and the last on a testnet
run too. Each names what it rests on.

- [x] Given a pubnet settlement with a key, when it reserves, then it counts in its account's
      budget and in `global`, not in the shared asset and tier budgets
      (`spend-policy.test.ts`, "a keyed settlement on the free plan reserves account, free and
      global")
- [x] Given an account past its quota, when it calls `/settle`, then it is refused with nothing
      signed, until the month rolls or the operator raises its limit
      (`settle.test.ts` on PostgreSQL: "an account past its quota…", "the month's roll gives the
      quota back", "a raised plan settles at once")
- [x] Given many accounts on free quotas, when together they fill the shared free budget, then an
      account with a raised limit still settles
      (`settle.test.ts`, "free accounts fill free; a raised account still settles")
- [x] Given the quota and budget values, when this task ends, then they are config and recorded
      (`SPEND_FREE_STROOPS`, `ACCOUNT_PLANS`; `config.test.ts`; the facilitator README's table)
- [ ] Given an account with a key, when it opens the hub's x402 tab, then it sees this month's
      payments, its limit, its plan and the reset date
      (the portal answers `details.usage`, `apps/portal/test/app.test.ts`; the card is a pull
      request of its own in sorobanscan-api-portal)
- [x] Given an account that used part of its quota, when it revokes its key and gets a new one,
      then its use carries over (0106's third criterion)
      (`settle.test.ts`, "the quota carries over to a new key")
- [x] Given a payment to a C-address `payTo` with no balance of a SAC token, when `/verify` runs,
      then it is refused with `invalid_exact_stellar_pay_to_balance_missing` and the fix
      (`verify.test.ts`, and the testnet run in "Implementation Notes")

## Design Decisions

Design: [S-design](notes/S-design.md), approved by akot on 2026-11-23. The build
plan was carried out on 2026-11-23 and 24, and removed with the pre-build code map once used: both
are in this branch's history.

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
    no metric, no event. (Amended by 35: a refusal's log line names the account.)
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

27 to 33 came up in the build (2026-11-23 and 24), without akot. He should read them.

27. **A caller picks the account's scopes; `keyed` only refuses a missing caller.** `admit` sets a
    caller only where a key is required, so the two can't disagree today.
28. **`SPEND_FREE_STROOPS` must stay within `SPEND_GLOBAL_STROOPS` only where a key is required,**
    so a self-hosted testnet with a lowered `global` still starts.
29. **The view `account_usage` reaches an account's rows through its `spend_scopes` row,** so the
    window index serves one owner's read. After a narrow race with the pruner the hub can show
    fewer payments than the store counts, until the account's next reservation.
30. **A refusal's message is stored in the record's `error_message`,** which a reopen clears.
31. **For the balance-missing refusal, the fee upstream measured goes to the log field
    `upstreamMessage`.** The client's message names no amount.
32. **The portal answers `usage: null` rather than refusing to start** when the table, the view or
    the grant is missing.
33. **The pubnet refusal names 0048 alone.** 0027's signer alarm has landed, but pubnet's own
    instance exists only once infra lists the network (0126).

34 to 37 came from the review of #236 (2026-11-24). akot took them as recommended.

34. **A reopened claim gives up the earlier claim's reservation before it reserves** (Stanisław's
    review). The design had "the earlier claim's reservation was released or never made", but
    `/settle` doesn't wait for a claim's `onFinal`, and a claim may never get one (0073 decision
    26). Until then one payment counted twice: at the month's last payment its reopen was refused
    `quota_exhausted` for good while the account had room, and after a lost `onFinal` the account
    was a payment short until the month ended. The earlier claim ended with nothing sent, so its
    reservation can never be charged, and `release` leaves a committed one alone. A release that
    fails refuses as a store failure, which reopens. The stroop budgets had the same double count
    since 0024, for 24 h, and it goes with this. Chosen over counting distinct payments in SQL
    (the count alone, and the store and the view would read the id), over letting a quota
    refusal reopen (R-threats §5), over waiting for `onFinal` (one process only), and over a
    `supersedes` argument to `reserve` (a port change for no gain: nothing is sent between the
    release and the reserve).
35. **A refusal is still logged per account; this amends 11** (Oskar's review).
    `spend_limit_reached` carries the budget's `scope`, an account's as `account:<owner>`, and
    `account_plan_unknown` carries the owner: the first is what tells the operator whom to offer
    a higher plan, and the runbook groups by it. "Nothing per account" stands for the rest: no
    alarm, no metric, no label, and no nearing event (17).
36. **A reservation nothing releases is an accepted residual; no sweep** (Stanisław's review).
    One is left when `onFinal`'s release fails (logged, counted, not retried), when the process
    dies between the final write and the release, or when `beforeSubmit` loses `reserve`'s
    answer and its own release fails too. A crash that leaves the record open isn't one:
    reconciliation ends the record and calls `onFinal`. Such a reservation counts 24 h in the fee
    budgets and until the month ends in its account's payments, so the account is one payment
    short, for a store failure at that moment. A sweep would have to tell a dead reservation
    from a settlement in flight, a new mechanism for one payment; 0108 charges for `committed`
    reservations only, where it would otherwise become a charge.
37. **The view keeps its form, and its comment says what it costs** (Stanisław's review). The
    view finds an owner's row by a scan of `spend_scopes`, since `owner` is an expression: 0.5 ms
    at 72 rows, 1.5 ms at 3,500, 5.5 ms at 50,000 (PostgreSQL 18.6, median of 300 reads), against
    0.4 ms for a read that names the scope. The table holds a row per account and per breaker
    scope where a key is required. Chosen over changing the migration and the portal's read
    before the merge, for a few milliseconds per opening of the hub's card.

## Implementation Notes

Built on 2026-11-23 and 24: the spend store's count limit; plans, migration `0018_account_plans`
and `keys plan`; the policy's account scopes and refusals; the balance-missing refusal; the
portal's `details.usage`; the config, the alarm's `free` and the docs. The hub's card is not done.

- **A payment, precisely:** one the network charged a fee for, a failed one too, or one still in
  flight. One sent and never included stops counting, so the hub's `used` can go down. A
  reopened payment counts once (decision 34). A reservation that nothing released counts as one
  until the month ends (decision 36).
- **The count limit's cost** (measured 2026-11-23, PostgreSQL 18.6): with 100,000 rows of one
  account in the month, a reserve took 13.8–16.1 ms at the median and 16.3–26.0 ms at p99 over
  six runs, against 2.3 ms and 3.8 ms without the count. That is under the 50 ms the build plan
  set, so approach A stands.
- **The balance-missing refusal on testnet** (run 2026-11-24, `MAX_FEE_STROOPS=100000`): the first
  payment to a fresh contract cost 128,027 stroops and was refused with the reason. One transfer
  of 1 XLM from the seller's own account created the balance, and the next payment settled.
  Hashes and fees:
  [pay-to-balance-missing-testnet.json](../../../../apps/facilitator/test/live/results/pay-to-balance-missing-testnet.json).
  Re-run in `apps/facilitator`: `DATABASE_URL=<url> npx tsx test/live/pay-to-balance-missing.ts`

**To do at the deploy or in 0126** (noted in 0126 too): run
`deploy/scripts/check-production-portal.sh` (changed, only syntax-checked here); run the role's
grant step again (it sets a new password, so the portal restarts); the runbook's Logs Insights
query and `keys plan` through `docker exec`; the `free` alarm's fire-test; the size of the
`apiKeys` pool, where the plan read now waits.

**Open for akot.**

- The count has no upper bound on `at`: within milliseconds of a month's start it can refuse one
  payment too many, and never lets one too many through. Accept it, or bound it by the month's
  end.
- Decision 33: whether the pubnet refusal names the signer alarm again until infra lists pubnet.
- ~~Left out, not spawned as tasks~~: now
  [0161](../../backlog/0161_FEATURE_account-plan-leftovers.md), with the warning from `keys plan`
  that Oskar's review asked for.

**From the review of #236, in other tasks.**

- [0157](../../backlog/0157_FEATURE_refusal-test-and-doc-gaps.md): a `compose()` test on a network
  that requires a key (four reverts of `main.ts`'s keyed wiring pass the suite), before 0126
  starts, and a route test for `upstreamMessage` in the `verified` and `settled` lines.
- [0126](../../backlog/0126_FEATURE_serve-both-networks-from-one-process.md): the pruner's horizon
  per network, `ACCOUNT_PLANS` and the two `SPEND_*` values from the server's `.env` for both
  services, and the portal's log for a plan its config lacks.
- [0108](../../backlog/0108_FEATURE_settle-billing.md): charge for `committed` reservations only.
- Not taken: a line in the runbook's rollback notes for a release before 0107 pruning the month's
  rows after 7 days. No such release starts on pubnet (`config.ts` refuses it), so the case is
  0126's, above.

## Issues Encountered

- `advance` did not take `errorMessage`, as the build plan assumed (decision 30).
- `catalog-values.test.ts` compares the catalog with the code, so a new reason is listed in the
  commit whose code writes it.
- `LIKE 'account:%'` can't use the index under `en_US.utf8`, hence the join in decision 29.
- Existing tests changed on purpose: `spend-policy.test.ts` lost "an owner like any other, until
  0107"; two whole-`usage` assertions gained `windowMs`; `main.test.ts`'s pruner test follows the
  new window rule. With decision 34, "a reopen reserves under the reopening caller" no longer
  runs the first claim's `onFinal` before the reopen: the reopen itself gives that reservation
  up.
- The reopen's double count (decision 34) passed the build's reviews: every reopen test ran the
  earlier claim's `onFinal` first, as the design assumed.
