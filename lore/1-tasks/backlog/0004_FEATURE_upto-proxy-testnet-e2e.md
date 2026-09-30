---
id: "0004"
title: "Deploy UptoProxy to testnet and run on-chain end-to-end tests"
type: FEATURE
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0002", "0003", "0005"]
tags: [layer-contracts, upto, testnet, priority-high, effort-medium]
links: []
history:
  - date: "2026-09-30"
    status: backlog
    who: claude
    note: "Task created with okarcz. Starts after 0003."
---

# Deploy UptoProxy to testnet and run on-chain end-to-end tests

## Summary

Deploy the contract from 0003 to `stellar:testnet`. Then run a scripted end-to-end suite that uses
the same role split and signing model the x402 facilitator will use. Record every transaction hash.

## Status: Backlog

> Blocked by 0003.

## Context

Unit tests run in the test host. This task proves the flow against real RPC simulation, real
auth-entry signing, fee sponsorship and real tokens. That flow is: the client signs auth entries
only, and the facilitator rebuilds the transaction as source with the actual amount, re-simulates,
signs and submits. No HTTP or x402 layer is involved yet. That comes later, with the facilitator.

## Implementation Plan

### Step 1: Deploy

A script in `deploy/scripts/` uploads the WASM and deploys the contract. Record the WASM hash and
contract ID in `deploy/testnet.env.example` as `UPTO_PROXY_CONTRACT_ID`. The script is idempotent
and friendly to testnet resets.

### Step 2: E2E harness

A TypeScript workspace package at `contracts/upto-proxy/e2e`, added to `pnpm-workspace.yaml`,
using `@stellar/stellar-sdk` and vitest. Confirmed by okarcz on 2026-09-30. It sets up
three roles: a client (funded with the token, never pays fees), a facilitator (the transaction
source and fee payer, and signs its own binding), and a seller (the recipient). Each test does
the following:
1. The client builds `settle_upto` with a placeholder amount, simulates it, and signs **only** the
   auth entries.
2. The facilitator swaps in the actual amount, re-simulates, checks that the auth tree is
   unchanged, rebuilds with itself as source, signs and submits.
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
