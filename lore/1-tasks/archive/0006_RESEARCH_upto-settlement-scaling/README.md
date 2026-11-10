---
id: "0006"
title: "Research how the upto settlement flow can scale"
type: RESEARCH
status: completed
related_adr: []
related_tasks: ["0003", "0004", "0005", "0007", "0008"]
tags: [upto, facilitator, throughput, priority-medium, effort-medium]
links:
  - ../../archive/0003_FEATURE_upto-proxy-contract/notes/S-batching-and-throughput.md
  - notes/S-facilitator-scaling.md
  - notes/S-session-aggregation.md
history:
  - date: "2026-10-02"
    status: backlog
    who: okarcz
    note: "Spawned from 0003's batching discussion (S-batching-and-throughput)."
  - date: "2026-10-02"
    status: active
    who: okarcz
    note: "Started after 0003 closed."
  - date: "2026-10-05"
    status: completed
    who: okarcz
    note: >
      PR #3 rebase-merged into develop (68eb851, fa7f7f0). 6 questions answered in 4 R- and 2 S-
      notes, with testnet measurements: 1 pending tx per account; N channels = N per ledger up to
      102-103 (the tx-size limit); no same-seller conflict; mainnet ~59% full. Recommendation:
      delegated-bump channel pool, no contract or spec change. Q4 (router) not pursued. Follow-ups:
      0007 (submitter), 0008 (batch-settlement binding, parked); throughput numbers added to 0005.
---

# Research how the upto settlement flow can scale

## Summary

Find out how far the current `upto` flow scales and which changes raise that limit. Today one
payment is one transaction, and the facilitator submits from one account. The answer should say
which approach to build, with measured numbers, before the facilitator is designed for load.

## Status: Completed

