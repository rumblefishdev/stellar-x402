---
id: "0157"
title: "Close the test and doc gaps the reviews of 0086 and 0156 left"
type: FEATURE
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0156", "0086", "0074", "0107", "0126"]
tags: [facilitator, payments, tests, priority-low, effort-small]
links: ["https://github.com/rumblefishdev/stellar-x402/pull/210", "https://github.com/rumblefishdev/stellar-x402/pull/219"]
history:
  - date: "2026-11-20"
    status: backlog
    who: claude
    note: "Spawned from 0156 future work: the reviews of #210 (0086) and of 0156's branch."
---

# Close the test and doc gaps the reviews of 0086 and 0156 left

## Summary

The review of the sixth deploy (#210, which took in 0086) and the review of 0156's branch found
gaps that change no behavior: a wiring no test protects, a guard no test exercises, and docs and
comments left from before 0086 landed. None of them blocks a deploy.

## Implementation

- **The composed `/verify` records a check refusal**: dropping `verifyWithRefusals` from
  `main.ts` fails no test today. Add a `settle-pool.test.ts` case through `composed()`: the checks
  refuse, `settlements.get(key)` is `refused`, a repeat skips the checks.
- **`verifyWithRefusals` skips another network's payment**: add a `refusals.test.ts` case with
  pubnet requirements: plain refusal, nothing stored.
- **"`settlements_refused` is #205's, listed ahead"**: delete the comment in
  `packages/metrics-catalog/src/index.ts` and the comment and hand-added entry in
  `catalog-values.test.ts`, which would hide a rename in `pruner.ts`.
- **`createPruner`'s doc** still says "`refused` settlements past their hour"; say "once their
  expiration ledger has closed, an hour after at the earliest".
- **README**: "`/verify` keeps no record either…" in the `settlement_nonce_consumed_elsewhere_total`
  paragraph contradicts 0086; reword (the repeat still counts, as the checks run when the record
  isn't `refused`).
- **`main.test.ts` "…until it closes"**: the second half passes even if `main()` never closes the
  pruner, since a tick waits on the real RPC before `spend.prune`. Check without network timing,
  e.g. the test RPC's `getLatestLedger` count staying flat. Coordinate with 0074 (timing tests).

From Oskar's review of #236 (0107, 2026-11-24), checked by mutation: each change below passed the
whole facilitator suite (52 files, 1,339 tests).

- **The composed service on a network that requires a key**: every `compose()` test builds a
  testnet config, so nothing protects `main.ts`'s keyed wiring. Add a `compose()` test with a
  pubnet `Config` built directly, past `parseConfig`'s refusal, as `api-key-route.test.ts` does
  (`{ ...parseConfig({...}), network }`): a `/settle` with a key reserves `account:<owner>` under a
  plan from `ACCOUNT_PLANS` and from an `account_plans` row, a settlement without a caller is
  refused, and the pruner's window is the keyed one (62 days kept). The four changes that pass
  today: `spendWindowMs: config.spend.windowMs` (the month's rows would go after 7 days, so a
  quota would count a week), `keyed: false`, the default plans in place of
  `config.spend.accountPlans`, and `plans: { planOf: async () => undefined }`. **Before 0126
  starts**: it rewrites `compose()` for two networks.
- **`upstreamMessage` in the `verified` and `settled` lines**: deleting the field from either
  `logger.info` in `http/app.ts` fails no test, and for
  `invalid_exact_stellar_pay_to_balance_missing` it is the only place the fee upstream measured
  remains (0107 decision 31). Add a fee-refusal stub to `verify-route.test.ts` and
  `settle-route.test.ts` (SAC kind, contract `payTo`, empty `getLedgerEntries`) that asserts the
  field in the line.

## Acceptance Criteria

- [ ] Reverting any of the four keyed wirings in `main.ts` fails a test (before 0126 starts)
- [ ] Removing `upstreamMessage` from the `verified` or the `settled` line fails a test
- [ ] Removing `verifyWithRefusals` from `main.ts` fails a test
- [ ] Removing the network guard in `verifyWithRefusals` fails a test
- [ ] No comment or doc says #205 hasn't landed or that refused records go after the hour alone
- [ ] Removing `pruner.close()` from `main()`'s close fails a test
