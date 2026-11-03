---
title: "NOT_FOUND at the bound ledger: is the race real, and how to close it"
type: research
status: mature
tags: [facilitator, signer-pool, settlement, stellar-rpc]
links:
  - https://github.com/stellar/stellar-rpc/blob/c436cd7ddf60d0ce10130d73ad036b6b57051d48/cmd/stellar-rpc/internal/methods/get_transaction.go
  - https://github.com/stellar/stellar-rpc/blob/v30.0.0/cmd/stellar-rpc/internal/db/db.go
  - https://github.com/stellar/stellar-rpc/pull/1036
  - https://github.com/stellar/stellar-core/blob/v30.0.0/src/transactions/TransactionFrame.cpp
history:
  - date: "2026-11-02"
    status: mature
    who: akot
    note: "stellar-rpc, stellar-core and facilitator survey. Our code at develop b019d59."
  - date: "2026-11-02"
    status: mature
    who: akot
    note: "Margin raised from one ledger to three in the PR review of 0088, and given to maxTime too."
---

# NOT_FOUND at the bound ledger

**Recommendation: a three-ledger margin, `latestLedger >= maxLedger + 3`, only on `NOT_FOUND`, in
`confirm()` and `pastBound`.** One response decides, whichever node answered, with no state. It
costs three ledgers on `expired` answers only. The pre-send guards keep `>=`, and `fallback-rpc.ts:73`
needs correcting: a node near E can report too early. (✓ read in code, ~ inferred.)

## The race

- ✓ Real on released RPC: `get_transaction.go:49-51` reads the transaction, then the cached range.
  PR #619 chose that order to fix the reverse race, so it won't flip.
- ✓ v30.0.0 (`13e5351`, the default testnet URL's version) holds the cache lock across the SQLite
  commit, so the window is the commit: "tens to hundreds of milliseconds" (PR #1036). main
  (`c436cd7`, unreleased) narrows it; `rpcv2` reads one view and has no race.
- ~ The sweep is the main exposure (10 s timer, no prior read). `confirm()` reads after a clock tick,
  and a tick that showed E on the same node rules the miss out.

## Options

| | Added latency | RPC cost | Fallback RPC | Still wrong when (~) |
|---|---|---|---|---|
| **A. Margin, 1 ledger** | ~1 ledger; sweep 0-10 s | one more wait | unaffected | one request stalls from E's commit to E+1's publish |
| **A3. Margin, 3 ledgers** | ~3 ledgers; sweep 0-10 s | three more waits | unaffected | a node catching up: live, the stall is ~15 s and an answer gets 10 s |
| **B. Second read** | round trip | +1 read | may hit another node | two nodes at E, both in their commit window |
| **C. A + B** | ~1 ledger + round trip | both | unaffected | that stall, then the same on a second node |
| **D. Prior read ≥ bound** | ~0 | 0 in `confirm()`, +1 in sweep | as B | poll on X shows E, read goes to Y in its window |

B and D prove it only if both calls reach one node, which a URL doesn't show. ~ A's stall is 5 s+
live, one ingest cycle in catch-up. No data separates A from C, so C isn't justified. A3 needs no
data: `FallbackRpc` drops an answer after 10 s, so a live node can't produce that stall.

## maxTime

Core's rule needs no margin, the read does. ✓ Core rejects at `maxTime < closeTime` of the ledger
being closed (`TransactionFrame.cpp:1182`), so a close time past `maxTime` is a ledger after the
last one that could hold it. But the race is in the read: an answer can miss that last ledger, as it
can miss `maxLedger`, so `maxTime` takes the same margin in close time, 15 s (found in the PR
review). ✓ Only hashes from before 0073 carry `maxTime` (`submitter.ts:647`), and the pool's default
path.

## Cost of a wrong `expired`

✓ Final (`rules.ts:36`), and a sweep can beat the pool's later `SUCCESS`. ~ The seller has the money,
the buyer a failure saying "sign a new payment", so a repeat pays twice.

## How others decide

No project below compares `latestLedger` from a `NOT_FOUND` with a ledger bound: no precedent.
OpenZeppelin Relayer and its x402 plugin are left out (AGPL, ADR 0002).

| Who, commit | File:line | On not found |
|---|---|---|
| x402 Stellar `a17c668` | `stellar/src/exact/facilitator/scheme.ts:610-631` | timeout, then `failed` |
| x402 EVM, SVM exact | `evm/src/shared/settleReceipt.ts:58`, `svm/src/signer.ts:458` | timeout, then pending |
| x402 SVM batch | `svm/src/batch-settlement/facilitator/recovery.ts:122-139` | bound first, then a fresh read |
| r402 `dfb1d0c` | `r402-stellar/src/chain/provider.rs:208-219` | timeout, then `failed` |
| stellar-sdk `1ef3f77` | `rpc/server.ts:1244`, `contract/sent_transaction.ts:99` | no verdict |
| Launchtube `1821ebd` | `src/common.ts:129-140` | 30 s, then error |
| Wallets Kit `9db6b36` | not found | polls nothing itself |

## Also found

~ `confirm()` had no `historyCovers`, so a truncated node's `NOT_FOUND` ended `expired`. ✓ A
`landed` mark after a wrong `expired` was dropped unlogged (equal rank, `rules.ts:39`). 0088 fixes
both.
