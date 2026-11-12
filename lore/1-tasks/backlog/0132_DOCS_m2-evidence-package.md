---
id: "0132"
title: "M2 evidence package for SCF's Tranche 2 verification"
type: DOCS
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0128", "0120", "0034", "0102", "0121", "0135", "0136", "0137"]
tags: [scf, evidence, docs, priority-high, effort-medium, payments]
links:
  - ../../../docs/scf/README.md
  - ../../../docs/scf/milestone-1-evidence.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan. Raised in the plan's review: M1's package
      (0128) took 14 commits and the whole last day, so M2's starts in week 1.
---

# M2 evidence package for SCF's Tranche 2 verification

## Summary

As the team asking SCF for Tranche #2, we want the evidence document to grow with the work, so the
last days of the milestone go to checking it, not to writing it.

## Context

- Tranche #2 has six line items in the Panel Review response's budget (§1), 9.0 dev-weeks:
  - D1: Bazaar search and ranking engine, with its nDCG@10 evaluation (0120, 0135);
  - D2: MCP discovery server, search and paid-call tools (0042, 0068, 0085, 0137);
  - D3: `scheme_upto_stellar.md` finalized and submitted to the TSC (0034);
  - D4: SDK helpers, TypeScript (0102, 0092);
  - D5: Rust seller crate, part 1 of 2 (0136);
  - D6: security audit engagement and dev-side preparation, through the SCF Audit Bank (0121).
- Two commitments repeat at every tranche boundary (0128): the dependency licence audit (§5) and
  the nDCG@10 run (§4).
- The Panel Review response is the approved tranche plan, and it is not in this repository. The
  M1 package quotes it; M2 planning had to read it from outside the repo.
- M1's package is the pattern: `docs/scf/milestone-1-*.md`, `build-pdf.sh`, a tag for the links.

## Implementation Plan

### Step 1: Skeleton (first week of M2)

- `docs/scf/milestone-2-evidence.md` with one section per line item D1–D6, each starting from its
  done signal, and `<TODO:>` markers for the evidence.
- Add the Panel Review response to `docs/scf/`, after okarcz confirms it may be public.

### Step 2: Evidence with the work

- The pull request that finishes a line item adds its evidence to that section: transaction
  hashes, the nDCG@10 result, links.

### Step 3: Package (last week of M2)

- Licence audit at the Tranche #2 boundary, the video scenario and recording, the form answers,
  the PDF and the tag.

## Acceptance Criteria

- [ ] Given the first week of M2, when it ends, then `docs/scf/milestone-2-evidence.md` exists with
      a section and a done signal for each of D1–D6
- [ ] The Panel Review response is in `docs/scf/`, or the task records why it stays out
- [ ] Given a finished line item, when its section is read, then every claim links to evidence in
      the repo or on chain, and no `<TODO:>` marker is left
- [ ] The dependency licence audit at the Tranche #2 boundary is committed with its commands
- [ ] The nDCG@10 result of 0135 is in the document, with the query set's commit
- [ ] The video scenario, the form answers and the PDF build exist as in M1, and a tag fixes the
      document's links
