---
id: "0144"
title: "Keep a task's owner on the board when someone else adds a history note"
type: BUG
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0001", "0033", "0026"]
tags: [layer-tooling, board, priority-medium, effort-small, platform]
links:
  - ../../../tools/scripts/generate-lore-board.mjs
  - ../../board.html
history:
  - date: "2026-11-12"
    status: backlog
    who: okarcz
    note: "Found on 0026: a history note from 0029's closing made the board show its author as 0026's owner."
---

# Keep a task's owner on the board when someone else adds a history note

## Summary

The board has no owner field. It shows the `who` of a task's last history entry, so a note from
anyone else changes the owner. This task adds an `owner:` field to the frontmatter that the board
reads first.

## Context

- The rule is `getAssignee` in `tools/scripts/generate-lore-board.mjs`, unchanged since the board's
  first commit (9563ab48, 0001). `lore/board.html` has its own copy, `getTaskAssignee`, and that
  copy is the one the page uses.
- On 2026-11-12 the closing of 0029 added a note to 0026 (two criteria handed over, `who:
  karolkow`). The board now shows karolkow as 0026's owner; okarcz has run it since 2026-11-05.
- Any task that gets a note from another task's owner changes hands the same way. Handing criteria
  from one task to another is common here.
- Taking the owner from history can't be fixed by a better rule: a handoff and a note are both an
  `active` entry by a new person (0026 has one of each).
- The team agreed on 2026-11-12 to the `owner:` field (option 1 of three okarcz put to them). The
  two it turned down: the owner is whoever activated the task (it loses handoffs: 0026 would show
  Stan), and notes in someone else's task written with the owner's `who` (easy to forget, and the
  history no longer says who wrote what).

## Implementation

- **The field.** `owner: <lore id>` in the frontmatter, a key of `lore/0-session/team.yaml`.
- **The rule.** For an active or archived task the board shows `owner` when it is set, and the last
  history entry's `who` when it is not. Tasks without the field show what they show today.
- **One copy of the rule.** `board.html` reads the `assignee` the script wrote to `board.json`
  instead of working it out again.
- **Who sets it.** Activating a task sets `owner`; a handoff changes it, with a history entry that
  says so. A note in someone else's task leaves it alone.
- **Open tasks.** Every active and blocked task gets `owner` set to what the board shows today,
  except 0026, which gets `okarcz`.

## Acceptance Criteria

- [ ] `generate-lore-board.mjs` writes `assignee` from `owner` when the task has one, and from the
      last history entry's `who` when it has none.
- [ ] `board.html` takes the assignee from `board.json`; its own history rule is gone.
- [ ] `pnpm board` on this branch gives 0026 the assignee `okarcz`, and every other task the
      assignee it had before.
- [ ] The task template, `lore/1-tasks/CLAUDE.md` and the `promote-task` and `pr` skills name the
      field and say who sets it.
- [ ] Every active and blocked task has `owner`.
- [ ] Lint and format pass; the PR's CI is green.

## Notes

- Archived tasks keep the old rule: their last entry is the closing one, by the person who did the
  work.
