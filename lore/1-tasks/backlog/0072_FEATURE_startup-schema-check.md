---
id: "0072"
title: "Refuse to start on a database missing a migration"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0012"]
related_tasks: ["0025", "0009", "0026", "0067"]
tags: [facilitator, persistence, deploy, priority-medium, effort-small]
links:
  - ../active/0025_FEATURE_channel-lease-and-shutdown.md
history:
  - date: "2026-10-26"
    status: backlog
    who: okarcz
    note: "Spawned from 0025 (decision 18), from 0009's PR #41 review."
---

# Refuse to start on a database missing a migration

## Summary

The facilitator never changes its schema: `pnpm migrate` does, before a release that adds a
migration. A release started on a database that missed it runs anyway and breaks quietly. Check
at startup, before `/settle` is served, that every name in `MIGRATIONS` is in
`schema_migrations`.

## Context

- From 0009 (Adam's sixth PR #41 review): PR #41's release was the first to add a migration
  (`0002_success_answered`). Started on a database without it, it ran, and every success was
  answered once per process instead of once per payment, because `markSuccessAnswered` failed
  with `42703`.
- Later migrations than the release knows must be accepted, so a rollback still starts (0026's
  note).
- 0067 (online migration runner) changes how `migrate` runs; this task only reads
  `schema_migrations`.

## Implementation

- In `main()` with `STORE=postgres`, before the server starts: read `schema_migrations`, and fail
  startup (`startup_failed`, naming the missing migrations) if any name in `MIGRATIONS` is absent.
- Tests: a database one migration behind refuses to start; one ahead starts.

## Acceptance Criteria

- [ ] Given a database without one of the release's migrations, when the facilitator starts, then
      it refuses to start and names the missing migration
- [ ] Given a database with every migration of the release and later ones, when it starts, then
      it starts
