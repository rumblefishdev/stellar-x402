---
title: "Decision: immutable contract, no admin"
type: synthesis
status: mature
tags: [upto, decision, upgradeability]
links: []
history:
  - date: "2026-09-30"
    status: mature
    who: okarcz
    note: "Chosen by okarcz"
    spawned_from: ["notes/I-section-6-2-review-findings.md"]
---

# Decision: immutable contract, no admin

## Conclusion

The contract has no constructor arguments, no admin, no `upgrade` entry point and no pause. The
only state is the nonce entries.

## Reasoning

1. Clients sign against a specific proxy address. An admin who could change the code would be able
   to redirect every open authorization.
2. The contract is small and holds no funds. To fix a bug, deploy a new address; facilitators
   switch through `/supported`, and old authorizations expire within minutes.
3. The EVM reference is also a fixed CREATE2 deployment.

## Consequences

- Every bug fix is a new canonical address, so the `scheme_upto_stellar.md` spec must say how the
  canonical address is published and versioned.
- Interface choices, such as whether to support cancellation, must be settled before the mainnet
  deployment.
