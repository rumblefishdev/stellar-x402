---
id: "0092"
title: "Tell the SDK's user about a missing trustline before signing"
type: FEATURE
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0078"]
tags: [sdk, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-30"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0078's code review: upstream's client refuses a payment with a missing
      trustline before it reaches /verify, so 0078's answers can't help its users.
---

# Tell the SDK's user about a missing trustline before signing

## Summary

As a buyer or a seller testing with a fresh wallet on upstream's client, I want a clear error that
names the account and the asset when a trustline is missing, so that I know to add it. Today I get
a raw `HostError`.

## Context

- 0078 names a missing trustline in `/verify`'s answer, but upstream's
  `ExactStellarScheme.createPaymentPayload` simulates before it signs and throws
  `Stellar simulation failed with error message: HostError: Error(Contract, #13)`. Its users never
  reach `/verify`.
- The panel review response (§5, "Trustline onboarding") promises an actionable error before
  payment is attempted. For upstream's client that holds only once this task is done (0078
  decision 10).
- `apps/facilitator/src/settlement/trustline.ts` shows how to read the account and the asset from
  the SAC's `#13` event.
- `packages/sdk` has no trustline handling yet.

## Implementation

- Decide how the SDK finds the cause: catch upstream's client error, or simulate first itself.
- Throw an error that names the account, the asset and what to do.
- Decide whether the SDK offers to add the trustline, or only reports it.

## Acceptance Criteria

- [ ] Given a payer with no trustline to a classic asset, when the SDK builds the payment, then its
      error names the account and the asset, and a test covers it
- [ ] Given a `payTo` with no trustline, when the SDK builds the payment, then its error names that
      account and the asset, and a test covers it
- [ ] Given any other simulation failure, when the SDK builds the payment, then the error is
      unchanged
