---
id: "0152"
title: "One compose database URL for the live scripts, with blank DATABASE_URL read as unset"
type: REFACTOR
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0081", "0064"]
tags: [facilitator, scripts, tests, priority-low, effort-small, dev-tools]
links: []
history:
  - date: "2026-11-18"
    status: backlog
    who: bstruzyk
    note: >
      Spawned from 0081's PR review (#202, karczuRF): the blank-value handling and the duplicated
      compose URL lived only in 0081's notes.
---

# One compose database URL for the live scripts, with blank DATABASE_URL read as unset

## Summary

Four live scripts fall back to `compose.yaml`'s database when `DATABASE_URL` is unset, each with
its own copy of the URL and with `??`, so a blank `DATABASE_URL=` passes through and the config
refuses it as "DATABASE_URL is required". Give them one shared URL and one reading of the variable
that treats blank as unset, as the config does.

## Context

- **Scripts that fall back** (`apps/facilitator/test/live/`): `token-matrix.ts:69`,
  `spend-matrix.ts:75`, `catalog-smoke.ts:50` and `verify-smoke.ts:50` (0081), each
  `process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:15432/postgres"`.
- **Scripts that require it** and keep doing so: `settle-smoke.ts`, `api-key-smoke.ts`,
  `nonce-consumed-elsewhere.ts`. Two of their headers quote the URL as the local one:
  `settle-smoke.ts:29`, `api-key-smoke.ts:21`.
- **The URL in code**: those four scripts plus `test/database.ts:9` (`COMPOSE_DATABASE_URL`, not
  exported). The scripts can't import it from there: `test/database.ts` imports vitest.
  `deploy/testnet.env.example:25` quotes it too.
- **Blank means unset**: `parseEnv` in `src/config.ts` trims each value and drops a blank one, so
  `DATABASE_URL=` reads as missing. `??` only falls back on `undefined`.

## Implementation

- A small module with no vitest import (e.g. `apps/facilitator/test/compose-database.ts`)
  exporting the compose URL, and a helper that returns `DATABASE_URL` trimmed, or the compose URL
  when it is unset or blank.
- `test/database.ts` imports the URL from it; the four scripts use the helper.
- The headers of `settle-smoke.ts` and `api-key-smoke.ts` keep naming the URL in prose, or point
  at the module; decide which.

## Acceptance Criteria

- [ ] The compose URL is defined once in code; `test/database.ts` and the four scripts use it
- [ ] Given `DATABASE_URL=` (blank), when any of the four scripts starts, then it uses the compose URL
- [ ] The three scripts that require `DATABASE_URL` still require it
- [ ] Typecheck, lint and format clean; `pnpm test` in `apps/facilitator` passes
