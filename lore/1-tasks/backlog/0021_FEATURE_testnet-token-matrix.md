---
id: "0021"
title: "Testnet token matrix"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0007"]
related_tasks: ["0012", "0009", "0018"]
tags: [facilitator, testnet, exact, priority-medium, effort-small, payments]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 1.7 (Payments lane)."
---

# Testnet token matrix

## Summary

As a seller pricing in any SEP-41 token, I want evidence that verify and settle work for every kind of token, so that I can charge in my own token, not only USDC.

**Story:** [M1 Story 1.7](../../../docs/planning/m1-epics.md#story-17-testnet-token-matrix) · **Lane:** Payments · **Covers:** FR4 (AD-9); NFR6, NFR8

## Context

- AD-9: verification is token-agnostic; the asset comes from `paymentRequirements` and the simulated balance changes are checked.
- 0004 deploys the non-SAC test token from 0003; reuse it if it already exists on testnet.
- Related tasks: 0009, 0018.

## Implementation

- A testnet script that creates or reuses the three tokens, funds a buyer and runs verify + settle against a locally running facilitator.
- A concurrent batch to show settlements spread across channels in one ledger.
- Results file with hashes, committed.

## Acceptance Criteria

- [ ] Given testnet USDC, a self-issued SAC and a non-SAC SEP-41 token, when a scripted run verifies and settles a payment in each through the facilitator on testnet, then every payment settles and the buyer pays no XLM fee; there is no per-token code path and no asset allowlist
- [ ] Given a batch of concurrent payments, when the run settles them across several channels, then more than one settles in the same ledger
- [ ] Given the run's output, when it finishes, then the results, with every transaction hash, are committed to the repo
