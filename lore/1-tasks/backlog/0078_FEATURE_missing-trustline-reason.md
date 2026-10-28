---
id: "0078"
title: "Name a missing trustline in /verify's answer instead of a generic simulation failure"
type: FEATURE
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0018", "0021", "0066"]
tags: [facilitator, exact, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      Spawned from the Milestone 1 status check: the panel review response (§5, "Trustline
      onboarding") promises an actionable error for a missing trustline, and no task covered it.
---

# Name a missing trustline in /verify's answer instead of a generic simulation failure

## Summary

As a buyer or a seller testing with a fresh wallet, I want `/verify` to tell me that a trustline
is missing, and on which account, so that I know to add it instead of guessing why the payment
failed. Today the payment fails with upstream's generic `invalid_exact_stellar_payload_simulation_failed`.

## Context

- The panel review response (§5, "Trustline onboarding") says: "Our pre-flight simulation step
  detects a missing trustline before payment is attempted and returns an actionable error." The
  code doesn't do that yet.
- A classic asset's SAC (USDC on testnet, for example) moves funds only between accounts that
  hold a trustline to the asset. A payment fails in simulation when the payer has none, which
  means no balance either, or when the seller's `payTo` G-account has none. The `payTo` case is
  the one a new seller hits: the buyer did everything right, and the seller's account can't
  receive the payment. C-address holders and non-SAC SEP-41 tokens have no trustlines.
- `/verify` calls upstream `ExactStellarScheme.verify()` (0018). On a failed simulation it
  returns `invalid_exact_stellar_payload_simulation_failed`, writes the RPC's error text to
  `console.error` only, and doesn't pass it back to us. So our wrapper can't read the cause from
  upstream's answer.
- `/settle` reruns the same checks, so a fix in `/verify` covers it too.
- 0021's token matrix already sets up trustlines for the seller's classic assets
  (`apps/facilitator/scripts/token-matrix.ts`) and can produce both failing cases on testnet.

## Implementation

- Choose how to find the cause (open question, decide before coding):
  - **Check trustlines after a failed simulation:** when upstream answers `simulation_failed` and
    the asset is the SAC of a classic asset, read the payer's and `payTo`'s trustline entries with
    one `getLedgerEntries` call. This costs nothing on the happy path.
  - **Re-simulate ourselves after a failed simulation** and match the SAC's
    missing-trustline contract error in the result. This depends on the error text.
- Add two reasons, for example `invalid_exact_stellar_payer_trustline_missing` and
  `invalid_exact_stellar_payto_trustline_missing`. Put the account and the asset in
  `invalidMessage`, and list both reasons in the README's verify answers.
- Keep upstream's reason for every other simulation failure.
- Out of scope: the buyer-side SDK step that asks the user to add a trustline. SDK helpers are M2.

## Acceptance Criteria

- [ ] Given a payment in a classic asset's SAC to a `payTo` without a trustline, when `/verify`
      runs, then it answers `isValid: false` with the `payTo` trustline reason, naming the account
      and the asset, and a test covers it
- [ ] Given a payer without a trustline to that asset, when `/verify` runs, then it answers with
      the payer trustline reason, and a test covers it
- [ ] Given a simulation that fails for any other reason, when `/verify` runs, then the answer is
      upstream's `invalid_exact_stellar_payload_simulation_failed` as before
- [ ] Given both trustline cases on testnet, when they are run once, then the answers are recorded
      in this task
