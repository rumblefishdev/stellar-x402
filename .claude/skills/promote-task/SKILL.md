---
name: promote-task
description: Status-only change of a lore task pushed straight to develop, no PR — activate it (backlog → active) before work starts, or close it (→ completed) after its PR merged; the board updates from the push. Use for "weź task 0042", "aktywuj task", "promote 0042", "zamknij task po merge'u", "close task 0042".
metadata:
  internal: true
---

# /promote-task — Change a task's status on develop

The team sees who does what on the board, and the board is built from the task files on `develop` (`.github/workflows/deploy-board.yml` runs on every push to `lore/**`). Status changes therefore go straight to `develop`, without a PR:

- **active**: before work starts, so nobody else picks the task up.
- **completed**: after the task's last PR merged. This is how the repo closes tasks (`docs(lore-0004): close the UptoProxy testnet e2e task`, pushed after PR #8 merged).
- **blocked**: when work stops on an outside dependency.

## Arguments

- `/promote-task`: activate the current task (`lore/0-session/current-task.md`)
- `/promote-task 0042`: activate task 0042
- `/promote-task 0042 completed` / `blocked`: move it to that status

## Steps

### 1. Identify the task

Find `0042_*` under `lore/1-tasks/`: a file `NNNN_TYPE_slug.md` or a directory `NNNN_TYPE_slug/README.md`. Read `id`, `title`, `type` and `status` from the frontmatter. If it already has the target status, **STOP**.

For **completed**: check that nothing is still open for it (`gh pr list --state open --search "lore-0042 in:title"`) and that its acceptance criteria are ticked. If not, **STOP** and say what is missing.

### 2. Work in a temporary worktree

Don't switch or stash the user's checkout. It often holds untracked notes and other worktrees exist, and `git switch develop` fails while `develop` is checked out anywhere else. Use a throwaway worktree at the remote tip:

```bash
git fetch origin develop
git worktree add --detach "$SCRATCH/promote-0042" origin/develop
```

`$SCRATCH` is the session scratchpad. Do every edit and commit below inside that worktree.

### 3. Update the task with /lore-framework-tasks

**Use `/lore-framework-tasks`. Never edit the frontmatter by hand.** It sets the status, `git mv`s the task to the matching directory (`active/`, `blocked/`, `archive/`) and, for **completed**, runs its completion checklist and spawns follow-up tasks.

The new `history` entry sets the assignee: the board shows the last entry's `who`. So `who` is **the user's lore id**, a key of `lore/0-session/team.yaml` (`okarcz`, `akot`, `stkrolikiewicz`). Read it from `LORE_SESSION_CURRENT_USER` or `lore-framework_show-session`. It is not `claude`, and not the git user name: Oskar commits as `karczuRF` but is `okarcz`.

### 4. Commit with /lore-framework-git

House messages:

| Target    | Message                                        |
| --------- | ---------------------------------------------- |
| active    | `docs(lore-0042): start the <short name> task` |
| completed | `docs(lore-0042): close the <short name> task` |
| blocked   | `docs(lore-0042): block the <short name> task` |

Stage only the task files (plus follow-up tasks a completion created).

### 5. Push and clean up

```bash
git push origin HEAD:develop
git worktree remove "$SCRATCH/promote-0042"
```

If the push is rejected because `develop` moved, run `git pull --rebase origin develop` in the worktree and push once more.

### 6. Confirm

> Task {id} is {status} on develop. The board updates in a minute or two.

After activation, suggest `/branch {id}`.

## Status convention

The statuses are `backlog`, `active`, `blocked` and `completed`. **Never use `done`.**
