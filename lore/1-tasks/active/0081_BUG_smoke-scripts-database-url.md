---
id: "0081"
title: "Pass DATABASE_URL to the verify smoke script"
type: BUG
status: active
owner: bstruzyk
milestone: 2
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
  - date: "2026-11-18"
    status: active
    who: bstruzyk
    note: >
      Started: verify-smoke.ts passes DATABASE_URL to parseConfig(), with compose.yaml's URL as the fallback.
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

- [x] Given no `DATABASE_URL` set, when `verify-smoke.ts` runs on testnet, then it starts and
      checks its payments
- [x] Given the script's header, when it is read, then `DATABASE_URL` is in its variable list

## Implementation Notes

- `verify-smoke.ts`: `databaseUrl` is `process.env.DATABASE_URL`, else
  `postgres://postgres:postgres@127.0.0.1:15432/postgres` (`compose.yaml`'s host port), passed to
  `parseConfig()`. The header's `Env:` list names it and says no database has to run.
- Before the change, on testnet with `DATABASE_URL` unset: `ConfigError: invalid configuration:
  DATABASE_URL is required` at `verify-smoke.ts:85`, exit 1.
- After it, same run with two friendbot-funded accounts: exit 0, `checks.validPayment: true`,
  `checks.channelRejected: true` (`extra.reason` = `invalid_exact_stellar_payload_channel_account`).
- `pnpm test` in `apps/facilitator`: 1165 passed, 3 skipped (compose PostgreSQL up).

## Design Decisions

### From Plan

1. **Fall back to `compose.yaml`'s URL rather than require one**: the verifiers open no store, so
   any `postgres://` URL satisfies the config; the same default as `token-matrix.ts`.

### Emerged

2. **`??`, not `?.trim() ||`**: a blank `DATABASE_URL=` still fails with "DATABASE_URL is
   required" (the config reads blank as unset). Kept as `??` to match `token-matrix.ts`,
   `spend-matrix.ts` and `catalog-smoke.ts`; changing it belongs in all of them at once.

## Issues Encountered

- **The compose URL is now in five files** (`test/database.ts`'s `COMPOSE_DATABASE_URL` and four
  live scripts). It can't be imported from `test/database.ts`, which imports vitest. Not changed
  here.
