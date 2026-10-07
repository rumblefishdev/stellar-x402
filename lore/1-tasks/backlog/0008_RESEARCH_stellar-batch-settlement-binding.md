---
id: "0008"
title: "Research a Stellar binding for the x402 batch-settlement scheme"
type: RESEARCH
status: backlog
related_adr: []
related_tasks: ["0006", "0007"]
tags: [x402, batch-settlement, session, throughput, priority-low, effort-large, payments]
links:
  - ../archive/0006_RESEARCH_upto-settlement-scaling/notes/S-session-aggregation.md
  - ../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-x402-batch-settlement.md
history:
  - date: "2026-10-05"
    status: backlog
    who: claude
    note: "Spawned from 0006 future work (S-session-aggregation). okarcz: park it, revisit after the RFP deliverables or when a high-volume user appears."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Tagged Payments lane by 0012 (outside T1)."
---

# Research a Stellar binding for the x402 batch-settlement scheme

## Summary

Design how x402's `batch-settlement` scheme would work on Stellar. The client escrows funds
once, signs a running total off-chain per request, and the seller claims many channels in one
transaction. This is the only way past the network's per-ledger ceiling, which 0006 measured. It
is not part of the RFP deliverables, so the task is parked at low priority.

## Context

- **The ceiling.** One `upto` or `exact` payment is one transaction, which caps a facilitator at
  the network's share:
  - about 43 settlements per ledger (about 8/s) on mainnet today;
  - about 105 per ledger (about 20/s) at best.

  See 0006's
  [S-session-aggregation](../archive/0006_RESEARCH_upto-settlement-scaling/notes/S-session-aggregation.md).
- **The upstream scheme.** x402 has a `batch-settlement` scheme with EVM, Solana and Cloudflare
  bindings, but none for Stellar. 0006's
  [R-x402-batch-settlement](../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-x402-batch-settlement.md)
  summarizes the EVM binding. Copies of the specs are in 0006's `sources/`.
- **Options already rejected in 0006:** stretching one `upto` authorization over a session (the
  seller is unsecured, and it breaks the spec) and a batch router (at most 1.5–2×).
- **When to start:** once the RFP deliverables are done, or when a concrete high-volume user (for
  example agent traffic or sub-cent pricing) needs more than about 8 payments per second.

## Questions

1. **Escrow contract:**
   - functions: `deposit`, batched `claim`, `settle`, cooperative `refund`, and
     `initiate_withdraw` / `finalize_withdraw` with a delay;
   - channel identity: a hash of the config XDR, with network and contract bound in;
   - storage and TTL plan for channels that live up to 30 days.
2. **Vouchers:** the format, and an ed25519 `payer_authorizer` checked with `ed25519_verify`
   versus the payer's `require_auth`. What does each cost inside a batched claim?
3. **Claim batching:** how many claims fit in one transaction (the 400-entry footprint and tx
   size)? Does a per-receiver accumulator become a hot entry?
4. **x402 fit:**
   - the `PaymentRequirements.extra` fields and payload types (`deposit`, `voucher`, `refund`);
   - what `/verify` and `/settle` do;
   - the commitment identifier.
5. **Trust and risk:** client exposure, the seller's claim deadline before a withdraw finalizes,
   and what happens when server state is lost.
6. **Throughput:** requests per second per channel, and transactions per session. Measure them
   with a spike on testnet.
7. **Scope and effort:** contract, spec (`scheme_batch_settlement_stellar.md`), SDK and
   facilitator. Is upstreaming realistic?

## Acceptance Criteria

- [ ] Each question answered in a note
- [ ] A testnet spike: deposit, N off-chain vouchers, one batched claim, refund; with tx hashes
- [ ] An S- note recommending go or no-go, with the effort estimate
- [ ] If go: follow-up tasks for the contract, the spec and facilitator support
