---
id: "0119"
title: "Final conformance gate run on the finished T1 build, and the conformance report"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0009"]
related_tasks: ["0029", "0024", "0063"]
tags: [conformance, e2e, priority-high, effort-small, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-11-06"
    status: backlog
    who: karolkow
    note: "Moved from 0029's last criterion, so 0029 could close after its run of record; adds the RFP's conformance report."
---

# Final conformance gate run on the finished T1 build, and the conformance report

## Summary

0029 ran the gate against the deployed testnet facilitator and committed its run of record. Story
3.2 also asks for a rerun on the finished T1 build, with the Bazaar and spend budgets in, and the RFP
asks for a conformance report with the e2e results and the settled transaction hashes. This task
does both once that build is deployed.

## Context

- Waits for the T1 build: spend budgets (0024) and the catalog work (0063) deployed.
- The run of record: 2026-11-06, `conformance/results/testnet-hosted/`, 18 of 18 scenarios,
  upstream `8827cf1`, facilitator `68e778e`. How to run the gate: `conformance/README.md`.
- RFP, expected deliverables: "Conformance report with e2e results and settled transaction
  hashes" (`docs/rfp/07-x402-facilitator-bazaar.md`).
- The testnet reset scheduled for 2026-12-16 (developers.stellar.org, Networks) removes every
  transaction from the network. The gate saves each signed envelope, so a hash in the report can
  still be recomputed after it.
- The suite's Bazaar check (`--extensions=bazaar`) needs `/discovery/search`, which comes after T1
  (ADR 0009); say in the report that it did not run.

## Implementation

- Rerun the gate on the deployed T1 build; commit `results/testnet-hosted/`.
- Write the report: what ran, against which commits, the result per scenario with its hash, and
  what the suite does not cover (one good payment per scenario, no refusals, no Bazaar check).

## Acceptance Criteria

- [ ] Given the finished T1 build, including Bazaar and spend budgets, when the gate reruns, then it passes and the final results are committed
- [ ] Given the final results, when the report is written, then it lists the e2e results and the settled transaction hashes, with the upstream and facilitator commits
