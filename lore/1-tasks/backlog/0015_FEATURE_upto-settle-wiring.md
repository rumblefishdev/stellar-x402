---
id: "0015"
title: "Wire upto settlement into the facilitator's /settle (post-T1)"
type: FEATURE
status: backlog
related_adr: ["0003", "0005", "0006"]
related_tasks: ["0009", "0004", "0005", "0012", "0035"]
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
  - date: "2026-10-09"
    status: backlog
    who: claude
    note: >
      Added the upto /verify rules from the 0035 security review: the allowance window bound
      (fee inflation by rent), the signature-expiry match, from != facilitator, the token from
      the requirements. related_tasks += 0035.
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

- **`/verify` for `upto`**, the rules in the contract README's "Facilitator guide › Verify".
  The 0035 security review found that today only the e2e suite's `checkClientAuth` enforces
  them, and the threat model relies on them. Refuse:
  - `allowance_expiration_ledger` past `latestLedger + ceil(maxTimeoutSeconds / closeTime)` plus a
    small margin. The payer picks it and the facilitator pays temporary rent on the nonce and the
    allowance until then, about 1.3 stroops per ledger on testnet; the furthest the network
    allows is 3.9 million stroops, refused by the fee ceiling after the seller has served. The
    contract caps it at 17,280 ledgers (ADR 0010, D11) only as a backstop.
  - a `signatureExpirationLedger` that differs from `allowance_expiration_ledger`;
  - `from` equal to the facilitator's address (the host refuses it on chain anyway);
  - a `token` other than the requirements' asset; take it from the requirements, never the
    payload, and check balance changes in the simulation, not only events (a no-op token
    "settles" with an event and no transfer).
  - Port `checkClientAuth` and its e2e scenarios ("facilitator refuses an allowance that outlives
    the window", "... a signature expiry that differs") as unit tests.
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
- [ ] `/verify` refuses an `upto` allowance that outlives the payment window, a signature expiry
      that differs from it, `from` equal to the facilitator, and a token other than the asset
- [ ] `/supported` lists `upto` on testnet
