---
id: "0058"
title: "Read accounts in the upto-proxy e2e harness without the SDK's masking catch"
type: BUG
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0051"]
tags: [tests, contracts, priority-low, effort-small, payments]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: "Spawned from 0051 future work."
  - date: "2026-11-16"
    status: backlog
    who: okarcz
    note: >
      Payments lane, M2 (okarcz, unlaned M1 check): accountExists still swallows every error and getAccount is still called.
---

# Read accounts in the upto-proxy e2e harness without the SDK's masking catch

## Summary

`contracts/upto-proxy/e2e/src/chain.ts` `accountExists` catches every error and returns `false`,
so during an RPC outage `fundIfMissing` calls friendbot for an account that already exists.
`chain.ts`, `upto.ts` and `world.ts` still call `server.getAccount`, which turns any RPC failure
into "Account not found" (0051). Test tooling, not the money path.

## Implementation

- Read accounts with signer-pool's `readAccountEntry` (or `getLedgerEntries` the same way): only
  no entry means missing; any other failure stays an error.

## Acceptance Criteria

- [ ] No e2e code calls `getAccount` / `getAccountEntry` or swallows an account-read error
