---
id: "0033"
title: "Show lane tags on the backlog board"
type: FEATURE
status: completed
milestone: 1
related_adr: []
related_tasks: ["0001", "0012"]
tags: [layer-tooling, board, priority-medium, effort-small, platform]
links:
  - ../../../tools/scripts/generate-lore-board.mjs
  - ../../board.html
history:
  - date: "2026-10-07"
    status: active
    who: okarcz
    note: "Created and started: the board doesn't show the lane tags added in 0012."
  - date: "2026-10-07"
    status: completed
    who: okarcz
    note: >
      PR #6 rebase-merged into develop (d2bd4f3). board.json has a lane field; cards, modal and
      table show a lane badge; Lane filter added; layer-other no longer shown. 2 files changed.
      Checked with a headless Chrome render of the card view; no automated tests for the board.
---

# Show lane tags on the backlog board

## Summary

0012 tagged every backlog task with its lane (`payments`, `discovery` or `platform`), but the
backlog board only reads `layer-*` and `priority-*` tags. Lanes are invisible, and tasks without
a `layer-*` tag show the raw fallback `layer-other`. Make the board show and filter by lane.

## Context

- The board (0001) is `lore/board.html`, fed by `board.json` from
  `tools/scripts/generate-lore-board.mjs` and deployed by `.github/workflows/deploy-board.yml`.
- The new M1 tasks (0013–0032) have no `layer-*` tag.

## Implementation

- Generator: derive a `lane` field from the lane tag.
- Board: a lane badge on cards and in the task modal, a Lane filter, and a Lane column in the
  table view.
- Don't show the `layer-other` fallback as if it were a layer.

## Acceptance Criteria

- [x] `board.json` has a `lane` field (`payments`, `discovery`, `platform` or null) for each task
- [x] Cards, the modal and the table show the lane with its own colour
- [x] A Lane filter narrows the board to one or more lanes, with counts
- [x] Tasks without a `layer-*` tag no longer show `layer-other`
- [x] `pnpm format:check` and `pnpm lint` pass

## Implementation Notes

- `tools/scripts/generate-lore-board.mjs`: `LANES` list and `getLane()`; `lane` added to each
  task in `board.json`.
- `lore/board.html`: `.tag-lane` style, `LANE_LABELS` / `LANE_COLORS`, `laneBadge()` and
  `layerBadge()` helpers used by cards, the table and the modal; a Lane filter group before
  Layer; a Lane table column.
- Counts at merge: Payments 12, Discovery 5, Platform 10; the 6 archived tasks have no lane.

## Design Decisions

### From Plan

1. **Lane derived in the generator**: the board reads a `lane` field like it reads `layer`,
   instead of scanning tags in the browser.

### Emerged

2. **Payments badge is pink, and lane badges are tinted**: the first render used blue for
   Payments, which looked like the blue `M1` milestone badge. A light fill also separates lanes
   from the outlined priority and type tags.
3. **No layer badge for unknown layers**: tasks without a `layer-*` tag show no layer badge and
   `—` in the table, instead of `layer-other`. The `layer-other` CSS class on cards is unchanged.

## Issues Encountered

- None. The table view and the modal were checked in code, not on screen.

## Future Work

- None.
