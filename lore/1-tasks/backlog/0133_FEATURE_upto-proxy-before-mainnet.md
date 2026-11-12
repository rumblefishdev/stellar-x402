---
id: "0133"
title: "Settle what ADR 0010 leaves open for UptoProxy before mainnet, and describe the contract for the audit"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0010"]
related_tasks: ["0003", "0034", "0035", "0015", "0109", "0121"]
tags: [upto, contracts, mainnet, audit, priority-medium, effort-medium, payments]
links:
  - ../../../docs/adr/0010-upto-proxy-design.md
  - ../../../contracts/upto-proxy/README.md
  - ../../../docs/threat-model.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan: mainnet is prepared in M2 and launched in M3,
      and the audit that starts in M2 (0121) needs the contract's scope.
---

# Settle what ADR 0010 leaves open for UptoProxy before mainnet, and describe the contract for the audit

## Summary

As the team that will deploy `UptoProxy` to mainnet, we want the points ADR 0010 put off "before
the mainnet deployment" decided, and the contract described for the auditor, so the audit reviews
the contract we will deploy.

## Context

- ADR 0010 leaves three things for later:
  - **`cancel(from, nonce)`**: rejected for v1, "it would have to be added before the mainnet
    deployment".
  - **The TTL cap's margin under the fee ceiling**: it depends on the rent rate and on rent the
    token charges in the same settlement, and "must be checked again before mainnet".
  - **The protocol version**: `extend_ttl_with_limits` needs protocol 26 or later.
- There is no mainnet deployment yet (`contracts/upto-proxy/README.md`).
- The audit engagement starts in M2 (0121). The maintainers of the upstream scheme may also ask
  for an audit of the contract before they merge it (0034).
- A change to the contract's interface changes `scheme_upto_stellar.md`, which is under review
  upstream (0034), so a decision to add `cancel` has to reach that review.

## Implementation Plan

- Decide `cancel` for mainnet: add it, or record in ADR 0010 why mainnet ships without it.
- Measure the TTL extension's cost against the fee ceiling at mainnet's rent rate, with a token
  that extends itself in the same settlement.
- Check the protocol version on mainnet against what the contract needs.
- Write the audit scope for the contract: entry points, storage, trust assumptions, the threat
  model's `upto` section, the testnet report, known limits.

## Acceptance Criteria

- [ ] ADR 0010 records the decision on `cancel` for mainnet with its reason; if it is added, the
      contract, its tests and the spec draft carry it
- [ ] Given mainnet's rent rate, when a settlement extends the proxy's TTL together with a token's
      instance, then its measured fee is under the `upto` fee ceiling, and the numbers are recorded
- [ ] The protocol version the contract needs is checked against mainnet's and recorded
- [ ] The audit scope for `UptoProxy` is written and handed to 0121
