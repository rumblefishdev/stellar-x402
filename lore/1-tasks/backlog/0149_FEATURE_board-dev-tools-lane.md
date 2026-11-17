---
id: "0149"
title: "Show the dev-tools lane on the board and in /pr's lane table"
type: FEATURE
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0144"]
tags: [layer-tooling, board, priority-medium, effort-small, platform]
links:
  - ../../../tools/scripts/generate-lore-board.mjs
  - ../../board.html
  - ../../../.claude/skills/pr/SKILL.md
history:
  - date: "2026-11-17"
    status: backlog
    who: claude
    note: >
      Created on okarcz's decision of 2026-11-17: the M2 plan's fifth lane (agents, SDK and quality, for the developer joining
      later) gets the tag `dev-tools`, and 13 tasks carry it now.
---

# Show the dev-tools lane on the board and in /pr's lane table

## Summary

The M2 plan has a fifth lane, agents, SDK and quality, for the developer who joins later. Its tasks now carry the tag
`dev-tools`, but the board knows only `payments`, `discovery` and `platform`, so they show with no lane. Add the lane to
the board and to the `/pr` skill's lane table.

## Context

- **What was tagged on 2026-11-17** (okarcz):
  - Tasks that had no lane now carry `dev-tools`: 0068, 0085, 0102, 0116, 0055, 0084, 0081, 0131.
  - These moved from another lane to `dev-tools`: 0043, 0044 (from `payments`), 0042, 0137, 0075 (from `discovery`).
- **What stayed:** 0057, 0058 and 0092 stay in `payments`, as okarcz decided on 2026-11-16. 0074 and 0101 are Karol's,
  with an owner, and keep their tags.
- **How the board picks a lane:** `getLane()` in `tools/scripts/generate-lore-board.mjs` takes the first tag found in
  `LANES` (`payments`, `discovery`, `platform`), one lane per task. `lore/board.html` has the matching labels and
  colours.
- **How `/pr` uses lanes:** its lane table maps a task with no owner to its lane's owner. It still says
  `discovery → akot`, while Karol holds discovery in M2 (lane owners stated by okarcz on 2026-11-12).

## Implementation Plan

### Step 1: Board

- Add `dev-tools` to `LANES` in `generate-lore-board.mjs`.
- Add a label (`Dev tools`) and a colour distinct from the three existing ones to `LANE_LABELS` and `LANE_COLORS` in
  `lore/board.html`.
- Regenerate `board.json` and compare it before and after: only the 13 tasks gain a lane.

### Step 2: `/pr` lane table

- Add the `dev-tools` row. It has no owner until the fifth developer joins, so a task with that tag and no owner gets no
  confirm request.
- Set `discovery` to `karolkow` for M2.

## Acceptance Criteria

- [ ] The board shows the 13 `dev-tools` tasks under a "Dev tools" lane, and its lane filter lists it
- [ ] `/pr`'s lane table has `dev-tools` with no owner, and `discovery` names `karolkow`
- [ ] `board.json` before and after differs only in the lanes of those 13 tasks
