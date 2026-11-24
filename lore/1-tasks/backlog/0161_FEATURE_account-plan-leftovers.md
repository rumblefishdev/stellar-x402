---
id: "0161"
title: "Warn when keys plan names an owner without a key, and the other small leftovers of 0107"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0007"]
related_tasks: ["0107", "0126"]
tags: [facilitator, api-keys, operations, before-pubnet, priority-low, effort-small]
links: ["https://github.com/rumblefishdev/stellar-x402/pull/236"]
history:
  - date: "2026-11-24"
    status: backlog
    who: akot
    note: "Spawned from 0107: what its build left out, and Oskar's review of #236 asked for the first."
---

# Warn when keys plan names an owner without a key, and the other small leftovers of 0107

## Summary

0107's build left four small things out as beyond its plan, and the review of #236 asked for the
first. None changes what a settlement counts in. The first matters from the first plan the
operator grants on pubnet, so this is done before pubnet opens.

## Implementation

- **`keys plan` warns for an owner that never had a key** (Oskar's review of #236). The command
  checks only that the owner is well formed, and `setPlan` upserts, so
  `keys plan discord:<id with a typo> pro` sets the plan on an account nobody holds and the
  seller stays on `free`; only the printed row shows it. Warn, don't refuse: a plan before the
  first key may be wanted. `keysMain`'s `ApiKeyStore` has `list()`, which includes revoked keys,
  and `SealedKeyStore.keysOf(owner)` answers an empty object for an owner that never had one. The
  runbook's "Account plans" then says what the warning means.
- **A cooldown on `account_plan_unknown`**: every settlement of an account whose row names a plan
  the config lacks logs the error.
- **A log line when the balance read fails** on the balance-missing path (`verify.ts`): a failed
  or timed-out read is silent today, and the answer keeps upstream's fee reason. The trustline
  lookup beside it logs `trustline_lookup_failed`; this needs a logger in `VerifierDeps`.
- **`apps/portal/src/cap.ts` on the shared helpers** of `@stellar-x402/api-keys` (`utcInstant`,
  `monthStart`, `monthEnd`): it keeps its own `rfc3339` and month bounds from before 0107.

## Acceptance Criteria

- [ ] Given an owner that never had a key, when the operator runs `keys plan` for it, then the
      plan is set and a warning says no key was ever issued to that owner
- [ ] Given an account on a plan the config lacks, when it settles many times, then
      `account_plan_unknown` is logged at most once per cooldown
- [ ] Given a balance read that fails, when `/verify` refuses for the fee, then a log line names
      the failed read
- [ ] Given the portal's monthly cap, when it computes the month, then it uses the shared helpers
