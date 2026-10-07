---
id: "0015"
title: "Wire upto settlement into the facilitator's /settle (post-T1)"
type: FEATURE
status: backlog
related_adr: ["0003", "0005", "0006"]
related_tasks: ["0009", "0004", "0005", "0012"]
tags: [facilitator, signer-pool, upto, settlement, priority-medium, effort-medium, payments]
links:
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Split from 0009 by the 0012 M1 architecture spine: upto settlement in /settle comes after T1."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Tagged Payments lane by 0012 (outside T1)."
---

# Wire upto settlement into the facilitator's /settle (post-T1)

## Summary

Add `upto` to the facilitator's settlement path built in 0009 for `exact`, and advertise it in
`/supported`. In T1, `upto` is only the contract and its design (0004, 0005). This task comes
after T1.

## Context

- 0009 builds `/settle` for `exact` on the pool, including the settlement record, budgets and
  lease. `upto` reuses all of it (AD-2, AD-6, AD-16, AD-18).
- The `upto` client classes and `scheme_upto_stellar.md` go upstream later (ADR 0001); until
  then we depend on a local build.

## Implementation

- Build the `settle_upto` call from the payload and submit it through the pool (AD-2, AD-4).
- **Zero-amount `upto`:** submit nothing and return `transaction: ""`, as the spec allows.
  Document that the client's nonce stays unused until its deadline. This was 0007 step 5
  (0007 Emerged 2).
- The `deadline` comes from the client's signature expiry, with the minimum-validity check
  (AD-22).
- Advertise `upto` in `/supported` (AD-13) once it works end to end.

## Acceptance Criteria

- [ ] `/settle` settles `upto` through the pool with the same record and budget rules as `exact`
- [ ] A zero-amount `upto` settlement submits nothing
- [ ] `/supported` lists `upto` on testnet
