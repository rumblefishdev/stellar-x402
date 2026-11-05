---
id: "0114"
title: "Accept a rollback digest only if production has run it before"
type: FEATURE
status: backlog
related_adr: ["0011"]
related_tasks: ["0026", "0113"]
tags: [deploy, ci, security, priority-medium, effort-small, platform]
links:
  - ../../../.github/workflows/deploy-production.yml
  - ../../../docs/runbook.md
history:
  - date: "2026-11-05"
    status: backlog
    who: stkrolikiewicz
    note: "Spawned from Oskar's review of #126 (point 5), code already on deploy/production."
---

# Accept a rollback digest only if production has run it before

## Summary

As the approver of a production deploy, I want a dispatched digest to be one production already
ran, so that approving a "rollback" can't put an image on the server that never went through a
reviewed build.

## Context

A dispatch of `deploy-production.yml` with `digest` skips the image job and deploys that digest.
The workflow checks only that it starts with `sha256:`. Any workflow that may write packages can
push to `ghcr.io/rumblefishdev/x402-facilitator` (the comment above the image job says so), and the
approver sees only a hash, so the required reviewer is the only check.

## Implementation

- Before the SSH step, when `digest` came from the dispatch, look it up in the production
  environment's deployment statuses, the list the runbook's Rollback reads, and fail if no earlier
  status recorded it.
- Depends on the statuses carrying the right digest (0113).

## Acceptance Criteria

- [ ] Given a dispatched digest that an earlier production deployment recorded, when the deploy
      runs, then it deploys it
- [ ] Given a dispatched digest no deployment recorded, when the deploy runs, then it fails before
      the SSH step and says why
