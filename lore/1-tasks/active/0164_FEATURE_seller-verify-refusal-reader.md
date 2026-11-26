---
id: "0164"
title: "Tell the seller why /verify refused a payment: a refusal reader in @stellar-x402/sdk/seller"
type: FEATURE
status: active
owner: akot
milestone: 2
related_adr: []
related_tasks: ["0094", "0102", "0107", "0078"]
tags: [sdk, seller, payments, priority-medium, effort-small]
links:
  - ../archive/0094_RESEARCH_tell-seller-about-missing-trustline/notes/S-recommendation.md
  - ../archive/0094_RESEARCH_tell-seller-about-missing-trustline/notes/R-what-the-seller-sees.md
history:
  - date: "2026-11-26"
    status: backlog
    who: akot
    note: >
      Spawned from 0094's recommendation: a refusal that reaches /verify never reaches the
      seller's log, and pay_to_balance_missing (0107) does reach it with upstream's client.
  - date: "2026-11-26"
    status: active
    who: akot
    note: "Started after 0094 closed."
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

- [x] Given an `onAfterVerify` result with `isValid: false` and a seller-side reason, when it is
      read, then the answer has the reason, the bounded message and says the seller must act, and
      a test covers each of the two reasons (`seller.test.ts`, "marks a refusal the seller must act
      on"; on testnet, `readerMarksSellerFix`)
- [x] Given a valid result, or a refusal of another reason, when it is read, then the answer says
      so without marking it the seller's, and a test covers both ("reads a valid payment as no
      refusal", "reads a refusal that is not the seller's", "reads … as unknown")
- [x] Given a message too long or with control characters, when it is read, then what comes back is
      bounded and printable, and a test covers it ("keeps a message to one printable line", "cuts
      a long message to 500 characters", "leaves out a message that is empty once cleaned")
- [x] Given the example seller and a refused payment, when `/verify` refuses it, then the seller's
      log names the reason and the message (unit test with a fake facilitator) (`app.test.ts`,
      "logs a refused payment, …", both kinds; it fails with the hook taken out)
- [x] The example's comment and README say when a missing trustline is refused, as 0094 found

## Implementation Notes

- `packages/sdk/src/seller/refusal.ts`: `readVerifyRefusal`, `VerifyRefusal`,
  `REFUSAL_MESSAGE_CHARS` (500), exported from `/seller`. 11 tests in `test/seller.test.ts`; the
  SDK has 80.
- `examples/http-api/src/app.ts`: an `onAfterVerify` hook logs each refusal through `log`, the
  seller's own with "fix this on your side". 3 tests in `test/app.test.ts`; the example has 24.
  `src/index.ts` and the README now say a missing trustline stops the buyer before signing.
- `packages/sdk/README.md`: the reader, the hook to use it in, and a "before your first sale"
  paragraph with Horizon for sellers outside TypeScript.
- `apps/facilitator/test/live/payto-trustline-missing.ts` records what the reader reads in the
  seller's hook as `refusalsRead`, apart from the seller's log, which stays the 0094 finding.
- Testnet, 2026-11-26: the live script at 14:23 UTC, 8 checks passed, both real refusals read as
  `sellerMustAct` with the account named. The MCP e2e at 14:27 UTC on this branch (the example
  seller with the hook): 28 scenarios, 132 rows, none failed; its results file was restored, not
  committed.

## Design Decisions

### Emerged

1. **Every refusal is read, and `sellerMustAct` tells the seller's apart**, not a reader of the two
   seller reasons only: a buyer's refusal is still news to a seller (a client that keeps failing),
   and the caller chooses what to log.
2. **The message is cleaned, not refused**: control and format characters (`\p{Cc}`, `\p{Cf}`,
   which covers bidi overrides) become spaces, spaces are collapsed, and it is cut to 500 with
   `…`. A reason outside `^[a-z0-9_]{1,80}$` is `unknown`, as `readCatalogAnswer` does with its
   own.
3. **One `log` in the example, a prefix for the seller's refusals**: the plan said a warning for
   them and a plain line for the rest, which needs a second option on `SellerConfig`. The words
   "fix this on your side" tell them apart in one stream.
4. **The example logs the buyer's refusals too**: each needs a signed payment the facilitator
   checks, so a buyer can't fill the log faster than it already loads the facilitator.
5. **The live script keeps the seller's log as upstream alone and records the reader apart**, so
   0094's finding (an empty seller log) still holds in the same file. The results file now holds
   the 14:23 run; the 13:49 one is in commit 977abf15.
