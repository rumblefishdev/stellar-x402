---
id: "0152"
title: "One compose database URL for the live scripts, with blank DATABASE_URL read as unset"
type: REFACTOR
status: active
owner: bstruzyk
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
  - date: "2026-11-26"
    status: active
    who: bstruzyk
    note: >
      Started: one compose database URL for the live scripts and test/database.ts, and blank
      DATABASE_URL read as unset in the four scripts that fall back to it.
---

# One compose database URL for the live scripts, with blank DATABASE_URL read as unset

## Summary

Four live scripts fall back to `compose.yaml`'s database when `DATABASE_URL` is unset, each with
its own copy of the URL and with `??`, so a blank `DATABASE_URL=` passes through and the config
refuses it as "DATABASE_URL is required". The URL is also copied into `test/database.ts` and
quoted in two script headers. Give the code one shared URL, the headers one place to point at, and
the four scripts one reading of the variable that treats blank as unset, as the config does.

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
- The headers of `settle-smoke.ts:29` and `api-key-smoke.ts:21`: point at the module instead of
  carrying their own copy, or keep the URL in prose with the module named as its source; decide
  which.

## Acceptance Criteria

- [x] The compose URL is defined once in code; `test/database.ts` and the four scripts use it
- [x] Given the headers of `settle-smoke.ts` and `api-key-smoke.ts`, when they are read, then they
      name where the compose URL is defined
- [x] Given `DATABASE_URL=` (blank), when any of the four scripts starts, then it uses the
      compose URL
- [x] The three scripts that require `DATABASE_URL` still require it
- [x] Typecheck, lint and format clean; `pnpm test` in `apps/facilitator` passes

## Implementation Notes

- `apps/facilitator/test/compose-database.ts` (new, no imports): `COMPOSE_DATABASE_URL` and
  `databaseUrlOrCompose(env = process.env)`, which returns `DATABASE_URL` trimmed, or the compose URL
  when it is unset or blank. `test/compose-database.test.ts` (new, 4 tests): unset, empty and
  blank fall back; a set value is trimmed.
- `test/database.ts` imports `COMPOSE_DATABASE_URL` instead of defining it.
- `token-matrix.ts`, `spend-matrix.ts`, `catalog-smoke.ts` and `verify-smoke.ts` call
  `databaseUrlOrCompose()`; their headers say the default also applies to a blank value and name
  the module.
- `settle-smoke.ts`, `api-key-smoke.ts`: the header names `COMPOSE_DATABASE_URL` in the module
  instead of quoting the URL. They and `nonce-consumed-elsewhere.ts` still pass
  `process.env.DATABASE_URL` to the config, which requires it.
- Checks (2026-11-26): typecheck of the facilitator; eslint and prettier on the changed files;
  `pnpm test` in `apps/facilitator` against the compose PostgreSQL, 1393 passed and 3 skipped (+4).
  `test/compose-database.test.ts` is the 55th file in the suite (54 on `develop`).
- Runs of the scripts (2026-11-26), each against the `develop` version for contrast:
  - `token-matrix.ts` without `CLIENT_SECRET`, so it stops after its database step: blank,
    unset and all-spaces `DATABASE_URL` recreate `token_matrix` in the compose database, then stop
    at `CLIENT_SECRET`; a set `DATABASE_URL` (port 1) is used as given (`ECONNREFUSED 127.0.0.1:1`).
    On `develop` a blank one stops at `new URL("")` with `TypeError: Invalid URL`, not at the
    config.
  - `verify-smoke.ts` with two fresh friendbot accounts: blank and all-spaces `DATABASE_URL` give
    `validPayment: true`, `channelRejected: true`. On `develop` a blank one stops with
    `ConfigError: invalid configuration: DATABASE_URL is required`.
  - `catalog-smoke.ts`, the whole run on testnet with a blank `DATABASE_URL`: exit 0, six
    settlements `SUCCESS` (first `c43c063b…`, last `2fe7d080…`), all five steps as 0063 and 0085
    describe them; the last attempt is `not_askable` with reason `redirect`. Its five attempt rows
    are in `catalog_smoke` in the compose database.
  - `settle-smoke.ts`, `api-key-smoke.ts`, `nonce-consumed-elsewhere.ts`, unset and blank: each
    stops with `DATABASE_URL is required`, as before.
  - `spend-matrix.ts` not run: it needs the contracts' wasm built with cargo, and spends a few
    minutes of testnet setup before its database step. Its change is the same call as the others'.

## Design Decisions

### Emerged

1. **The headers point at the module, not at a copy of the URL**: the task left it open. A URL
   quoted in prose goes stale the way the code copies did, while `COMPOSE_DATABASE_URL` in
   `test/compose-database.ts` is found with one search.
2. **The four fallback scripts' headers name the module too**: not in the criteria, which name
   only the two that require the variable. They quoted the compose port, and now say a blank value
   falls back as well, so the reader learns the new behaviour where the variable is described.
3. **`deploy/testnet.env.example` keeps its quoted URL**: it is an env file a person copies, not
   code, and the server never uses the compose database.
