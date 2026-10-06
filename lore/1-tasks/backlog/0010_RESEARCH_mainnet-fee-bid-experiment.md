---
id: "0010"
title: "Measure inclusion-fee bids against inclusion delay on mainnet"
type: RESEARCH
status: backlog
related_adr: []
related_tasks: ["0007", "0006"]
tags: [fees, mainnet, throughput, priority-medium, effort-small]
links:
  - ../active/0007_FEATURE_facilitator-settlement-submitter.md
  - ../../../docs/x402-settlement-scaling-en.md
history:
  - date: "2026-10-06"
    status: backlog
    who: claude
    note: "Spawned from 0007 future work and the PR #4 review (S3 in the scaling analysis)."
---

# Measure inclusion-fee bids against inclusion delay on mainnet

## Summary

Find the bid that gets a settlement into the next mainnet ledger under today's load (S3 in the
[settlement scaling analysis](../../../docs/x402-settlement-scaling-en.md)). 0007 step 8 built
`feeEscalation` but deliberately did not measure it on mainnet.

## Context

- Mainnet is about 81% full on average, mostly with KALE bots bidding 100–200 stroops. A
  200-stroop bid loses in about half the ledgers.
- **Unexplained fees from 0007.** On testnet, the unpipelined 120-channel run averaged 50,442
  stroops per settlement, some at 81,924. Every other run stayed at about 41,000. The step 8
  control pair is recorded in 0007.

## Implementation

- Send real settlements on mainnet at 3 bids (200, 500 and 1,000 stroops). Record the ledgers
  between send and inclusion, and the fee charged.
- Repeat at different times of day.
- Explain the 81,924-stroop charges: look at their ledgers' transaction sets and inclusion fees.
- Recommend defaults for `feeEscalation` (`factor`, `max`) and `maxFeeStroops`.

## Acceptance Criteria

- [ ] A bid → delay → fee table for mainnet
- [ ] The 81,924-stroop testnet charges explained
- [ ] Recommended `feeEscalation` and `maxFeeStroops` defaults
