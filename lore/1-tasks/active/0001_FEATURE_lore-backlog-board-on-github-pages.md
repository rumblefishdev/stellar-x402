---
id: "0001"
title: "Lore backlog board on GitHub Pages"
type: FEATURE
status: active
related_adr: []
related_tasks: []
tags: [layer-tooling, priority-medium, effort-small]
links:
  - https://rumblefishdev.github.io/stellar-prices-api/
history:
  - date: 2026-09-30
    status: active
    who: okarcz
    note: "Task created"
---

# Lore backlog board on GitHub Pages

## Summary

Publish the lore task backlog as a browsable board on GitHub Pages, the same way `stellar-prices-api` and `soroban-block-explorer` do: a script turns the task files into `lore/board.json`, a static `lore/board.html` renders it, and a workflow deploys both on every push to `develop`.

## Status: Active

**Current state:** Wired locally, not pushed. Pages is not yet enabled on the GitHub repo.

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
- [ ] `lore/board.html` renders that data (not yet opened in a browser)
- [x] `format:check` and `lint` stay green
- [ ] Pages source set to GitHub Actions on `rumblefishdev/stellar-x402`
- [ ] Board live at https://rumblefishdev.github.io/stellar-x402/

## Notes

- Tasks are grouped by their `layer-*` tag. Layers follow the repo layout: `layer-research`, `layer-facilitator` (incl. signer pool), `layer-bazaar`, `layer-mcp`, `layer-sdk`, `layer-contracts`, `layer-conformance`, `layer-infra`, `layer-tooling`. The list lives in both `tools/scripts/generate-lore-board.mjs` and `lore/board.html`.
- Scheduled and manual runs only fire from the workflow file on the default branch (`main`), so the workflow must exist there too.
- The workflow keeps `cancel-in-progress: false`: cancelling a run mid `actions/deploy-pages` wedges the Pages deployment (stellar-prices-api task 0166).
