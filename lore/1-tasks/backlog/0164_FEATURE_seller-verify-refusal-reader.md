---
id: "0164"
title: "Tell the seller why /verify refused a payment: a refusal reader in @stellar-x402/sdk/seller"
type: FEATURE
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0094", "0102", "0107", "0078"]
tags: [sdk, seller, payments, priority-medium, effort-small]
links:
  - ../active/0094_RESEARCH_tell-seller-about-missing-trustline/notes/S-recommendation.md
  - ../active/0094_RESEARCH_tell-seller-about-missing-trustline/notes/R-what-the-seller-sees.md
history:
  - date: "2026-11-26"
    status: backlog
    who: akot
    note: >
      Spawned from 0094's recommendation: a refusal that reaches /verify never reaches the
      seller's log, and pay_to_balance_missing (0107) does reach it with upstream's client.
---

# Tell the seller why /verify refused a payment: a refusal reader in @stellar-x402/sdk/seller

## Summary

As a seller, I want my server's log to say why the facilitator refused a buyer's payment, with what
I need to fix, so that I learn about a problem on my side, such as a `payTo` without a trustline
or without a first balance, from my own log and not from buyers.

## Context

- Upstream's resource server answers a `/verify` refusal with a 402 carrying `invalidReason` alone.
  It drops `invalidMessage` and logs nothing. Only an `onAfterVerify` hook sees the full result;
  `onVerifyFailure` doesn't run for `isValid: false` (0094 R-what-the-seller-sees, with lines in
  `@x402/core` 2.31).
- Two refusals ask the seller to act:
  - `invalid_exact_stellar_pay_to_balance_missing` (0107): upstream's client signs it and our
    `/verify` refuses it (testnet run of 2026-11-24);
  - `invalid_exact_stellar_payto_trustline_missing` (0078): only when `payTo` loses the trustline
    after signing, or with a client that doesn't simulate.
- `readCatalogAnswer` (0102) is the model: a function over the hook's `result`, a bounded reason,
  and the example logs it.
- `examples/http-api` says a missing trustline is refused "at settlement, after the buyer signed"
  (`src/index.ts:9-10`, README). With upstream's client it is refused before signing; otherwise at
  `/verify`.

## Implementation

- `readVerifyRefusal(result)` in `/seller`, to be called from `onAfterVerify`:
  - `none` for a valid payment;
  - otherwise the reason, whether it is the seller's to fix (the two reasons above), and the
    message;
  - The message comes from whatever facilitator is configured: bound its length and keep it
    printable. A reason outside `^[a-z_]{1,80}$` becomes `unknown`.
- The example registers the hook and logs a seller-side refusal as a warning and any other as a
  plain line. Fix the sentence about when a missing trustline is refused.
- SDK README:
  - the reader;
  - a "before your first sale" paragraph pointing at `checkTrustline`;
  - that `onVerifyFailure` doesn't see a refusal.
- Out of scope: logging in upstream's middleware itself, and the seller guide (0075).

## Acceptance Criteria

- [ ] Given an `onAfterVerify` result with `isValid: false` and a seller-side reason, when it is
      read, then the answer has the reason, the bounded message and says the seller must act, and
      a test covers each of the two reasons
- [ ] Given a valid result, or a refusal of another reason, when it is read, then the answer says
      so without marking it the seller's, and a test covers both
- [ ] Given a message too long or with control characters, when it is read, then what comes back is
      bounded and printable, and a test covers it
- [ ] Given the example seller and a refused payment, when `/verify` refuses it, then the seller's
      log names the reason and the message (unit test with a fake facilitator)
- [ ] The example's comment and README say when a missing trustline is refused, as 0094 found
