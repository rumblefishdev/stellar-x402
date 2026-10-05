---
id: "0006"
title: "Research how the upto settlement flow can scale"
type: RESEARCH
status: active
related_adr: []
related_tasks: ["0003", "0004", "0005"]
tags: [upto, facilitator, throughput, priority-medium, effort-medium]
links:
  - ../../archive/0003_FEATURE_upto-proxy-contract/notes/S-batching-and-throughput.md
history:
  - date: "2026-10-02"
    status: backlog
    who: okarcz
    note: "Spawned from 0003's batching discussion (S-batching-and-throughput)."
  - date: "2026-10-02"
    status: active
    who: okarcz
    note: "Started after 0003 closed."
---

# Research how the upto settlement flow can scale

## Summary

Find out how far the current `upto` flow scales and which changes raise that limit. Today one
payment is one transaction, and the facilitator submits from one account. The answer should say
which approach to build, with measured numbers, before the facilitator is designed for load.

## Status: Active

> Started 2026-10-02. Can run in parallel with 0004; its measurements feed 0005.
> 2026-10-05: all questions answered in notes, with testnet measurements. Awaiting okarcz review
> of the two S- notes before the follow-up backlog tasks are created.

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
- [ ] Follow-up implementation tasks created in the backlog
