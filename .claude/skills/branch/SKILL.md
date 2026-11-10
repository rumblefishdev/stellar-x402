---
name: branch
description: Create the working branch for a lore task, named lore-NNNN-slug, from origin/develop, and make it the session's current task. Use for "załóż brancha", "nowa gałąź pod 0042", "start work on 0042", "create a branch".
metadata:
  internal: true
---

# /branch — Create a branch from a lore task

Create the working branch for a task, named the way this repo names them: `lore-0017-facilitator-skeleton`, `lore-0004-upto-proxy-testnet-e2e`.

## Arguments

- `/branch`: the current task
- `/branch 0042`: task 0042
- `/branch 0042 <part>`: a branch for one part of task 0042
- `--base <branch>`: a different base than `origin/develop`

## Steps

### 1. Read the task

With an ID, find `NNNN_*` under `lore/1-tasks/` (any status directory). Otherwise read `lore/0-session/current-task.md`. Read `id`, `title` and `type` from the frontmatter. If there is no task, **STOP** and ask the user to pick one.

If the task is still in `backlog/`, suggest `/promote-task {id}` first, so the board shows it as taken.

### 2. Check nobody else has started it

```bash
git fetch origin --prune
git branch -a --list "*lore-{id}-*"
gh pr list --state open --search "lore-{id} in:title"
```

If anything turns up, **STOP** and show it. The user may want to continue that branch, or the task may be split between people (0017 had two branches).

### 3. Build the name

`lore-{id}-{slug}`. The slug is the part of the filename after the second underscore, without `.md`:

- `0017_FEATURE_facilitator-skeleton.md` → `lore-0017-facilitator-skeleton`
- `0014_RESEARCH_facilitator-hosting/` → `lore-0014-facilitator-hosting`

A part name replaces the slug: `/branch 0017 day1-types` → `lore-0017-day1-types`.

### 4. Create it from origin/develop

PRs here target `develop`. Branch from the remote tip, so a stale local `develop` doesn't matter:

```bash
git switch -c {branch-name} --no-track origin/develop
```

### 5. Set the session task

If `{id}` isn't the session's current task, set it with `lore-framework_set-task`. CLAUDE.md forbids writing code without an active task.

### 6. Confirm

> Branch `{branch-name}` created from `origin/develop` for task {id}: {title}

## Workflow

`/promote-task 0042` → `/branch 0042` → implement → `/pr` → merge → `/promote-task 0042 completed`
