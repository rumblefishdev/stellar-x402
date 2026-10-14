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

- [x] `/risk-split-pr` exists in `.claude/skills/risk-split-pr/` and matches the agreed definition
- [x] `/pr` has the agreed improvements
- [x] `.claude/settings.json` allows `/risk-split-pr`
- [x] Prettier passes on the changed files

## Implementation Notes

- **`/risk-split-pr`**: Oskar's definition (risk classes `mechanical → move → refactor → logic`,
  rules, Mode A while implementing, Mode B to split a branch, the move purity check), fitted to
  this repo:
  - also triggered by "split PR";
  - the target is `develop`, or `main` for a PR that targets `main`;
  - PRs are rebase-merged, so every commit follows `/lore-framework-git`, with a commit type
    per class, and a stack is restacked after each merge with `git rebase --onto`, a
    `--force-with-lease` push after asking, and a REST retarget (`gh pr edit` fails here);
  - each PR of a stack is opened with `/pr --base <previous-branch>`;
  - the title is `/pr`'s `type(lore-NNNN): [<class>] <description>`, and the body puts a
    `Risk class` section before `/pr`'s Summary / Please confirm / Testing;
  - every PR but the last is partial, so the task stays `active` until the last one merges.
- **`/pr`**:
  - reviewers: the ones the PR's creator names; otherwise picked at random from the other team
    members, one for a docs-only PR and two for anything else;
  - step 1 suggests `/risk-split-pr` for a mixed diff over ~100 lines, or a `logic` part over
    ~400;
  - the Summary ends with "Reviewers, please confirm" (as in PR #23): one bullet per other team
    member whose task the PR affects, saying what to confirm. Those people are always
    requested as reviewers.
- Checked the docs-only filter and the `shuf` pick on sample file lists.

## Design Decisions

### From Plan

1. **Reviewer count by kind of PR** (Oskar): one random reviewer for docs-only PRs, two for
   anything else, unless the creator names them.
2. **"Reviewers, please confirm" per affected task owner** (Oskar), in the Summary, as Karol
   wrote it in PR #23.

### Emerged

3. **"Docs only" means every changed file is Markdown or under `docs/` or `lore/`.** So a PR
   that changes only skill files (Markdown) gets one reviewer.
4. **`/risk-split-pr` hands opening PRs to `/pr`**, so a stacked PR gets the same CI checks,
   commit check, testnet line and reviewer rule. A `mechanical`, `move` or `refactor` PR can
   say `Testnet: N/A — no behavior change`.
5. **The risk-class title is inside the house title** (`refactor(lore-0042): [move] …`), and
   the class picks the type: `style`/`chore`/`build` for `mechanical`, `refactor` for `move`
   and `refactor`, `feat`/`fix`/`docs` for `logic`.
6. **Who owns an affected task:** the last `who` in its history (the board's assignee); for a
   backlog task still at `claude`, its lane's owner (`payments` okarcz, `discovery` akot,
   `platform` stkrolikiewicz). Confirmers are always requested; named or random reviewers fill
   up to the count, and more confirmers than the count means all of them.
