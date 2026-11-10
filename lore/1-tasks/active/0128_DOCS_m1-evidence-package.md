---
id: "0128"
title: "M1 evidence package for SCF's Tranche 1 verification"
type: DOCS
status: active
milestone: 1
related_adr: []
related_tasks: ["0012", "0029", "0026", "0027", "0024", "0063", "0021"]
tags: [docs, scf, evidence, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
history:
  - date: "2026-11-09"
    status: active
    who: stkrolikiewicz
    note: >
      Created and started: the M1 evidence package for SCF's Tranche Completion Form, modeled on
      Soroban scan's and the Prices API's `docs/scf/`. Oskar records the video. The scope is the T1
      scope in docs/planning/m1-epics.md until Marek says whether the SCF form lists Tranche 1
      deliverables of its own.
---

# M1 evidence package for SCF's Tranche 1 verification

## Summary

SCF pays a tranche after its Build Tranche Completion Form is reviewed: a reviewer checks that
every deliverable is complete, matches its success criteria and can be verified. This task writes
the package that form points to, as Soroban scan and the Prices API did: an evidence document per
deliverable (and its PDF), a video script Oskar records from, and the form's field text.

## Context

- **Scope:** Tranche #1 as approved, in our response to the Panel Review (feedback of
  2026-09-16): the four line items of its budget (§1, "Tranche #1 — $15,600 (20%, Milestone 1,
  T0 + 4 weeks)") and the Tranche #1 conformance bar it adds (§4). They are the five items of
  `docs/planning/m1-epics.md`'s "T1 scope". Neither the RFP nor the proposal
  (`rumblefishdev/stellar-scf-submissions`, revised 2026-10-12) has a tranche plan; the response
  is not in that repository.
- **Other commitments the response makes per tranche boundary:** re-audit the dependency tree's
  licenses (§5); re-run the search ranking's nDCG@10 evaluation (§4), which starts with ranking in
  Tranche #2.
- **SCF's rules** (handbook, Budget & Deliverable Guidelines): Tranche #1 is 20% of the award; the
  form comes by email with the Tranche #0 payment; a scope change is told to SCF before the
  submission.
- **The reference packages:** `docs/scf/` in `soroban-block-explorer` and `stellar-prices-api`:
  `milestone-N-evidence.md` and its PDF (pandoc + typst), `milestone-N-video-scenario.md`,
  `milestone-N-form-answers.md`, `architecture.mmd`, `screenshots/`.
- **What waits:** the final gate run and the conformance report (0029) need the fourth production
  deploy, after 0063. The package's gate section is written against the 2026-11-06 run of record
  until then.

## Implementation Plan

1. `docs/scf/` with the PDF toolchain from the Prices API (`build-pdf.sh`, `header.typ`, the Lua
   filters, `puppeteer-config.json`).
2. `milestone-1-evidence.md`: summary, deliverable definition, architecture, scope refinements
   against the RFP and the proposal, then one section per T1 item with commands, outputs, settled
   transaction hashes, screenshots and code links; what is not claimed; live endpoints.
3. `milestone-1-video-scenario.md` for Oskar: scenes, what to have open, what never to show.
4. `milestone-1-form-answers.md`: the four fields and the pre-submission checklist.
5. `README.md`: inventory, build, submission workflow, ground rules.

## Open Questions

- Who has the Tranche Completion Form's email?

## Acceptance Criteria

- [x] `docs/scf/` holds the evidence document, its PDF build, the video script, the form answers
      and a README, on the five T1 items
- [x] Every claim has a command, output, transaction hash, screenshot or code link a reviewer can
      check; what isn't claimed is said
- [x] Scope refinements against the RFP and the proposal are named, each with its ADR or task
- [x] Oskar has reviewed the video script before recording (recorded 2026-11-10, linked in #173)
- [x] No secrets, personal names or Polish in any artifact
