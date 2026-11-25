---
id: "0092"
title: "Tell a buyer about a missing trustline before signing, in the SDK and MCP"
type: FEATURE
status: active
owner: akot
milestone: 2
related_adr: []
related_tasks: ["0078", "0145", "0102", "0094"]
tags: [sdk, mcp, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-30"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0078's code review: upstream's client refuses a payment with a missing
      trustline before it reaches /verify, so 0078's answers can't help its users.
  - date: "2026-10-30"
    status: backlog
    who: okarcz
    note: >
      Moved from M2 to M1 and packages/mcp added (Adam's review of #94): upstream 2.29.0 throws
      TrustlineMissingError, and MCP answers a seller's missing trustline with insufficient_funds.
  - date: "2026-11-16"
    status: backlog
    who: okarcz
    note: >
      Moved to M2 by okarcz in the M1 Payments cleanup: not started, and M1 is closing.
  - date: "2026-11-25"
    status: active
    who: akot
    note: >
      Started with the MCP part: `pay.ts` tells a missing trustline from a low balance by the
      error's type. The SDK criteria follow in 0102, whose buyer helper carries the same codes.
---

# Tell a buyer about a missing trustline before signing, in the SDK and MCP

## Summary

As a buyer or a seller testing with a fresh wallet on upstream's client, I want a clear error that
names the account and the asset when a trustline is missing, so that I know to add it. Today I get
a raw `HostError`, and from MCP a message that my funds are low, even when the seller's trustline
is the one missing.

## Context

- 0078 names a missing trustline in `/verify`'s answer, but upstream's
  `ExactStellarScheme.createPaymentPayload` simulates before it signs, so its users never reach
  `/verify`.
- Since 0145 every `@x402/*` package is on `~2.31.0`. There `@x402/stellar` throws
  `TrustlineMissingError` (a `SimulationFailedError` with `account` and `asset`, for the payer or
  the `payTo`) and `InsufficientBalanceError`; the message is "Stellar trustline is missing for
  account … and asset …: <raw RPC error>", so it still holds `Error(Contract, #13)`.
- **Where the typed error survives** (checked 2026-11-18 in the 2.31 `dist`): `@x402/fetch`'s
  `wrapFetchWithPayment` rewraps it as a plain
  `Error("Failed to create payment payload: <message>")`, so a caller catching the fetch's error
  loses the type and its fields. `x402Client`'s `onPaymentCreationFailure` hook gets the original
  error first; `pay.ts` keeps it there as `signingError` (`:167-168`), so the MCP can tell the two
  errors by type today.
- `apps/mcp-local/src/pay.ts:212-219` maps `#10` and `#13` alike to `insufficient_funds`, so a
  missing trustline, a seller's too, reads as "The payer does not hold enough of the asset."
  `test/pay.test.ts:360` (`NO_TRUSTLINE` → `insufficient_funds`) and the testnet e2e E-14
  (`e2e/test/after-signing.ts`) pin that today and change with this task.
- The panel review response (§5, "Trustline onboarding") promises an actionable error before
  payment is attempted. For upstream's client that holds only once this task is done (0078
  decision 10).
- `apps/facilitator/src/settlement/trustline.ts` shows how to read the account and the asset from
  the SAC's `#13` event.
- `packages/sdk` holds only the Rust seller crate (`packages/sdk/rust`, 0136); the TypeScript
  helpers are 0102's, so the SDK criteria wait for it. The MCP criteria can be done now.

## Implementation

- MCP: tell a missing trustline from a low balance by the type of `signingError`
  (`TrustlineMissingError`, `InsufficientBalanceError`), not the `#10|#13` regex.
- Catch `TrustlineMissingError` in the TypeScript SDK once 0102 has created it; an SDK helper
  built on `wrapFetchWithPayment` needs the same hook, since the fetch's own error is rewrapped.
- Throw an error that names the account, the asset and what to do; MCP gets a result of its own,
  not `insufficient_funds`.
- Decide whether the SDK offers to add the trustline, or only reports it. Decided: decision 1
  below.

## Acceptance Criteria

- [ ] Given a payer with no trustline to a classic asset, when the SDK builds the payment, then its
      error names the account and the asset, and a test covers it
- [ ] Given a `payTo` with no trustline, when the SDK builds the payment, then its error names that
      account and the asset, and a test covers it
- [x] Given a missing trustline, the payer's or `payTo`'s, when MCP's `pay` fails, then its result
      names that account and the asset, not `insufficient_funds`, and a test covers it
      (`pay.test.ts`, "when signing fails for a payer without the trustline" and "a seller without
      the trustline"; on testnet E-14 and E-14d)
- [x] Given a balance too low (`#10`), when MCP's `pay` fails, then it still answers
      `insufficient_funds` (`pay.test.ts`, "a payer with too little"; on testnet E-14b)
- [ ] Given any other simulation failure, when the SDK builds the payment, then the error is
      unchanged

## Implementation Notes

The MCP part, in `apps/mcp-local`:

- `src/pay.ts`: `signingFailure` reads the type of the error `onPaymentCreationFailure` kept.
  `TrustlineMissingError` is `payer_trustline_missing` or `payto_trustline_missing`, by whose
  account it names; `InsufficientBalanceError` is `insufficient_funds`; anything else is
  `payment_failed`. The `#10|#13` regex is gone. `paid` keeps the offer's `payTo` to tell the two.
- `src/results.ts`: the two codes. `README.md`: their rows in the codes table.
- `test/fake-seller.ts`: `noTrustline` and `tooLittle` throw upstream's typed errors, where
  `NO_TRUSTLINE` was a string; the seller's `payTo` and the buyer are addresses in shape.
- `test/pay.test.ts`: the signing-failure table grows from three rows to seven.
- `e2e/test/after-signing.ts`: E-14 expects `payer_trustline_missing` with the account and the
  asset named; E-14d is new, a seller whose `payTo` has no trustline.

Testnet run on 2026-11-25, on commit c1c4df80: 26 scenarios, 124 rows, none failed. Run again after
the rebase onto 0137's search tool (#245), on commit 50a59216 (`e2e/results/testnet-results.json`):
27 scenarios, 128 rows, none failed. Both times E-14 (the payer's trustline), E-14b (a balance too
low) and E-14d (the seller's trustline) each got their code from the real `ExactStellarScheme`, with
the account and the asset in the tool's text and the RPC's text in the log only.

The SDK criteria (1, 2 and 5) are built with 0102's buyer helper, which moves this code.

## Design Decisions

### From Plan

1. **The SDK only reports a missing trustline; it doesn't add one** (akot, 2026-11-25, 0102's
   survey note, decision 8). Upstream simulates before it signs, which is the panel review's
   "pre-flight simulation step"; adding a trustline needs XLM, which the project's buyers need
   not hold, and a `payTo`'s only the seller can add.
2. **The codes are `payer_trustline_missing` and `payto_trustline_missing`** (akot, 2026-11-25,
   the same note, decision 6), after the facilitator's refusals in
   `apps/facilitator/src/settlement/trustline.ts`. The SDK's error carries the same two.

### Emerged

3. **A simulation upstream could not name is `payment_failed`, not read from its text.** Upstream
   throws the typed errors only when the RPC sends the contract's diagnostic events; without them
   it is a plain `SimulationFailedError` with `#10` or `#13` in its text. The task says to tell by
   type, so no regex stays as a second way: such a failure used to read `insufficient_funds` and
   now reads `payment_failed`, with the cause in the log. Testnet's public RPC sends the events:
   E-14, E-14b and E-14d got the typed errors on 2026-11-25.
4. **The account and the asset reach the agent only in an address's shape.** The message is what a
   model reads. Upstream takes both from the simulation, but `PaymentConfig.schemes` takes any
   scheme, so a `TrustlineMissingError` whose fields are other text is `payment_failed`.
5. **A trustline missing on an account that is neither the payer nor the offer's `payTo` is
   `payment_failed`**, as the facilitator's lookup answers nothing for it.
6. **The payer's message says the seller's account was not checked**, as the facilitator's does:
   the asset contract stops at its first failure, the payer's side first.
