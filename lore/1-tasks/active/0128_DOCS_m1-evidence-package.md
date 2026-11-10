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

- **Scope:** the five T1 items in `docs/planning/m1-epics.md` (Overview, "T1 scope"). Neither the
  RFP (`docs/rfp/07-x402-facilitator-bazaar.md`) nor the proposal
  (`rumblefishdev/stellar-scf-submissions`, `x402-facilitator-bazaar-technical-architecture-after-review.md`,
  revised 2026-10-12) has a tranche plan; the Prices API's proposal had one (§9). Asked Marek on
  2026-11-09 whether the SCF form has Tranche 1 deliverables; until he answers, the package
  documents the five items.
- **SCF's rules** (handbook, Budget & Deliverable Guidelines): Tranche #1 is 20% of the award; the
  form comes by email with the Tranche #0 payment; it is due within 90 days of the previous
  payment; a scope change is told to SCF before the submission.
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

- Does the SCF form list Tranche 1 deliverables (Marek)? Field 1 must match them word for word.
- When was Tranche #0 paid, and who has the Tranche Completion Form's email?
- The proposal re-audits the dependency tree's licenses "at each delivery milestone" (§3.3): the
  package needs that audit's output.

## Acceptance Criteria

- [ ] `docs/scf/` holds the evidence document, its PDF build, the video script, the form answers
      and a README, on the five T1 items
- [ ] Every claim has a command, output, transaction hash, screenshot or code link a reviewer can
      check; what isn't claimed is said
- [ ] Scope refinements against the RFP and the proposal are named, each with its ADR or task
- [ ] Oskar has reviewed the video script before recording
- [ ] No secrets, personal names or Polish in any artifact
