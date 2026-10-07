---
id: "0012"
title: "Plan Milestone 1 (M1) with BMAD and turn it into lore tasks"
type: DOCS
status: active
milestone: 1
related_adr: []
related_tasks: ["0004", "0005", "0009", "0010", "0011"]
tags: [planning, bmad, milestone-1, priority-high, effort-medium]
links:
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
  - ../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Task created with okarcz. First task run with the BMAD + lore workflow."
  - date: "2026-10-07"
    status: active
    who: okarcz
    note: "Started."
---

# Plan Milestone 1 (M1) with BMAD and turn it into lore tasks

## Summary

Write the M1 plan with BMAD (PRD, architecture, epics and stories), then turn it into lore: the
key decisions become ADRs and each story becomes one lore backlog task. This is also the first
run of the BMAD + lore workflow, so the task records that workflow in `CLAUDE.md`.

## Context

- M1 work so far: the UptoProxy tasks (0002, 0003 done; 0004, 0005 in backlog), the scaling
  research (0006) and the settlement submitter (0007). Open follow-ups: 0009, 0010, 0011.
- The RFP (`docs/rfp/`) lists the deliverables, but M1's exact scope isn't written down yet.
- Roles: BMAD plans *what and why*; lore owns the backlog, decisions and commits. The full
  mapping is the `BMAD + Lore` section this task adds to `CLAUDE.md`.

## Implementation Plan

### Step 1: Set up BMAD

- Add the `BMAD + Lore` section to `CLAUDE.md`.
- Run `/bmad-toolbox:bmad setup`. Decide whether `_bmad/` and `_bmad-output/` are committed or
  git-ignored.

### Step 2: Plan M1 (BMAD)

- Agree on the M1 scope with okarcz, starting from the RFP deliverables and the work done so far.
- `bmad-prd` from `docs/rfp/` and existing docs (brownfield, not from scratch).
- `bmad-architecture` from the existing codebase.

### Step 3: Decisions → ADRs

- Each significant architecture decision gets an ADR in `docs/adr/` that links the BMAD
  document.

### Step 4: Stories → lore tasks

- `bmad-create-epics-and-stories` for M1.
- One lore backlog task per story: link the story file, copy its acceptance criteria.
- Reconcile with the existing backlog (0004, 0005, 0009–0011): reuse, update or close, so no
  story is duplicated.
- Regenerate the index.

## Acceptance Criteria

- [ ] `CLAUDE.md` has the `BMAD + Lore` section
- [ ] BMAD set up; commit/ignore decision for `_bmad/` and `_bmad-output/` recorded
- [ ] M1 scope agreed and written down in the PRD
- [ ] Architecture document for M1; its key decisions recorded as ADRs
- [ ] M1 epics and stories exist, and each story has a lore backlog task linking it
- [ ] Existing backlog reconciled with the plan; index regenerated
