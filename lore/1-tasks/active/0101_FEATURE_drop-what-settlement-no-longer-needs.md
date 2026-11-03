---
id: "0101"
title: "Drop what the settlement modules no longer need"
type: FEATURE
status: active
related_adr: ["0001", "0004", "0012"]
related_tasks: ["0036", "0102", "0063"]
tags: [facilitator, signer-pool, refactor, priority-low, effort-medium]
links: []
history:
  - date: "2026-11-03"
    status: backlog
    who: karolkow
    note: >
      From an architecture review of develop: of ten candidates, these six small changes survived
      an attempt to refute each one.
  - date: "2026-11-03"
    status: active
    who: karolkow
    note: Starting with item 1, the packages with no importer.
---

# Drop what the settlement modules no longer need

## Summary

Code that has no production reader or that makes a caller know too much: statistics nobody reads,
packages nobody imports, attempts carried in a private map. Each item below is its own PR, smaller
than a day, and none changes what a client or a seller sees, except where it says so.

## Context

Figures are from `origin/develop` on 2026-11-03. Work each item from what is true when it starts:
#105 and #110 touch several of these files.

## Implementation

1. **`[structure only]`, ~50 min. Packages with no importer.** Delete `packages/sdk` (8 lines of
   empty exports) and `examples/mcp-metered`, the two `package.json` edges from `bazaar` and
   `signer-pool` to `config`, and `isAttemptForward` in `adapters/rules.ts`, which never had a
   caller (`git log -S`). Reword `README.md`, ADR 0001 and task 0092, which name `packages/sdk`.
   0102 keeps the RFP's SDK visible. The edge from the facilitator to `mcp` stays with 0063.
2. **`[refactor]`, 2–3 h, after #110. Submitter statistics.** `stats()` has 0 production readers,
   also in 0027's PRs: `main.ts` reads `onEvent`. Remove `SubmitterStats`, `stats()`,
   `refusalReason` and `RefusalReason`, about 128 lines; `stats.ts`'s event types stay. 33
   assertions in 6 test files move to `onEvent`. Also stop exporting `ChannelPool` and `LedgerClock`,
   which have no outside reader.
3. **`[refactor]`, ~1 h. Attempts as a plain property on the error.** Delete the `WeakMap` behind
   `attemptsOf` and the three `vi.mock`s of the package that exist because of it.
4. **`[structure only]`, ~1.5 h. What in `main.ts` isn't wiring.** Move `start()` to its own file,
   and `failureReason`, `upstreamDeadlineMs` and `buildUpstream` beside `upstream-failover.ts`.
5. **Changes behaviour on old records, ~1.5 h, after #110. One reader of the auth expiry.**
   `settle.ts` switches to `payerExpiration`; `authExpiration` and `fallbackLedger` go. First check
   on production that `SELECT count(*) FROM settlement_hashes WHERE max_ledger IS NULL` returns 0.
   If it doesn't, drop this item.
6. **`[refactor]`, ~30 min, after #105. One `resultUpdate(result)`.** `settle.ts` and `reconcile.ts`
   build the same update from a pool result, and #105 adds a line to both.

## Not yet decided

- Merging `packages/mcp` into `apps/mcp-local` (1–1.5 h, `[structure only]`): one importer, and e2e
  reaches across by relative path, but the interface is already 3 names. Layout is the owner's call.

## Out of scope

Each was measured against the fixes it should have prevented, and dropped:

- Private `Records` sets and one shared close: 0 of 6 fixes prevented, and `respond`'s timing would
  move with them.
- `submit()` returning every refusal in its result: 0 of 6 fixes prevented, unclassified throws
  still need a `catch`, 6–8 h.
- A shutdown module: 0 of 4 fixes prevented; `start()` is called by 10 test files without pools.
- Reading a payment once: 0 bugs from re-reading, and it moves where exceptions surface on the money
  path.
- Moving `fallback-rpc.ts` to the facilitator: the interface moves and doesn't shrink, and #110's
  `NOT_FOUND` margin relies on it.
- Dropping the port types or merging `port-contracts.ts` with `postgres.test.ts`: the ports hold the
  money-path ordering contract in words (ADR 0012 keeps them as the exit seam), and the suites test
  different things.

## Acceptance Criteria

- [ ] Each item is merged or dropped with its reason here
- [ ] Items 1, 3, 4 leave test assertions unchanged, apart from moved imports
