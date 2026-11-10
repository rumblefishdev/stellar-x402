---
id: "0001"
title: "Lore backlog board on GitHub Pages"
type: FEATURE
status: completed
related_adr: []
related_tasks: []
tags: [layer-tooling, priority-medium, effort-small]
links:
  - https://rumblefishdev.github.io/stellar-x402/
  - https://rumblefishdev.github.io/stellar-prices-api/
history:
  - date: 2026-09-30
    status: active
    who: okarcz
    note: "Task created"
  - date: 2026-09-30
    status: completed
    who: okarcz
    note: "All acceptance criteria met. Commit 9563ab4 on main and develop (9 files), Pages enabled, board live and rendering 1 task."
---

# Lore backlog board on GitHub Pages

## Summary

Publish the lore task backlog as a browsable board on GitHub Pages, the same way `stellar-prices-api` and `soroban-block-explorer` do: a script turns the task files into `lore/board.json`, a static `lore/board.html` renders it, and a workflow deploys both on every push to `develop`.

## Status: Completed

**Current state:** Live at https://rumblefishdev.github.io/stellar-x402/, deployed from `develop`.

## Context

Tasks live as markdown under `lore/1-tasks/`. Without a board they are only visible to someone with a checkout. The sibling repos solve this with a generated Pages site; this task copies that solution.

## Implementation Plan

### Step 1: Generator and page

Copy `tools/scripts/generate-lore-board.mjs` and `lore/board.html` from `stellar-prices-api`, retitled for this project. Add a `board` script to `package.json`.

### Step 2: Deploy workflow

Add `.github/workflows/deploy-board.yml`, adapted to this repo: branch `develop`, pinned with `ref: develop` because scheduled and manual runs otherwise check out the default branch `main`, and no dependency install, since the generator only uses Node built-ins.

### Step 3: Enable Pages (after push)

Repo Settings → Pages → Source: **GitHub Actions**. The first workflow run fails until this is set.

## Acceptance Criteria

- [x] `pnpm board` generates `lore/board.json` from the task files
- [x] `lore/board.html` renders that data (live page rendered in headless Chrome: task card shown under Tooling)
- [x] `format:check` and `lint` stay green
- [x] Pages source set to GitHub Actions on `rumblefishdev/stellar-x402`
- [x] Board live at https://rumblefishdev.github.io/stellar-x402/

## Implementation Notes

- `tools/scripts/generate-lore-board.mjs` and the `board` script in `package.json` build `lore/board.json` (gitignored).
- `lore/board.html` is the static page; `.github/workflows/deploy-board.yml` publishes both.
- `.prettierignore` skips the board page, task/ADR files and `CLAUDE.md`; `eslint.config.js` declares Node globals for `tools/scripts`.
- `ci.yml` also runs on pushes to `develop`.

## Design Decisions

### From Plan

1. **Copy the sibling repos' solution**: same generator, page and workflow shape, so the three boards behave alike.
2. **Deploy from `develop`, pinned with `ref: develop`**: scheduled and manual runs check out the default branch (`main`) unless pinned.
3. **Project-specific layers**: facilitator, bazaar, mcp, sdk, contracts, conformance replace the siblings' domain/database/backend/indexing/frontend.

### Emerged

4. **No dependency install in the workflow**: the generator uses only Node built-ins, so the job runs it with `node` directly instead of `pnpm install` + `pnpm board`.
5. **Added `layer-conformance` as a ninth layer**: `conformance/` is a separate deliverable and fit none of the others.
6. **`CLAUDE.md` ignored by prettier**: the lore-generated files failed `format:check`; the siblings ignore them too.
7. **`develop` branch created** and added to the CI push triggers, so the branch the board deploys from is also checked.

## Issues Encountered

- **First deploy run failed**: the push to `develop` ran before Pages was enabled. Fixed by enabling Pages (source: GitHub Actions) and re-running via `workflow_dispatch`.
- **`eslint` flagged `console` as undefined** in the copied `.mjs` script, because this repo's config declares no Node globals. Fixed with a scoped `globals` block.

## Notes

- Tasks are grouped by their `layer-*` tag. Layers follow the repo layout: `layer-research`, `layer-facilitator` (incl. signer pool), `layer-bazaar`, `layer-mcp`, `layer-sdk`, `layer-contracts`, `layer-conformance`, `layer-infra`, `layer-tooling`. The list lives in both `tools/scripts/generate-lore-board.mjs` and `lore/board.html`.
- Scheduled and manual runs only fire from the workflow file on the default branch (`main`), so the workflow must exist there too.
- The workflow keeps `cancel-in-progress: false`: cancelling a run mid `actions/deploy-pages` wedges the Pages deployment (stellar-prices-api task 0166).
