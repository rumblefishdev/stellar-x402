---
id: "0004"
title: "Deploy UptoProxy to testnet and run on-chain end-to-end tests"
type: FEATURE
status: active
milestone: 1
related_adr: []
related_tasks: ["0002", "0003", "0005", "0012", "0016"]
tags: [layer-contracts, upto, testnet, priority-high, effort-medium, payments]
links:
  - ../../../docs/planning/m1-epics.md
history:
  - date: "2026-09-30"
    status: backlog
    who: claude
    note: "Task created with okarcz. Starts after 0003."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Aligned with the 0012 M1 spine: settlements use the delegated-bump shape through signer-pool (ADR 0003, AD-2, AD-4)."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Mapped to M1 Story 5.1 (Payments lane) by 0012."
  - date: "2026-10-08"
    status: active
    who: okarcz
    note: "Started while the 0017 types PR (#7) waits for review."
---

# Deploy UptoProxy to testnet and run on-chain end-to-end tests

## Summary

Deploy the contract from 0003 to `stellar:testnet`. Then run a scripted end-to-end suite that uses
the same role split and signing model the x402 facilitator will use. Record every transaction hash.

**Story:** [M1 Story 5.1](../../../docs/planning/m1-epics.md#story-51-deploy-uptoproxy-to-testnet-and-run-on-chain-e2e-tests) · **Lane:** Payments

## Status: Active

> Started 2026-10-08 on branch `lore-0004-upto-proxy-testnet-e2e`. 0003 is done.

## Context

Unit tests run in the test host. This task proves the flow against real RPC simulation, real
auth-entry signing, fee sponsorship and real tokens. That flow is: the client signs auth entries
only, and the facilitator swaps in the actual amount, re-simulates and submits through
`packages/signer-pool` in the delegated-bump shape (ADR 0003; spine AD-2, AD-4): a channel is the
transaction source, the facilitator is the operation source and pays the fee bump. No HTTP or x402 layer is involved yet. That comes later, with the facilitator.

## Implementation Plan

### Step 1: Deploy

A script in `deploy/scripts/` uploads the WASM and deploys the contract. Record the WASM hash and
contract ID in `deploy/testnet.env.example` as `UPTO_PROXY_CONTRACT_ID`. The script is idempotent
and friendly to testnet resets.

### Step 2: E2E harness

A TypeScript workspace package at `contracts/upto-proxy/e2e`, added to `pnpm-workspace.yaml`,
using `@stellar/stellar-sdk` and vitest. Confirmed by okarcz on 2026-09-30. It sets up
three roles: a client (funded with the token, never pays fees), a facilitator (the operation
source and fee-bump payer behind a channel account, and signs its own binding), and a seller (the recipient). Each test does
the following:
1. The client builds `settle_upto` with a placeholder amount, simulates it, and signs **only** the
   auth entries.
2. The facilitator swaps in the actual amount, re-simulates, checks that the auth tree is
   unchanged, and submits through `SettlementSubmitter` (channel source, fee bump).
3. Check the balance deltas, the events, the nonce state and the fee paid.

### Step 3: Scenarios

- Settle below the ceiling, at the ceiling, and at zero.
- Rejected: over the ceiling, a replayed nonce or auth entry, too early, expired, and a different
  facilitator.
- Tampering: changing the recipient, token, ceiling or nonce breaks the signature.
- Concurrency: two open authorizations from one payer settle both one after the other and in the
  same ledger.
- Tokens: all three are required, as confirmed by okarcz: Circle testnet USDC, a self-issued asset
  through the SAC, and the in-repo non-SAC SEP-41 test token from 0003, deployed to testnet.

### Step 4: Output

A machine-readable results file listing each scenario with its pass or fail result, transaction
hash, stellar.expert link, fee and resources. 0005 builds its report from it.

## Acceptance Criteria

- [ ] The contract is deployed on testnet, with its ID and WASM hash recorded
- [ ] Every scenario above runs on-chain with the expected outcome
- [ ] The client account never pays a fee (checked from the transaction results)
- [ ] The results file lists every transaction hash
- [ ] The suite reruns from a clean testnet state with one command
