---
name: risk-split-pr
description: "Split code changes into small PRs by risk class (mechanical → move → refactor → logic) so the reviewer spends time only where behavior actually changes. Use whenever preparing a branch for review or opening a PR, when a diff mixes moved/extracted code with edits, when a PR is too big to review, or when the user says 'podziel PR', 'rozdziel PR', 'za duży PR', 'przygotuj do review', 'stacked PRs', 'split PR', 'split this branch'. Also use while implementing a task, to order commits so the split is cheap later."
---

# Risk-split PRs

Two facts drive this skill:

1. **Review cost grows faster than diff size.** Past a few hundred changed lines reviewers
   stop finding defects and start skimming (SmartBear/Cisco study: effectiveness drops past
   ~200–400 LOC per review). Ten small PRs get a better review than one big one.
2. **A diff that moves code _and_ changes it is unreviewable.** GitHub shows it as one green
   wall; the reviewer re-reads code that was already reviewed elsewhere, hunting for the one
   line that changed. Move it verbatim in one PR, change it in the next, and the second
   diff shows only the change.

So: group changes by **how much a reviewer has to think**, and put each group in its own PR.
Low-risk PRs get approved in minutes; attention goes to the `logic` PR.

## Risk classes

| Class        | What goes in                                                                                                         | Behavior change | What the reviewer checks                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------- |
| `mechanical` | Tool output: formatter, lint autofix, codemod, generated code, dependency/lockfile bumps                             | none intended   | The command that produced it; spot-check                |
| `move`       | Code relocated verbatim, file renames, plus only the import/export/indent glue needed to compile                     | none            | That it's verbatim (purity check below)                 |
| `refactor`   | Behavior-preserving restructuring: rename, unify duplicates, simplify, extract with same semantics, delete dead code | none            | Existing tests unchanged and green; semantics preserved |
| `logic`      | Features, bug fixes — anything that changes what the program does                                                    | yes             | Everything. This is where review time goes              |

Mark a `logic` PR **high-risk** in its description when it touches migrations, auth/security,
money paths, public API/contracts or concurrency. Not a separate PR, just a flag so the
reviewer knows to slow down.

## Rules

- **Never move and edit in the same commit.** Move verbatim first (only the glue needed to
  compile), then edit in a later commit. The edit then lands in `refactor` or `logic`.
- **Tests are the refactor/logic boundary.** A refactor doesn't change any existing test
  assertion. If an assertion has to change, behavior changed → `logic`. Adding tests for
  existing behavior is fine in `refactor`.
- **Every PR builds and passes tests on its own.** A PR that only compiles together with its
  sibling isn't separately reviewable or mergeable; merge those two classes instead.
- **Lowest risk first:** `mechanical → move → refactor → logic`. Cheap PRs merge fast and the
  risky diff ends up last and smallest.
- **Keep `logic` PRs under ~400 changed lines.** If bigger, split by vertical slice (one
  behavior end-to-end), not by layer.
- **Don't split when it doesn't pay.** Only one class present, or the whole change is under
  ~100 lines → one PR. If the team doesn't want stacked PRs, fall back to one PR with
  class-ordered commits and tell the reviewer to review commit by commit. The rebase merge
  keeps those commits on `develop` as they are.

## Mode A — while implementing

Commit in class order as you go: formatting/codegen first, then pure moves, then refactors,
then the behavior change. PRs here are **rebase-merged**: every commit lands on the base as
written, so each one follows `/lore-framework-git` (`type(lore-NNNN): description`):

| Class        | Commit type                 |
| ------------ | --------------------------- |
| `mechanical` | `style`, `chore` or `build` |
| `move`       | `refactor`                  |
| `refactor`   | `refactor`                  |
| `logic`      | `feat`, `fix` (or `docs`)   |

No `wip` or `fixup!` commits: they would land on `develop` too. With commits already
separated, Mode B is just cutting branches at commit boundaries.

## Mode B — split an existing branch

1. **Pin the endpoints.** The target is `develop`, where task PRs go; it is `main` only for a
   PR that targets `main` (a release). `TARGET=develop` (or `main`),
   `BASE=$(git merge-base HEAD origin/$TARGET)`, `ORIG=$(git rev-parse HEAD)`. Never rewrite
   or force-push the original branch — build new branches next to it.
