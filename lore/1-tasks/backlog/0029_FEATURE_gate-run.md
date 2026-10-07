---
id: "0029"
title: "Gate run against our testnet facilitator"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0009"]
related_tasks: ["0012", "0028", "0026", "0009"]
tags: [conformance, e2e, priority-high, effort-small, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 3.2 (Platform lane)."
---

# Gate run against our testnet facilitator

## Summary

As a reviewer of the grant, I want e2e results with real settled transaction hashes committed to the repo, so that the T1 exit criterion is met and can be checked by anyone.

**Story:** [M1 Story 3.2](../../../docs/planning/m1-epics.md#story-32-gate-run-against-our-testnet-facilitator) · **Lane:** Platform · **Covers:** FR21 (AD-13, AD-15)

## Context

- First run around day 12, final rerun at the end of T1.
- Related tasks: 0028, 0026, 0009.

## Implementation

- Run the 0028 harness against the deployed facilitator.
- Commit results; triage failures into lane tasks; rerun on the final build.

## Acceptance Criteria

- [ ] Given our facilitator deployed at its public URL (0026), when the gate runs, then the canonical client completes `exact` verify → settle for each Stellar scenario and every run records a real transaction hash
- [ ] Given a finished run, when results are saved, then `conformance/results/` gets the run JSON with the upstream commit, the date, our facilitator version and the transaction hashes
- [ ] Given a failing scenario, when it is analysed, then a backlog task is created for the owning lane
- [ ] Given the finished T1 build, including Bazaar and spend budgets, when the gate reruns, then it passes and the final results are committed
