---
id: "0081"
title: "Pass DATABASE_URL to the token matrix and verify smoke scripts"
type: BUG
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0064", "0073", "0021"]
tags: [facilitator, scripts, testnet, priority-low, effort-small]
links: []
history:
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073's PR 1 review (deferred item): the settle smoke script got the fix in
      2cadd78, the other two scripts did not.
---

# Pass DATABASE_URL to the token matrix and verify smoke scripts

## Summary

Since 0064 every store is PostgreSQL and the config requires `DATABASE_URL`. Two testnet scripts
don't pass it, so they stop at startup with "DATABASE_URL is required" before checking anything.

## Context

- `apps/facilitator/scripts/token-matrix.ts` (0021) starts the facilitator with `main({...})` and
  passes only its own keys, RPC and port.
- `apps/facilitator/scripts/verify-smoke.ts` doesn't run `main()`, but builds its verifiers from
  `parseConfig({...})`, which requires `DATABASE_URL` too, though the verifier never opens a store.
- 0073 fixed the same break in `settle-smoke.ts` (2cadd78): pass `process.env.DATABASE_URL` and
  document it in the header's variable list.

## Implementation

- `token-matrix.ts`: pass `DATABASE_URL: process.env.DATABASE_URL` to `main()`, and add it to the
  header's variables as in `settle-smoke.ts` (required, migrated, the local URL from `compose.yaml`).
- `verify-smoke.ts`: pass it to `parseConfig()` the same way, and say in the header that the
  config needs it even though the script uses no store. Any valid URL works there; decide whether
  to require the real one or fall back to the local `compose.yaml` URL.
- Check the run commands in the facilitator README still work.

## Acceptance Criteria

- [ ] Given a migrated local PostgreSQL and `DATABASE_URL` set, when `token-matrix.ts` runs on
      testnet, then it starts and runs its matrix
- [ ] Given the same, when `verify-smoke.ts` runs on testnet, then it starts and checks its payments
- [ ] Given either script's header, when it is read, then `DATABASE_URL` is in its variable list