2. **Read the whole diff** (`git diff $BASE $ORIG`) and classify every hunk. A hunk that both
   moves and edits code must be decomposed: verbatim move into `move`, the edit into
   `refactor`/`logic`.
3. **Show the plan and wait for an OK** before creating branches:

   | #   | Class | Branch | Title | Files | ~Lines | Base |
   | --- | ----- | ------ | ----- | ----- | ------ | ---- |

4. **Build the stack.** For PR _n_, branch from PR _n−1_ (the first from `BASE`), e.g.
   `lore-0042-store-adapters-1-move` from `lore-0042-store-adapters`. Materialize that PR's state — `git checkout $ORIG -- <path>` for
   whole files, direct edits for partial ones — and commit.
5. **Prove nothing was lost or added:** `git diff $ORIG <last-branch>` must be empty. If it
   isn't, a hunk is missing or duplicated; fix before going on.
6. **Verify each branch:** build + tests; purity check on every `move` branch.
7. **Push and open PRs only after the user confirms** — it's outward-facing. Open each one
   with `/pr --base <previous-branch>` (the first with the target), so it gets the CI checks,
   the commit check, the title, the body and the reviewers described below.
8. **Restack after each merge.** A rebase merge puts the bottom PR's commits on the target
   with new SHAs, so the next branch still carries the old copies. Rebase it onto the target,
   retarget its PR (`gh pr edit` fails here, so use the REST API), and force-push it after
   asking:

   ```bash
   git fetch origin $TARGET
   git rebase --onto origin/$TARGET <old-base-branch> <branch>
   git push --force-with-lease origin <branch>
   gh api -X PATCH repos/{owner}/{repo}/pulls/{n} -f base=$TARGET
   ```

   If GitHub already retargeted the PR because the merged branch was deleted, skip the last
   line.

## Move purity check

Prints lines added that weren't just moved from elsewhere in the same diff
(whitespace-insensitive). On a clean `move` branch it shows only import/export/declaration
glue. Anything else is an edit that belongs in a later PR.

```bash
( export LC_ALL=C; comm -23 \
  <(git diff -U0 "$FROM" "$TO" | grep '^+' | grep -Ev '^\+\+\+ (b/|/dev/null)' | sed 's/^+[[:space:]]*//' | sort) \
  <(git diff -U0 "$FROM" "$TO" | grep '^-' | grep -Ev '^--- (a/|/dev/null)' | sed 's/^-[[:space:]]*//' | sort) )
```

Paste its output into the PR description, so the reviewer sees the full list of
non-verbatim lines without hunting for them.

## PR description

Each PR follows `/pr`; the risk class is added to its title and body.

**Title:** `/pr`'s `{type}(lore-{id}): {description}`, with the class in brackets at the start
of the description. The type follows the class (table in Mode A). Under 70 characters:

- `refactor(lore-0042): [move] extract the store contract suites`
- `chore(lore-0042): [mechanical] bump @x402 packages to 2.28`
- `feat(lore-0042): [logic] add the PostgreSQL settlement store`

**Body:** a `Risk class` section first, then `/pr`'s Summary / Please confirm / Testing:

```markdown
## Risk class

**Risk class:** move | mechanical | refactor | logic (high-risk: <why>, if applies)
**Stack:** <n>/<N> — <links to the other PRs>
**Behavior change:** none | <one sentence>
**How to review:** <class-specific, e.g. "`git diff --color-moved=dimmed-zebra <base>..<head>`
— everything dimmed except the lines below" / "tests untouched, check they still pass" /
"full review; logic is in X and Y">
**Not verbatim / look here:** <purity check output, or the files where the logic lives>

## Summary

…
```

The build and test results go in `/pr`'s Testing section. Its testnet line still applies: the
`logic` PR carries the run against the real thing, and a `mechanical`, `move` or `refactor`
PR can say `Testnet: N/A — no behavior change (<class>)`.

The description should let the reviewer pick the right depth in ten seconds: skim, verify,
or read every line.

## Task status

Every PR in a stack but the last is a partial PR: the task stays `active`. After the last one
merges, run `/promote-task {id} completed`, as `/pr` says.
