---
id: "0081"
title: "Pass DATABASE_URL to the verify smoke script"
type: BUG
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0064", "0073", "0021", "0128"]
tags: [facilitator, scripts, testnet, priority-low, effort-small, dev-tools]
links: []
history:
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073's PR 1 review (deferred item): the settle smoke script got the fix in
      2cadd78, the other two scripts did not.
---

# Pass DATABASE_URL to the verify smoke script

## Summary

Since 0064 every store is PostgreSQL and the config requires `DATABASE_URL`.
`verify-smoke.ts` doesn't pass it, so it stops at startup with "DATABASE_URL is required" before
checking anything.

## Context

- `apps/facilitator/test/live/verify-smoke.ts` (moved from `scripts/` in 268ba37f, 0036) doesn't
  run `main()`, but builds its verifiers from `parseConfig({...})` (`:85`), which requires a
  `postgres://` `DATABASE_URL` too, though the verifier never opens a store. Its header's `Env:`
  list doesn't name it.
- The token matrix had the same break; 7e99d019 (0128) fixed it: `DATABASE_URL` defaults to the
  local URL from `compose.yaml` and is in its header (`token-matrix.ts:24`, `:69`).
- 0073 fixed `settle-smoke.ts` (2cadd78) by requiring it. Every other live script passes it.

## Implementation

- `verify-smoke.ts`: pass `DATABASE_URL` to `parseConfig()` with the token matrix's fallback to
  the `compose.yaml` URL (the script opens no store, so any valid URL works), and add it to the
  header's `Env:` list saying so.
- Check the run command in the script's header still works.

## Acceptance Criteria

- [ ] Given no `DATABASE_URL` set, when `verify-smoke.ts` runs on testnet, then it starts and
      checks its payments
- [ ] Given the script's header, when it is read, then `DATABASE_URL` is in its variable list
