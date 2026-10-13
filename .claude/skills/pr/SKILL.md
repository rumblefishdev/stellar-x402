---
name: pr
description: Run the CI checks, push the branch and open a GitHub pull request to develop for the active lore task, with a house-style body, testnet evidence and reviewers requested (one for docs-only PRs, two otherwise, picked at random unless named). Use for "zrób PR", "otwórz PR", "wystaw PR", "open a PR", "create a pull request".
metadata:
  internal: true
---

# /pr — Open a pull request for the active lore task

## Arguments

- `--base <branch>`: a different base than `develop`
- `--draft`: open it as a draft
- `--reviewer <login,…>`: the reviewers the PR's creator chose; skips the random pick in step 6
- `/pr <title>`: use this title instead of building one

## Steps

### 1. Read the task and the branch

Read `lore/0-session/current-task.md`: `id`, `title` and `type` from the frontmatter, plus the Summary, Acceptance Criteria and Design Decisions for the body. If there is no active task, **STOP** and ask the user to pick one.

If the branch already has a PR (`gh pr view --json url,state`), print its URL and **STOP**. Offer to update the body instead (see the note under step 6).

```bash
git fetch origin develop
git log --format='%h %s' origin/develop..HEAD
git diff --stat origin/develop...HEAD
```

If the diff mixes risk classes (formatting, moved code, refactors, behavior changes) and is over ~100 lines, or its `logic` part is over ~400, suggest `/risk-split-pr` before going on. A PR that is part of such a stack takes the title and the `Risk class` section that `/risk-split-pr` describes.

### 2. Check every commit message

PRs here are **rebase-merged**: every commit lands on `develop` as written, with no squash and no merge commit. Each subject must follow `/lore-framework-git` (`type(lore-NNNN): description`). If one doesn't (`wip`, `fixup!`, no scope), **STOP** and propose a reword. If those commits are already pushed, rewording means a force push, so ask first.

### 3. Title

`{type}(lore-{id}): {description}`, following `/lore-framework-git`:

| Task type | Prefix     |
| --------- | ---------- |
| FEATURE   | `feat`     |
| BUG       | `fix`      |
| REFACTOR  | `refactor` |
| DOCS      | `docs`     |
| RESEARCH  | `docs`     |

The description is short, lowercase and says what the PR does. Don't copy the task title. Stay under 70 characters. Examples:

- `feat(lore-0017): add store ports, settlement hooks and config schema`
- `feat(lore-0004): deploy UptoProxy to testnet and run on-chain e2e tests`
- `docs(lore-0006): record upto settlement scaling research`

### 4. Body

```markdown
## Summary

<One or two sentences: the task, its M1 story, and what now works that didn't before.>

- **<Part>** (`path`): what it does. One bullet per real change, 3–6 bullets.

Reviewers, please confirm:

- **@<login>** (<task id>): <the one thing this PR changes for their task, to confirm>.

## Please confirm

1. **<Decision>** (<lanes it affects>): what was decided and why, one paragraph each.

## Testing

- <command> → <result, with counts>
- <the run against the real thing, see below>
```

