---
id: "0040"
title: "Improve the project skills: add /risk-split-pr and improve /pr"
type: FEATURE
status: active
related_adr: []
related_tasks: []
tags: [layer-tooling, skills, priority-medium, effort-small, platform]
links:
  - ../../../.claude/skills/pr/SKILL.md
history:
  - date: "2026-10-13"
    status: active
    who: okarcz
    note: "Created and started: add a risk-split-pr skill and improve the pr skill from PR #13."
---

# Improve the project skills: add /risk-split-pr and improve /pr

## Summary

Two changes to the project skills in `.claude/skills/`: a new `/risk-split-pr` skill, and
improvements to the `/pr` skill that PR #13 added.

## Context

- PR #13 added three project skills: `/promote-task`, `/branch` and `/pr`. The workflow is
  `/promote-task` → `/branch` → implement → `/pr` → merge → `/promote-task … completed`.
- `/pr` runs the CI checks, checks commit messages, writes the body (Summary / Please confirm /
  Testing, with a testnet line) and requests reviewers.
- The definition of `/risk-split-pr` and the list of `/pr` improvements are given while working
  on the task.

## Implementation

- **`/risk-split-pr`** (`.claude/skills/risk-split-pr/SKILL.md`): new skill, defined during the
  task.
- **`/pr`** (`.claude/skills/pr/SKILL.md`): improvements, listed during the task.
- **`.claude/settings.json`**: allow the new skill, as PR #13 did for the other three.

## Acceptance Criteria

- [ ] `/risk-split-pr` exists in `.claude/skills/risk-split-pr/` and matches the agreed definition
- [ ] `/pr` has the agreed improvements
- [ ] `.claude/settings.json` allows `/risk-split-pr`
- [ ] Prettier passes on the changed files
