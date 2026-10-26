---
id: "0021"
title: "Testnet token matrix"
type: FEATURE
status: completed
milestone: 1
related_adr: ["0007"]
related_tasks: ["0012", "0009", "0018", "0004", "0066"]
tags: [facilitator, testnet, exact, priority-medium, effort-small, payments]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 1.7 (Payments lane)."
  - date: "2026-10-23"
    status: active
    who: okarcz
    note: "Work starts."
  - date: "2026-10-26"
    status: completed
    who: okarcz
    note: >
      PR #63 merged. USDC, a self-issued SAC and the non-SAC test token each verified and settled
      through the facilitator on testnet, the facilitator paying every fee; 4 of 6 concurrent
      payments landed in one ledger through 4 channels. The test token now publishes SEP-41
      events (redeployed at CBFIYRHJ…GV53). Follow-up: 0066.
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

- [x] Given testnet USDC, a self-issued SAC and a non-SAC SEP-41 token, when a scripted run verifies and settles a payment in each through the facilitator on testnet, then every payment settles and the buyer pays no XLM fee; there is no per-token code path and no asset allowlist
- [x] Given a batch of concurrent payments, when the run settles them across several channels, then more than one settles in the same ledger
- [x] Given the run's output, when it finishes, then the results, with every transaction hash, are committed to the repo

## Implementation Notes

- `apps/facilitator/scripts/token-matrix.ts`: friendbot funds a facilitator and a seller, the
  seller opens USDC and `UPTOE2E` trustlines, `buildCreateChannelsTx` makes 4 channels, and
  `main()` starts the facilitator. Each token then goes through one `pay(asset)`: `/verify`,
  `/settle`, the transaction read back from the chain (ledger, inner source = channel, fee
  source, fee charged) and the seller's balance before and after. A batch of 6 test-token
  payments is sent to `/settle` at once. The buyer's XLM and sequence number are read before
  the first payment and after the batch.
- Results: `apps/facilitator/scripts/results/token-matrix-testnet.json`, every hash, ledger,
  channel and fee, addresses only. Committed run (2026-10-23, 14:16 UTC, after the code review):
  every check passed. USDC settled in ledger 5348278 (fee 11,948 stroops), the SAC in 5348281
  (11,995), the test token in 5348283 (152,649, most of it the rent of the seller's new balance
  entry). Four of the six batch payments landed in ledger 5348285 through four different
  channels, the other two in 5348286. The buyer's XLM (9,999.99998) and sequence number were the
  same before and after. The two runs before the review's changes passed too (the last at
  14:05 UTC).
- The committed run restored nothing (`restoredBeforehand` all 0): the earlier runs had already
  restored 0004's `UPTOE2E` instance and the buyer's old test-token balance through
  `restoreArchived()`, which is how the restore path was tried on testnet.
- No per-token path: the script changes only `asset` in the requirements, and a search for an
  asset allowlist in `apps/facilitator/src` and `packages/signer-pool/src` finds none.
- `contracts/test-token` now publishes SEP-41 events (`transfer`, `approve`, `mint`), with a Rust
  test against the literal topics and data upstream's verifier reads; deployed by
  `deploy/scripts/deploy-contract.sh test-token` at
  `CBFIYRHJG4C4E4AU3K5XCCMSZKZR3IMVFPCKNAJ3OBRQCHDLPCT3GV53` (WASM SHA-256 `d3108f81…3d31`).

## Issues Encountered

- **0004's test token emitted no events.** Its `transfer` only moved storage, and upstream's
  `exact` verifier reads the simulated SEP-41 `transfer` event, so it answered
  `invalid_exact_stellar_payload_no_transfer_events`. 0004's upto path never looks at events,
  which is why nobody saw it. Fixed in the contract (decision 3); 0004's upto e2e deploys the
  token through the same script, so its next run gets the new ID.
- **Archived state made valid payments too expensive.** 0004's `UPTOE2E` SAC instance and the
  buyer's old test-token balance were archived. Since Protocol 23 the buyer's transaction
  restores them and pays their rent: 551,787 and 342,189 stroops of resource fee, above
  `MAX_FEE_STROOPS` (250,000), so `/verify` answered `fee_exceeds_maximum`. The script restores
  such entries first (decision 4); what the facilitator should do is 0066.
- **Restores from one account clash when run together** (sequence numbers), so they run one at a
  time.
- **A testnet RPC error on one run:** the buyer's simulation answered "setting ContractComputeV0
  is not present in the snapshot" once, after testnet moved to protocol 29; the rerun passed.
- **Code review (2026-10-23):** the event test compared the contract with its own structs, so a
  change of shape would pass; it now builds the topics and data by hand, and fails on a
  map-shaped `transfer`. The SAC-shape claim was wrong (the SAC adds the SEP-11 asset as a fourth
  topic). The script now reports a refused send with its status, checks the buyer's sequence
  number, and checks that one ledger holds settlements from more than one channel.

## Design Decisions

### From Plan

1. **One script beside the smoke runs** (okarcz, 2026-10-23): `apps/facilitator/scripts/token-matrix.ts`, run with `npx tsx`, built on `settle-smoke.ts` (a facilitator from `main()`, upstream's `exact` client). Not a vitest e2e package: four checks don't need one. Results go to `apps/facilitator/scripts/results/token-matrix-testnet.json`.
2. **The buyer is 0004's e2e client** (okarcz, 2026-10-23), passed as `CLIENT_SECRET`: testnet USDC comes only from Circle's faucet, and that account already holds it, so a run needs no manual step. The self-issued SAC is 0004's `UPTOE2E`; the facilitator, its channels and the seller are new each run.

### Emerged

3. **The test token gets SEP-41 events, and a new deployment** (okarcz, 2026-10-23): our own code in `contracts/test-token`, in the shape the SAC uses (`transfer` `[from, to]` with the amount as data, `approve` `[from, spender]` with `[amount, expiration_ledger]`, `mint` `[to]` with the amount), not a third-party token. The script names the deployment as a constant, overridable with `TEST_TOKEN`, rather than running `deploy-contract.sh` each time as 0004's e2e does, so the matrix needs no Rust toolchain.
4. **The script restores archived state before it pays** (okarcz, 2026-10-23): it simulates each token's transfer and, when the simulation lists archived entries, restores them from the facilitator account, the same way for every token. The results record how many entries each token needed (`restoredBeforehand`). The facilitator's own behaviour is 0066, a backlog task.
5. **The no-XLM-fee check compares the buyer's XLM and sequence number before the first payment and after the batch**: the same XLM shows nobody charged the buyer, the same sequence that the buyer sourced no transaction. Setup steps that touch the buyer (the test-token mint, a restore) are paid by the facilitator account and run before the first reading.

## Future Work

- **0066**: decide what `/verify` does when a payment must restore archived state.
