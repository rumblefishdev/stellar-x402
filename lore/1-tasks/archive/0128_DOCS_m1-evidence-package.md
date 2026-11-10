---
id: "0128"
title: "M1 evidence package for SCF's Tranche 1 verification"
type: DOCS
status: completed
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
  - date: "2026-11-10"
    status: completed
    who: stkrolikiewicz
    note: >
      Closed after #165 merged and the tranche-1-evidence tag was pushed (b5b62aa6). The package:
      a 13-page evidence PDF with no TODO left, the video script, the form answers, the license
      audit and a README, with 6 screenshots. Proofs: the gate's final rerun, 18 of 18 on 5d2e26ba
      (#169, #170, #171); the token matrix, 9 of 9 checks on the same commit (#172); a
      catalog-smoke run for D3. Oskar recorded and linked the video (#173) and reviewed #165.
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

## Implementation Notes

- **#165** (merged 2026-11-10): `docs/scf/` with the evidence document, its PDF toolchain from
  the Prices API (`build-pdf.sh`, `header.typ`, `full-width-tables.lua`, `repo-links.lua`), the
  video script, the form answers, `milestone-1-license-audit.md`, `architecture.mmd` and `.png`,
  6 screenshots, and `apps/facilitator/test/live/results/catalog-smoke-testnet.json`. Oskar's
  review applied in `41d5c0b5`.
- **#172**: `token-matrix.ts` runs again (`DATABASE_URL`, `CLIENT_IP`, its own RPC from
  `RPC_URLS`) and checks two batches; its run of 2026-11-10 from `5d2e26ba` is the matrix of
  record.
- **#173** (Oskar): the recorded video and the Google Drive folder, linked from the evidence
  document and the form answers.
- **Tag `tranche-1-evidence`** on `b5b62aa6`: every repository link in the PDF (51) and in
  Field 3 (5) points at it; 18 permalinks to the tests stay on `da93723a`.

## Issues Encountered

- **The token matrix didn't start.** `main()` requires `DATABASE_URL` and `CLIENT_IP` since the
  stores became PostgreSQL only; the other live scripts had both, this one didn't. Fixed in #172.
- **SDF's testnet RPC was slow** (7–9 s and timeouts on 2026-11-09 and 10): the first
  catalog-smoke run got 402 on every step, and two token matrix runs stopped. The runs of record
  use gateway.fm first, as production does.
- **One payer's batch can't share a ledger any more.** Since 0024 (ADR 0007) a payer has one
  settlement in flight per asset, so the matrix's old one-buyer batch settled one per ledger. Not
  a regression: #172 checks that, and a six-buyer batch shows the channels sharing a ledger.
- **A task ID taken twice.** 0127 was taken by Oskar minutes earlier; this task became 0128.

## Design Decisions

### From Plan

1. **Modeled on the Prices API's and Soroban scan's `docs/scf/`**: evidence document and PDF
   (pandoc + typst), video script, form answers, README.
2. **Scope is Tranche #1 as approved**: the Panel Review response's four line items (§1) and
   its conformance bar (§4), the same as `m1-epics.md`'s T1 scope; Field 1 quotes them.
3. **One run, one set of numbers**: the PDF, the video and Field 1 quote the same gate rerun.

### Emerged

4. **D3's evidence is a local catalog-smoke run, with no demo listing on production**: the
   public catalog is empty because no seller has settled a `bazaar` payment through it yet, and
   the package says so (decided with Oskar, 2026-11-10).
5. **The token matrix runs locally from the deployed commit**: the live scripts start their own
   facilitator and can't target a URL, so `5d2e26ba`'s code stands in for the service; Field 1
   and section 5 say it was a local run (Oskar's review).
6. **A gate settlement shown in two explorers**: Soroban Scan, and stellar.expert as the
   independent one.
7. **Links pinned to a tag, not `develop`**: the results the PDF quotes are overwritten by the
   next run (the gate's after the testnet reset of 2026-12-16), so links to a branch would show
   other hashes later. The earlier packages linked `develop` or `master`.
8. **Five refinements against the proposal named in section 4**, each with its ADR or task.
   Moving the catalog from ClickHouse to PostgreSQL is a design change, not a scope change, so it
   is disclosed in the PDF and not reported to SCF separately.
9. **No checklist in the form answers**: the tag freezes the file before the last steps are done;
   the README's submission workflow holds them.
10. **The AWS account ID is cropped or masked** in the CloudWatch and Slack screenshots.

## Future Work

- **The submission itself** (not repository work): replace the PDF on Drive with the tag's
  build, watch the video for secrets, open Field 3's links in a private window, and send the form
  (README, steps 7–8; who has the form's email is the open question above).
- **A fresh gate run after the testnet reset** for the grant's final handover: 0029, "Before the
  M1 handover".
