---
id: "0051"
title: "Report an RPC failure on an account read as an error, never as account not found"
type: BUG
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0007", "0009", "0020", "0049"]
tags: [signer-pool, rpc, payments, priority-high, effort-small]
links:
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-21"
    status: backlog
    who: karolkow
    note: >
      Found while building 0020's startup channel check: stellar-sdk turns every RPC error on an
      account read into "Account not found", so an outage looks like a missing channel.
---

# Report an RPC failure on an account read as an error, never as account not found

## Summary

`rpc.Server.getAccountEntry` in `@stellar/stellar-sdk` 16.3.0 (`lib/esm/rpc/server.js:138-150`)
wraps its `getLedgerEntries` call in a bare `catch { throw new Error("Account not found: …") }`,
and `getAccount` calls it. 17.2.1, the latest release, has the same catch. So a 503, a refused
connection or a timeout on an account read reaches the pool as "Account not found", and
`isNotFound` (`src/errors.ts`) reads it as an answer. Account reads must tell the two apart: an
empty `entries` answer is "not found", any other failure stays an error.

**Lane:** Payments

## Context

Three places act on the false "not found" (each measured by a red test in
`packages/signer-pool/test/account-reads.test.ts`, a JSON-RPC stub over HTTP):

- **`checkChannel`** (`src/setup.ts`) returns `missing` for a 503 and for a refused connection.
  Its doc says other RPC errors are thrown. 0020's startup check (PR #51) relies on it.
- **`FallbackRpc.call`** (`src/fallback-rpc.ts`) throws the first endpoint's error when every
  endpoint failed. For an account read that error is "Account not found", so an outage of every
  endpoint looks like an answer. PR #41 adds `RpcUnavailableError` but passes not-found errors
  through as they are, so it keeps this.
- **`SettlementSubmitter.readSequence`** (`src/submitter.ts`) retires a channel
  (`channel-quarantined`) when the read still says "not found" after `timeoutSeconds`. An RPC
  outage longer than that takes live channels out of the pool until restart; once all are out,
  every `/settle` fails with `no-channels`. Nothing is sent, so no money moves, but settlements
  stop.

Measured on testnet (2026-10-21): `getLedgerEntries` for an account that does not exist answers
`200 {"result":{"entries":[],"latestLedger":…}}`; an unknown method answers a JSON-RPC error
`-32601 "method not found"`.

## Decisions so far

| Situation | What happens | Date |
|---|---|---|

## Not yet decided

- Where the account read lives (FallbackRpc's endpoints, or one function on `getLedgerEntries`).
- Whether 0007's "Account not found under load" (30 of 2,400 first reads at 200 channels) was
  rate limiting masked by the same catch. A read-only burst on the public testnet RPC answers it.

## Acceptance Criteria

- [ ] Given every RPC endpoint answers 503 or refuses the connection, when `checkChannel` reads a
      channel, then it throws instead of returning `missing`
- [ ] Given every endpoint fails an account read, then `FallbackRpc` throws an error that is not
      read as not-found
- [ ] Given account reads fail with 503 past `timeoutSeconds`, then the submitter refuses the call
      and keeps the channel in the pool
- [ ] Given the RPC answers no entry for a channel, then `checkChannel` returns `missing` and the
      submitter still retires the channel after `timeoutSeconds`
- [ ] 0007's "Account not found under load" is confirmed or refuted with a testnet measurement
