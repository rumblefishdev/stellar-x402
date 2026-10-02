---
id: "0006"
title: "Research how the upto settlement flow can scale"
type: RESEARCH
status: backlog
related_adr: []
related_tasks: ["0003", "0004", "0005"]
tags: [upto, facilitator, throughput, priority-medium, effort-medium]
links:
  - ../../active/0003_FEATURE_upto-proxy-contract/notes/S-batching-and-throughput.md
history:
  - date: "2026-10-02"
    status: backlog
    who: okarcz
    note: "Spawned from 0003's batching discussion (S-batching-and-throughput)."
---

# Research how the upto settlement flow can scale

## Summary

Find out how far the current `upto` flow scales and which changes raise that limit. Today one
payment is one transaction, and the facilitator submits from one account. The answer should say
which approach to build, with measured numbers, before the facilitator is designed for load.

## Status: Backlog

> Not started. Can run in parallel with 0004; its measurements feed 0005.

## Context

0003's [S-batching-and-throughput](../../active/0003_FEATURE_upto-proxy-contract/notes/S-batching-and-throughput.md)
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

- [ ] Each question answered in a note, with testnet transaction hashes or measurements where
      it applies
- [ ] Throughput numbers for: single account, N channel accounts, and same-seller concurrency
- [ ] A recommendation (S- note) on what the facilitator builds, and whether the contract or
      spec needs to change
- [ ] Follow-up implementation tasks created in the backlog
