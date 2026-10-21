---
id: "0051"
title: "Report an RPC failure on an account read as an error, never as account not found"
type: BUG
status: active
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
  - date: "2026-10-21"
    status: active
    who: karolkow
    note: >
      Red tests for the three effects, the fix (readAccountEntry on getLedgerEntries) and a testnet
      burst that reproduces masked 502 and -32603 reads. The owner chose one read function.
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
| The pool reads an account | One function, `readAccountEntry`, calls `getLedgerEntries`; `SorobanRpc` and `FallbackRpc` no longer carry `getAccount` or `getAccountEntry` | 2026-10-21 |
| The RPC answers no entry | `AccountNotFoundError`: `checkChannel` returns `missing`, `readSequence` retires the channel after `timeoutSeconds` | 2026-10-21 |
| The read fails (error status, refused connection, timeout, JSON-RPC error) | The error is thrown as it is; `checkChannel` throws, `readSequence` refuses the call and keeps the channel | 2026-10-21 |
| The read gets a JSON-RPC error answer | `rpc.Server` throws it as a plain `{ code, message }` object; `readAccountEntry` throws it as an `Error` naming the code and message, so logs and events carry it | 2026-10-21 |

## Measurement: 0007's "Account not found under load"

**Hypothesis:** 0007's 30 of 2,400 "Account not found" first reads at 200 channels were RPC
failures masked by the SDK's catch, not an RPC answer of no entry.

**Result: supported, not proven for the 2026-10-06 run** (its raw errors were not kept). Read-only,
public testnet RPC, one client, 2026-10-21 11:30–11:35 UTC. Accounts: 480 existing testnet
accounts, drawn from Horizon's recent transactions and checked with `getLedgerEntries`.

| Run | Client | Load per burst | Reads | Failed reads | Empty answer for an existing account |
|---|---|---|---|---|---|
| 1 | plain `fetch` | 200 or 400 reads | 1,400 | 0 | 0 |
| 2 | SDK `rpc.Server` (axios), `getLedgerEntries` | 200 reads + 200 simulates, or 400 + 400 | 2,800 | 24 | 0 |

- Run 2's failures came in 2 of 7 bursts: 21 × HTTP 502 (an HTML error page), all in one burst
  that also failed 45 of 200 simulates; 3 × JSON-RPC `-32603` "could not query captive core:
  http request failed with non-200 status code (404)". `getAccountEntry` turns each into
  "Account not found".
- The RPC never answered no entry for an account that exists. No 429 and no rate-limit headers:
  this looks like the RPC's front end failing under load, not rate limiting.
- It cannot show: the 2026-10-06 errors themselves, or whether the simulates trigger the 502s
  (3 of 5 equal bursts were clean).

**To repeat run 2:** a fresh Node process builds one `rpc.Server` for
`https://soroban-testnet.stellar.org` and fires, in one `Promise.all`, N calls of
`server.getLedgerEntries(accountKey)` (one existing account each) and N calls of
`server.simulateTransaction(tx)`, where `tx` calls the native XLM SAC's `balance` for an existing
account (source `new Account(id, "0")`, fee 100, nothing submitted). Record each rejection's
constructor, message, `code`, `response.status` and the JSON-RPC error object; count results with
0 entries. Bursts of N = 200 five times, then N = 400 twice, about 10 s apart.

## Acceptance Criteria

- [x] Given every RPC endpoint answers 503 or refuses the connection, when `checkChannel` reads a
      channel, then it throws instead of returning `missing`
- [x] Given every endpoint fails an account read, then `FallbackRpc` throws an error that is not
      read as not-found
- [x] Given account reads fail with 503, a JSON-RPC error or a timeout past `timeoutSeconds`, then
      the submitter refuses the call and keeps the channel in the pool
- [x] Given the RPC answers no entry for a channel, then `checkChannel` returns `missing` and the
      submitter still retires the channel after `timeoutSeconds`
- [x] 0007's "Account not found under load" is confirmed or refuted with a testnet measurement