- **No AI attribution**, in the body or in any commit: no "Generated with Claude Code" line and no `Co-Authored-By: Claude` trailer. It breaks the house convention.
- **Please confirm** lists the decisions reviewers must agree to, usually the task's "Emerged" design decisions. Call it **Please note** when they're findings rather than decisions. Leave it out when there are none.
- Say WHAT changed, not HOW. Name the tasks that inherit deferred work (`0022 runs the same suites…`).
- **Reviewers, please confirm** goes at the end of the Summary, as in PR #23. It has one bullet per other team member whose task this PR affects: a task it edits, a task in the current task's `related_tasks`, or a task the body names as inheriting work. That task's owner is the last `who` in its `history` (the board's assignee). A backlog task whose last `who` is `claude` belongs to its lane's owner, from its tags:

  | Lane tag    | Owner            |
  | ----------- | ---------------- |
  | `payments`  | `okarcz`         |
  | `discovery` | `akot`           |
  | `platform`  | `stkrolikiewicz` |

  Skip tasks of the PR's creator. Each bullet says in one sentence what the PR changes for that task and what to confirm, e.g. `**@adamkoot** (0032): no resource filter is needed; details before paying come from the seller's 402 answer.` Leave the list out when no one else's task is affected. These people are always requested as reviewers (step 6).

**Testing includes a run against the real thing.** Unit tests show the code matches our understanding; they don't show the understanding is right. Use the check that fits the change:

| The change touches              | Run against the real thing                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| UptoProxy contract              | `pnpm contracts:e2e` on testnet (needs the funded accounts in `contracts/upto-proxy/e2e/secrets/`)           |
| signer pool / settlement submit | `pnpm exec tsx scripts/testnet-smoke.ts <channels> <payments>` in `packages/signer-pool` (env in its header) |
| facilitator HTTP                | `pnpm --filter @stellar-x402/facilitator dev` with testnet env, then `curl` the routes                       |

Write the command and what it reported. A change none of these can exercise (types only, docs, CI) says `Testnet: N/A — <reason>`. No such line, no PR: stop and run the check first.

### 5. Run the CI checks

There are no git hooks, so this is the only gate before CI. Run what `.github/workflows/ci.yml` runs:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

If the branch changes anything under `contracts/`, also run:

```bash
pnpm contracts:lint && pnpm contracts:test
```

Run `pnpm contracts:test:wasm` too when `stellar --version` is 25.2 or newer. Otherwise say CI covers it. CI also runs Node 22 and 24; locally one version is enough.

If something fails, fix it in a new commit (through `/lore-framework-git`) and run the checks again.

### 6. Push and open the PR

**Reviewers.** Everyone in the body's "Reviewers, please confirm" list is requested, since they own an affected task. If the PR's creator named reviewers (`--reviewer`, or in the request), add exactly those. Otherwise fill up to the count below at random from the other team members, never the creator (`LORE_SESSION_CURRENT_USER`). More confirmers than the count means all of them, and no random pick:

| The PR changes                                                         | Reviewers |
| ---------------------------------------------------------------------- | --------- |
| docs only: every changed file is Markdown, or under `docs/` or `lore/` | 1         |
| anything else (code, config, CI, contracts)                            | 2         |

```bash
git diff --name-only origin/develop...HEAD | grep -Ev '\.md$|^docs/|^lore/' # empty → docs only
printf '%s\n' {logins of the other members} | shuf -n {1 or 2}
```

Say who was picked, and that the pick was random. `team.yaml` ids map to GitHub logins like this:

| team.yaml        | GitHub           |
| ---------------- | ---------------- |
| `okarcz`         | `karczuRF`       |
| `akot`           | `adamkoot`       |
| `stkrolikiewicz` | `stkrolikiewicz` |
| `karolkow`       | `karolko9`       |

```bash
git push -u origin {branch}
gh pr create --base develop --title "{title}" --body-file {body-file} --reviewer {logins}
```

Write the body to a file in the scratchpad and pass `--body-file`, so backticks and `$` stay as written.

`gh pr edit` fails on this repo (its GraphQL query still asks for the retired Projects classic cards). Change an existing PR through the REST API instead:

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/{n} -F body=@{body-file}
gh api -X POST repos/{owner}/{repo}/pulls/{n}/requested_reviewers -f 'reviewers[]={login}'
```

### 7. Confirm

Print the PR URL. Then check `gh pr view --json mergeable`. If GitHub reports a conflict with `develop`, say so; the rebase merge can't happen until it's resolved.

## Task status

All status changes go through `/lore-framework-tasks`, never by hand. The status is `completed`, never `done`.

- **Partial PR** (e.g. 0017's day-1 types): the task stays `active`. Tick the criteria this PR meets in the task file, in the branch.
- **Last PR of the task**: don't close the task in the PR. After it merges, run `/promote-task {id} completed`. That's how the repo does it, so the board flips when the code is really on `develop`.
