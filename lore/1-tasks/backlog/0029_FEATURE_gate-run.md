---
id: "0029"
title: "Gate run against our testnet facilitator"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0009"]
related_tasks: ["0012", "0028", "0026", "0009", "0020", "0059"]
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
- Related tasks: 0028, 0026, 0009, 0020.
- The gate is pinned to upstream `10b2d06`. By 2026-10-22 upstream main was 63 commits ahead: the e2e harness unchanged, but the Stellar mechanism changed (client `exact` scheme, facilitator settle errors, typed simulation errors, x402-foundation/x402#3293, #2975). Decide whether to bump the pin before the run of record; a bump means a fresh gate run. 0059 (raw result file, signals, ledger check) should land first.
- `/supported` (0020) must list `exact` on `stellar:testnet` with `extra.areFeesSponsored: true`: the canonical client throws without it (found in the 0028 recon).
- From the 0028 review: the gate also needs `/supported` to list the facilitator key under a `stellar:` signer, because it fails any settlement whose fee another account paid.
- From the 0028 review: the saved run holds the upstream commit, date, facilitator URL, its signers and each transaction, but no facilitator version; the facilitator has to expose one for this task's results.
- From 0053: the catalog now takes the suite's `http://localhost:<port>/…` and
  `mcp://tool/<name>` URLs, so a run against the public testnet facilitator leaves about 18 such
  entries in its durable catalog (one key per server and route, refreshed by each run; nothing
  deletes them), and 0042's demo lists them. The suite's Bazaar check still waits for
  `/discovery/search` (0028). Nothing owns removing them yet: decide before the first run whether
  the gate uses a separate catalog, or the catalog gets a TTL or an admin delete (0053 review).
- From the 0028 review: the first criterion says "verify → settle" for each scenario, but the 9 `upfront` scenarios settle without a `/verify` (answered in 0028); reword it before starting.

## Implementation

- Run the 0028 harness against the deployed facilitator.
- Commit results; triage failures into lane tasks; rerun on the final build.

## Acceptance Criteria

- [ ] Given our facilitator deployed at its public URL (0026), when the gate runs, then the canonical client completes `exact` verify → settle for each Stellar scenario and every run records a real transaction hash
- [ ] Given a finished run, when results are saved, then `conformance/results/` gets the run JSON with the upstream commit, the date, our facilitator version and the transaction hashes
- [ ] Given a failing scenario, when it is analysed, then a backlog task is created for the owning lane
- [ ] Given the finished T1 build, including Bazaar and spend budgets, when the gate reruns, then it passes and the final results are committed
