---
id: "0005"
title: "Document UptoProxy: design ADR, contract docs, threat model and testnet report"
type: DOCS
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0002", "0003", "0004"]
tags: [layer-contracts, upto, priority-medium, effort-small]
links: []
history:
  - date: "2026-09-30"
    status: backlog
    who: claude
    note: "Task created with okarcz. Starts after 0004."
---

# Document UptoProxy: design ADR, contract docs, threat model and testnet report

## Summary

Write up the result of 0002–0004 so that three groups can use it without reading the code: the
reviewers and auditors, the facilitator team, and the future `scheme_upto_stellar.md` author.

## Status: Backlog

> Blocked by 0004.

## Implementation Plan

1. **ADR** `docs/adr/0003-upto-proxy-design.md`: the design decisions from 0002's S- notes, and
   every deviation from arch doc §6.2 with its reason.
2. **Contract README** `contracts/upto-proxy/README.md`: the interface, the signed payload, the
   auth tree a client must sign, errors, events and invariants, and how a facilitator builds,
   verifies and settles a transaction.
3. **Threat model**: fill in the `upto` contract section of `docs/threat-model.md` (front-running,
   leftover allowance, replay, token or recipient substitution, malicious token contract, and
   fee griefing).
4. **Testnet report** `docs/upto-proxy-testnet-report.md`: the contract ID, WASM hash, scenario
   table with transaction hashes and links, cost per settlement, and known limits.
5. **Spec input**: a short list of the rules `scheme_upto_stellar.md` needs. Writing the upstream
   spec itself is a separate, later task.

The source RFP and architecture docs in `docs/rfp/` are left unchanged. Deviations go in the ADR.

## Acceptance Criteria

- [ ] The ADR, contract README, threat-model section and testnet report are written
- [ ] Every transaction hash in the report resolves on stellar.expert
- [ ] `format:check` passes
