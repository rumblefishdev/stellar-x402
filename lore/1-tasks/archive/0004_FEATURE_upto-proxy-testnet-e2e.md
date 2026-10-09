---
id: "0004"
title: "Deploy UptoProxy to testnet and run on-chain end-to-end tests"
type: FEATURE
status: completed
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
  - date: "2026-10-08"
    status: completed
    who: okarcz
    note: >
      PR #8 rebase-merged into develop (0a8a0c5). Proxy deployed on testnet; the e2e suite
      (`pnpm contracts:e2e`) passed 49/49 across USDC, a self-issued SAC and the SEP-41 test
      token, with 21 settlement transactions. All 12 valid review points from Adam fixed;
      explorer links moved to sorobanscan. The report and findings went into 0005's docs.
---

# Deploy UptoProxy to testnet and run on-chain end-to-end tests

## Summary

Deploy the contract from 0003 to `stellar:testnet`. Then run a scripted end-to-end suite that uses
the same role split and signing model the x402 facilitator will use. Record every transaction hash.

**Story:** [M1 Story 5.1](../../../docs/planning/m1-epics.md#story-51-deploy-uptoproxy-to-testnet-and-run-on-chain-e2e-tests) · **Lane:** Payments

## Status: Completed

> Started 2026-10-08 on branch `lore-0004-upto-proxy-testnet-e2e`. 0003 is done.
> 2026-10-08: PR #8 rebase-merged into develop. Its testnet report now lives in
> `docs/upto-proxy-testnet-report.md` (task 0005, PR #12).

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
hash, explorer link, fee and resources. 0005 builds its report from it.

## Acceptance Criteria

- [x] The contract is deployed on testnet, with its ID and WASM hash recorded
- [x] Every scenario above runs on-chain with the expected outcome (rejections in the enforcing
  simulation against testnet, decision 4)
- [x] The client account never pays a fee (checked from the transaction results)
- [x] The results file lists every transaction hash
- [x] The suite reruns from a clean testnet state with one command (`pnpm contracts:e2e`; after a
  reset, USDC needs one faucet step, decision 3)

## Implementation Notes

- **Deploy:** `deploy/scripts/deploy-contract.sh <upto-proxy|test-token>`. UptoProxy is at
  `CC3VX7N6ILD63V7FS2JA7XUDX4DMHYEJXRZDOMU7GVW76XYINOAZ7OYU` (WASM
  `be2ba121…dd0b34`), recorded in `deploy/testnet.env.example`. The test token is at
  `CAFLGBBXESMRLBFNTG3USDML66437G74EACP3LVOUZPUUJDJQT3HMQEO` (WASM `937c7079…cb5973`).
- **Test token crate:** the non-SAC SEP-41 token moved from `upto-proxy/src/test/sep41_token.rs`
  to its own crate, `contracts/test-token`, so it can be built and deployed; `upto-proxy` uses it
  as a dev-dependency. `pnpm contracts:build` and CI now build every crate in the workspace.
- **E2E package:** `contracts/upto-proxy/e2e` (`@stellar-x402/upto-proxy-e2e`):
  - `src/chain.ts`: RPC helpers and `txReport` (fee, resources, sources, events from the chain).
  - `src/upto.ts`: the client and facilitator steps of the signing model.
  - `src/world.ts`: idempotent setup of accounts, trustlines, SACs, top-ups and channels.
  - `test/upto-proxy.e2e.test.ts`: 16 scenarios per token (3 settlements, 6 rejections, 5
    tampering cases, 2 concurrency cases) plus the client-fee check.
- **One command:** `pnpm contracts:e2e` (`E2E_TOKENS=sac,sep41` for a subset). Results go to
  `contracts/upto-proxy/e2e/results/testnet-results.json`.
- **Full run (2026-10-08, 13:41 UTC, after the PR #8 review):** 49/49 passed across USDC, the
  self-issued SAC and the test token, with 21 settlement transactions recorded. The client was
  funded with 20 USDC from the faucet. The first full run (46/46, 09:45 UTC) is replaced by it.
  - Fees charged at the ceiling: 40,907 stroops (USDC), 41,000 (SAC) and 35,925 (test token);
    zero settlements about 30,000.
  - Concurrent settlements from one payer landed in the same ledger through two channels, on the
    first attempt for every token.

## Design Decisions

### From Plan

1. **Deploy script in `deploy/scripts/`**, harness in `contracts/upto-proxy/e2e` with vitest.
2. **Delegated-bump submission** through `SettlementSubmitter` (ADR 0003, AD-2, AD-4).

### Emerged

3. **USDC comes from a persistent, manually funded client** (okarcz, 2026-10-08): Circle's
   faucet can't be scripted. Setup opens the trustline and stops with the faucet link when the
   client holds less than 0.5 USDC.
4. **Rejections are checked in simulation** (okarcz, 2026-10-08): the submitter's enforcing
   simulation against live testnet state refuses them, so they have no transaction hash.
5. **The salt is the WASM hash**: a rerun deploys nothing, changed code gets a new contract ID,
   and the same code returns under the same ID after a reset, for the same deployer. The ID is
   per deployer (PR #8 review, okarcz chose to document it): another key or a build that differs
   by a byte gives another ID, and setup warns when the proxy differs from
   `UPTO_PROXY_CONTRACT_ID`. A shared deployer key is for 0026 to decide.
6. **The client simulates with the facilitator as the source**: with the client as source, its
   auth is recorded as source-account credentials and there is no address entry to sign.
7. **Rejection scenarios sign without simulation** (`clientSignDirect`): recording-mode
   simulation runs the whole call, so it can't produce entries for terms the contract refuses.
8. **Exact errors pinned**: a replayed entry fails with `Error(Auth, ExistingValue)`; a different
   facilitator and every tampered field fail with `Error(Auth, InvalidAction)`.
9. **The suite is not part of `pnpm test`**: it needs testnet and funded accounts, so its script
   is `test:testnet`. CI still typechecks and lints it (eslint now ignores `contracts/target/`
   instead of all of `contracts/`).
10. **Explorer links go to sorobanscan** (okarcz, 2026-10-08): `explorerLink` points at
    `https://testnet.sorobanscan.rumblefish.dev/transactions/<hash>` on testnet and at
    `https://sorobanscan.rumblefish.dev` on mainnet, picked by the network passphrase.
11. **PR #8 review (Adam), all valid points applied** (okarcz, 2026-10-08):
    - the same-ledger scenario now runs the full per-settlement checks through `checkSettled`,
      and retries up to 3 times when the two submits straddle a ledger close;
    - every settlement asserts the leftover allowance (`max_amount - actual_amount`; for the
      same-ledger pair, either value, since which `approve` ran last is unknown);
    - a fifth tampering case: another facilitator rewrites the `facilitator` argument to itself
      and submits with its own authorization, so only the client's signature refuses it;
    - setup checks `sendTransaction` status for channels, saves secrets after each channel call
      and writes `accounts.json` with mode 600;
    - the results file records `tokensRun` and `otherChannels`;
    - "the client pays nothing" now reads "no settlement fees": setup pays its trustline fees
      (200 stroops), before the fee check's baseline.

## Issues Encountered

- **No client entry from simulation**: the first run simulated with the client as source; fixed
  by decision 6.

## Findings for 0005

- **Leftover allowance:** after a settlement the proxy keeps `max_amount - actual_amount` of
  allowance until `allowance_expiration_ledger` (750,000 after settling a quarter of 1,000,000;
  the full ceiling after a zero settlement). Every settlement asserts it. The threat model should
  cover it.
