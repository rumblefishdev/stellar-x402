---
id: "0012"
title: "Plan Milestone 1 (M1) and turn it into lore tasks"
type: DOCS
status: active
milestone: 1
related_adr: ["0004", "0005", "0006", "0007", "0008", "0009"]
related_tasks: ["0004", "0005", "0009", "0010", "0011", "0013", "0014", "0015", "0016", "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025", "0026", "0027", "0028", "0029", "0030", "0031", "0032"]
tags: [planning, milestone-1, priority-high, effort-medium]
links:
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
  - ../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
  - ../../../docs/architecture/m1-spine.md
  - ../../../docs/planning/m1-epics.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Task created with okarcz."
  - date: "2026-10-07"
    status: active
    who: okarcz
    note: "Started."
  - date: "2026-10-07"
    status: active
    who: claude
    note: >
      All acceptance criteria met. Spine and ADRs 0004-0009 written; no PRD (scope is in
      docs/planning/m1-epics.md); 5 epics, 20 stories, new tasks 0013-0032; every backlog task
      tagged with its lane (payments, discovery, platform).
---

# Plan Milestone 1 (M1) and turn it into lore tasks

## Summary

Write the M1 plan (scope, architecture, epics and stories), then turn it into lore: the key
decisions become ADRs and each story becomes one lore backlog task.

## Context

- M1 work so far: the UptoProxy tasks (0002, 0003 done; 0004, 0005 in backlog), the scaling
  research (0006) and the settlement submitter (0007). Open follow-ups: 0009, 0010, 0011.
- The RFP (`docs/rfp/`) lists the deliverables, but M1's exact scope isn't written down yet.
- Lore owns the backlog, decisions and commits; the planning documents live in `docs/`.

## Implementation Plan

### Step 1: Scope

- Agree on the M1 scope with okarcz, starting from the RFP deliverables and the work done so far.

### Step 2: Architecture

- Write the M1 architecture from the RFP and the existing codebase.

### Step 3: Decisions → ADRs

- Each significant architecture decision gets an ADR in `docs/adr/` that links the architecture
  document.

### Step 4: Stories → lore tasks

- Break M1 into epics and stories.
- One lore backlog task per story: link the story, copy its acceptance criteria.
- Reconcile with the existing backlog (0004, 0005, 0009–0011): reuse, update or close, so no
  story is duplicated.
- Regenerate the index.

## Acceptance Criteria

- [x] M1 scope agreed and written down (`docs/planning/m1-epics.md`: T1 scope, "Out of T1" list,
      FR1–FR21)
- [x] Architecture document for M1 (`docs/architecture/m1-spine.md`); its key decisions recorded
      as ADRs 0004–0009
- [x] M1 epics and stories exist (`docs/planning/m1-epics.md`), and each story has a lore backlog
      task linking it (0017–0032 new; 0004, 0005, 0009, 0016 mapped)
- [x] Existing backlog reconciled with the plan; index regenerated

## Design Decisions

### From Plan

1. **Architecture decisions as ADRs**: AD-1 to AD-22 of the spine are recorded in ADRs 0004–0009
   (0003 covers AD-2).

### Emerged

2. **Planning documents live in `docs/`**: the spine in `docs/architecture/`, the epics and
   stories in `docs/planning/`, so the whole team can read and link them.
3. **No separate requirements document**: okarcz chose to take the requirements straight from
   the RFP, filtered to the agreed T1 scope. `docs/planning/m1-epics.md` holds that scope, an
   "Out of T1" list and FR1–FR21.
4. **Three lanes**: the work is split into Payments, Discovery and Platform so three people can
   build in parallel from day 1 after a shared types PR (0017). Every backlog task has one lane
   tag: `payments`, `discovery` or `platform`. Tasks outside T1 (0008, 0010, 0011, 0015) are
   tagged too.
5. **0009 narrowed**: it became Story 1.4 (`/settle`); its other parts moved to 0018, 0019, 0020,
   0024, 0025 and 0027. 0016 gained the `@x402` 2.28 upgrade, which had no owner.

## Open

- Lane owners for Discovery and Platform (Adam, Stan) are not decided yet.
