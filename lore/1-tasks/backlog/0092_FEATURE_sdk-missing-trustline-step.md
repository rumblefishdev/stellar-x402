---
id: "0092"
title: "Tell a buyer about a missing trustline before signing, in the SDK and MCP"
type: FEATURE
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0078"]
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
---

# Tell a buyer about a missing trustline before signing, in the SDK and MCP

## Summary

As a buyer or a seller testing with a fresh wallet on upstream's client, I want a clear error that
names the account and the asset when a trustline is missing, so that I know to add it. Today I get
a raw `HostError`, and from MCP a message that my funds are low, even when the seller's trustline
is the one missing.

## Context

- 0078 names a missing trustline in `/verify`'s answer, but upstream's
  `ExactStellarScheme.createPaymentPayload` simulates before it signs. At our `~2.28.0` pin it
  throws `Stellar simulation failed with error message: HostError: Error(Contract, #13)`, and its
  users never reach `/verify`.
- `@x402/stellar` 2.29.0 (2026-10-28) throws `TrustlineMissingError`, a `SimulationFailedError` with
  `account` and `asset`. Not checked: whether `@x402/fetch` rewraps it.
- `packages/mcp/src/pay.ts` maps `#10` and `#13` alike to `insufficient_funds`, so a missing
  trustline, a seller's too, reads as "The payer does not hold enough of the asset."
- The panel review response (§5, "Trustline onboarding") promises an actionable error before
  payment is attempted. For upstream's client that holds only once this task is done (0078
  decision 10).
- `apps/facilitator/src/settlement/trustline.ts` shows how to read the account and the asset from
  the SAC's `#13` event.
- `packages/sdk` has no trustline handling yet.

## Implementation

- Bump the `@x402/*` packages to 2.29.0, and check whether `@x402/fetch` rewraps the error.
- Catch `TrustlineMissingError` in `packages/sdk` and `packages/mcp`.
- Throw an error that names the account, the asset and what to do; MCP gets a result of its own,
  not `insufficient_funds`.
- Decide whether the SDK offers to add the trustline, or only reports it.

## Acceptance Criteria

- [ ] Given a payer with no trustline to a classic asset, when the SDK builds the payment, then its
      error names the account and the asset, and a test covers it
- [ ] Given a `payTo` with no trustline, when the SDK builds the payment, then its error names that
      account and the asset, and a test covers it
- [ ] Given a missing trustline, the payer's or `payTo`'s, when MCP's `pay` fails, then its result
      names that account and the asset, not `insufficient_funds`, and a test covers it
- [ ] Given a balance too low (`#10`), when MCP's `pay` fails, then it still answers
      `insufficient_funds`
- [ ] Given any other simulation failure, when the SDK builds the payment, then the error is
      unchanged
