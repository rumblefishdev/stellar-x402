---
id: "0113"
title: "Record the digest on this run's deployment, not the newest one for the commit"
type: BUG
status: backlog
related_adr: ["0011"]
related_tasks: ["0026"]
tags: [deploy, ci, priority-low, effort-small, platform]
links:
  - ../../../.github/workflows/deploy-production.yml
  - ../../../docs/runbook.md
history:
  - date: "2026-11-05"
    status: backlog
    who: stkrolikiewicz
    note: "Spawned from Oskar's review of #126 (point 4), code already on deploy/production."
---

# Record the digest on this run's deployment, not the newest one for the commit

## Summary

As an admin rolling back, I want each deployment's status to carry the digest that deployment ran,
so that the digest I read back from the list is the right one.

## Context

`deploy-production.yml`'s "Record the digest" step takes
`deployments?environment=production&sha=$GITHUB_SHA&per_page=1` and posts the status on `.[0].id`,
the newest deployment for the commit. A re-run of the same commit, or a second run waiting for
approval (a rollback by dispatch runs on `deploy/production`'s tip, the same commit), creates a
newer one, so the digest lands on the wrong deployment. With an empty list `id` is `null` and the
step fails after the server deploy has already succeeded.

## Implementation

- Find this run's deployment, for example by the run ID in its statuses' `log_url`, or by
  `created_at` after the job started.
- On none found, fail with a message that says the server deploy succeeded and only the record is
  missing.
- The runbook's Rollback reads the same list; check its commands still fit.

## Acceptance Criteria

- [ ] Given two runs of one commit, when the second records its digest, then the status lands on
      its own deployment and the first's keeps its digest
- [ ] Given no deployment found, when the step runs, then it fails with a clear message, after the
      server deploy
