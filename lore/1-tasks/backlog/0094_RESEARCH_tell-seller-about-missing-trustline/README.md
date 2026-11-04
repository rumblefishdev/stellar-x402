---
id: "0094"
title: "Find how a seller can learn that their payTo has no trustline"
type: RESEARCH
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0078", "0092"]
tags: [facilitator, payments, priority-low, effort-small]
links:
  - ../../archive/0078_FEATURE_missing-trustline-reason.md
  - ../0092_FEATURE_sdk-missing-trustline-step.md
history:
  - date: "2026-11-02"
    status: backlog
    who: okarcz
    note: >
      Spawned from a check of 0078 and 0092: neither tells the seller, so a seller who offers an
      asset without a trustline doesn't learn it from us.
---

# Find how a seller can learn that their payTo has no trustline

## Summary

As a seller who offers a new asset, I want to learn that my `payTo` has no trustline to it, so that
I add one before clients fail to pay me. Today nothing tells the seller. Find out what the
facilitator can do about it, and how other facilitators handle it, if any do.

## Context

- A `payTo` G-account needs a trustline to receive a classic asset, so a seller who offers a new
  asset without one can't be paid.
- 0078 answers `/verify` and `/settle` with `invalid_exact_stellar_payto_trustline_missing`, naming
  the account and the asset. That answer goes to the resource server, and the message also goes to
  the facilitator's log, which the seller can't see.
- Most payments don't get that far. Upstream's client at our `~2.28.0` pin simulates before it
  signs and throws a raw `HostError ... #13`, and `packages/mcp` answers `insufficient_funds`
  (0078, Issues Encountered). The seller sees nothing.
- 0092 gives the client a clear error before signing. It tells the client, not the seller.
- The facilitator has no way to contact a seller: it only answers calls. The seller check reads a
  seller's 402, but cataloging starts from a settled payment, and a seller without a trustline
  never gets one.

## Implementation

Answer these, and record the sources in `notes/`:

- Does upstream's resource server pass `invalidReason` and `invalidMessage` on to the client, or
  log them? What does the seller see today, for each client?
- How do other x402 facilitators and SDKs handle a seller's missing trustline, or the same problem
  on other chains, such as a missing token account on Solana? Does any of them warn the seller
  before the first payment?
- What can we do, and what does each option cost?
  - a check in the resource server's middleware, when it starts or builds its offers;
  - a facilitator route that a seller calls to check an offer;
  - a CLI or docs step for seller onboarding;
  - a check of the `payTo` in the seller's 402 during the seller check.
- Should the answer also cover a `payTo` that doesn't exist?

Out of scope: the client's error (0092), and adding a trustline for the seller, which only the
seller can sign.

Clean-room rule: no OpenZeppelin relayer code (AGPL), not even as reference. Leave its x402 plugin
out of the comparison.

## Acceptance Criteria

- [ ] What the seller sees today is recorded for each client, from the code or a testnet run
- [ ] Other facilitators and SDKs are compared in an `R-` note, with sources; if none handles it,
      the note says so
- [ ] An `S-` note gives a recommendation, with its costs, or the reason to do nothing
- [ ] Any work the recommendation needs is a backlog task
