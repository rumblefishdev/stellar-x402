---
id: "0158"
title: "Remove apps/portal-web once the hub serves the x402 landing page"
type: FEATURE
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0106"]
tags: [portal, platform, priority-low, effort-small]
links:
  - ../archive/0106_FEATURE_api-key-portal-discord.md
history:
  - date: "2026-11-23"
    status: backlog
    who: akot
    note: "Spawned from 0106 future work."
---

# Remove apps/portal-web once the hub serves the x402 landing page

## Summary

The x402 Facilitator's landing page moved into the API hub's bundle (`sorobanscan-api-portal` #11,
routed by `soroban-block-explorer` #760, both merged on 2026-11-23). `apps/portal-web` here is the
page's first home and is served nowhere: remove it once the hub's page is live at
`https://sorobanscan.com/api/x402-facilitator/`.

## Context

- 0106 built the page in `apps/portal-web` for a bundle of its own under the explorer's bucket.
  That path was never opened to the public; #212, its last change, was closed unmerged because the
  hub's port carries it.
- The hub's upload and the explorer's release were not done when this task was written. Check the
  live address before removing anything.

## Implementation

- Remove `apps/portal-web` and its entries in the workspace, the lockfile and Turbo.
- Remove its paths from the workflows that name it (`deploy-production.yml` ignores a push that
  changes only `apps/portal` or `apps/portal-web`).
- Take it out of the docs that describe it: `apps/portal`'s README, the runbook, 0106's decision 1
  stays as history.

## Acceptance Criteria

- [ ] Given the hub's page live at `/api/x402-facilitator/`, when this task ends, then
      `apps/portal-web` is gone and `pnpm install`, `pnpm typecheck`, `pnpm test` and `pnpm build`
      pass
- [ ] Given the repo, when searched for `portal-web`, then only task files and ADRs mention it
