---
id: "0121"
title: "Security review of the facilitator before mainnet, and its report"
type: DOCS
status: backlog
milestone: 2
related_adr: ["0007", "0013"]
related_tasks: ["0105", "0048"]
tags: [security, mainnet, priority-medium, effort-large]
links:
  - ../../../docs/security/README.md
  - ../../../docs/threat-model.md
history:
  - date: "2026-11-06"
    status: backlog
    who: karolkow
    note: >
      An RFP requirement with no task until now: the M1 plan leaves the security review report
      out of Tranche 1, and no later task held it.
---

# Security review of the facilitator before mainnet, and its report

## Summary

As the grant's reviewer, I want a security review of the facilitator and a report with its
findings resolved, so that mainnet opens only on code someone has tried to break.

## Context

- The RFP requires a "Security review before mainnet production" and lists a "Security review
  report with resolved findings" as a deliverable (`docs/rfp/07-x402-facilitator-bazaar.md`).
- `docs/planning/m1-epics.md` puts the report out of Tranche 1.
- `docs/security/README.md` plans one review of the facilitator before mainnet and one of the
  `UptoProxy` contract. `docs/threat-model.md` still lists catalog integrity, auth-entry
  validation, SSRF in Bazaar metadata and API key abuse as planned.

## Implementation

- Decide with the owner who reviews (an outside firm, another team, or us) and what it may cost.
- Finish the planned sections of the threat model; the review starts from it.
- The review, the fixes, and the report in `docs/security/`.

## Acceptance Criteria

- [ ] Given the review, when it ends, then `docs/security/` holds its report, each finding with
      its fix or the reason it was accepted
- [ ] Given open findings, when mainnet would open, then the config's pubnet refusal waits for them