> Started 2026-10-02. Can run in parallel with 0004; its measurements feed 0005.
> 2026-10-05: all questions answered in notes, with testnet measurements (PR #3, merged).
> Follow-ups: 0007 (settlement submitter) and 0008 (batch-settlement binding, parked).

## Findings

- **Single account:** one pending transaction per source account, so about 0.2 settlements per
  second.
- **Channel pool:** N channels give N settlements per ledger, up to the network limit. 120
  channels reached 102–103 per ledger, which is the transaction-size limit (about 105, roughly 20
  per second network-wide).
- **Same seller:** no measurable conflict. Every ledger was one stage with one cluster.
- **Mainnet:** same limits as testnet (both on protocol 29), but about 59% of the Soroban size
  budget is already used, so about 43 settlements per ledger are free.
- **Recommended shape:** a channel account as transaction source, with the facilitator as signer
  and operation source, wrapped in a fee bump the facilitator pays (2,516 B, about 41,000 stroops).
  It is better than spike S8's address auth.
- **No change** to the contract or the `upto` spec. Sessions belong in a separate Stellar
  `batch-settlement` binding, if that is in scope.

## Notes

| Note | Answers |
|---|---|
| [R-network-limits-and-mainnet-usage](notes/R-network-limits-and-mainnet-usage.md) | Q5, plus the network ceiling |
| [R-testnet-throughput-measurements](notes/R-testnet-throughput-measurements.md) | Q2 and Q3 numbers, with tx hashes |
| [R-verify-cost](notes/R-verify-cost.md) | Q6 |
| [R-x402-batch-settlement](notes/R-x402-batch-settlement.md) | Q1 background (upstream schemes) |
| [S-session-aggregation](notes/S-session-aggregation.md) | Q1 |
| [S-facilitator-scaling](notes/S-facilitator-scaling.md) | Q2 and Q4, and the recommendation |

The bench code and raw results are in [`bench/`](bench/README.md).

## Context

0003's [S-batching-and-throughput](../../archive/0003_FEATURE_upto-proxy-contract/notes/S-batching-and-throughput.md)
found:

- Soroban allows one contract call per transaction.
- Network capacity is per ledger and per resource. On testnet that is about 110 settlements per
  ledger (about 22 per second, network-wide), with transaction size as the binding limit.
- Batching through a router contract would gain at most about 1.5–2×.

Its recommendation was session aggregation, a channel-account pool and fee bumps instead of
batching. This task checks that recommendation with evidence and turns it into a design input.

## Questions

1. **Session aggregation:** how should a client sign one ceiling for many requests (ceiling,
   deadline, allowance expiration), and how does the seller meter and settle once? What does this
   need from x402 `PaymentRequirements` and from the facilitator, and does it need any contract
   change?
2. **Channel accounts and fee bumps:** how many channel accounts does a target load need, how are
   they funded and rotated, and does fee-bump or address-auth sponsorship fit better (spike S8
   used address auth)?
3. **Parallel execution:** do concurrent settlements to the same seller conflict on the seller's
   balance entry and serialize? Measure on testnet.
4. **Batch router (optional):** does a client's entry authorize `settle_upto` when a router calls
   it below the top level, and can a "try" call isolate one failed settlement, auth failures
   included? Only if questions 1–3 leave a gap.
5. **Limits:** read mainnet's Soroban limits and compare them with testnet's.
6. **Verify path:** what does `/verify` cost per request (simulation via RPC), and when does a
   facilitator need its own RPC nodes?

## Acceptance Criteria

- [x] Each question answered in a note, with testnet transaction hashes or measurements where
      it applies
- [x] Throughput numbers for: single account, N channel accounts, and same-seller concurrency
- [x] A recommendation (S- note) on what the facilitator builds, and whether the contract or
      spec needs to change
- [x] Follow-up implementation tasks created in the backlog: 0007 (settlement submitter) and 0008
      (`batch-settlement` binding research, low priority)

## Implementation Notes

- **Bench:** `bench/bench.ts` and `bench/mainnet-usage.ts` (SDK 17.2.0, Node 24 type stripping,
  outside the pnpm workspace). They ran on testnet against proxy `CBEPV3F2…TEGY7` with 230
  clients, 20 sellers and 120 channels. Keys are in the git-ignored `bench/secrets/`. The 15
  result files in `bench/results/` contain only public keys and transaction hashes.
- **Runs:**
  - 6 transaction shapes;
  - a single-account burst of 20;
  - pool runs at 1, 5, 20, 50 and 120 channels (many sellers and one seller);
  - `/verify` at concurrency 1–300;
  - one hour (720 ledgers) of mainnet usage.

  About 1,900 settlements were made in total.
- **Sources:** upstream x402 `batch-settlement` (core, EVM, Cloudflare) and `auth-capture`
  specs, fetched at `751590a`.
- **0005 gained an "Input from 0006" section** with the throughput numbers for its testnet
  report.

## Issues Encountered

- **SDK 17 XDR objects:** `@stellar/stellar-sdk` 17.x returns XDR as plain objects with camelCase
  properties (`resultXdr.feeCharged`, `txSet.v1TxSet.phases`), not accessor methods. Code written
  for 16.x accessors throws. The bench pinned 17.2.0, the version the spike used.
- **Setup signer mistakes:** `tx_bad_auth_extra` came from channels signing a `createAccount`
  they were not the source of, and later from a channel that already had the facilitator as a
  signer also signing itself. Fixed in `setup` and `delegate`.
- **Early sequence reload:** a `getTransaction` poll failed with a fetch error while its
  transaction succeeded. The worker then reloaded the channel's sequence too early, and the next
  transaction failed with `tx_fee_bump_inner_failed`. This is a bench issue, but it became a rule
  for 0007.
- **Public RPC flakiness:** there was one connection failure at concurrency 100 that passed on
  rerun. Mainnet needs a third-party RPC; `mainnet.sorobanrpc.com` was used.
- **One-time rent:** the first settlement of the day paid 116,316 stroops to extend a persistent
  entry's TTL (most likely the SAC instance). It is not a per-payment cost.

## Design Decisions

### From Plan

1. **Measure on testnet with real settlements.** Each run is real `settle_upto` calls with their
   own client signatures, not synthetic transactions, so the sizes and fees are the ones a
   facilitator pays.
2. **Read mainnet's limits and compare them with testnet's (Q5).** They are identical except for
   the state target size.

### Emerged

3. **The `delegated-bump` shape:** the facilitator's key is a signer on each channel, so one
   signature covers both the channel and the facilitator as operation source. It was not in the
   task. It came up while comparing shapes, and it beat both the plan's fee-bump option and S8's
   address auth.
4. **A mainnet usage sample:** the task asked only for mainnet limits. The sample showed about
   59% of the limit is already used, which changes the practical ceiling from about 105 to about
   43 settlements per ledger.
5. **Q4 (router) skipped:** the remaining gap is the network's byte budget, which a router barely
   reduces.
6. **Sessions go to `batch-settlement`, not `upto`:** the upstream scheme was found during Q1.
   Stretching `upto` over a session was rejected (the seller is unsecured, and it breaks the
   spec).
7. **The client's auth entry is built locally in the bench,** with no client-side simulation. It
   matches the shape `require_auth_for_args` expects, and on-chain success confirms it.

## Future Work

- 0007: the facilitator's settlement submitter (`packages/signer-pool`).
- 0008: research a Stellar `batch-settlement` binding (parked, low priority).
