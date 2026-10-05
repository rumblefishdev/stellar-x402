---
id: "0007"
title: "Build the facilitator's settlement submitter on a channel-account pool"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0006", "0003"]
tags: [facilitator, signer-pool, throughput, upto, priority-medium, effort-large]
links:
  - ../archive/0006_RESEARCH_upto-settlement-scaling/notes/S-facilitator-scaling.md
  - ../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-testnet-throughput-measurements.md
  - ../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-verify-cost.md
  - ../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
history:
  - date: "2026-10-05"
    status: backlog
    who: claude
    note: "Spawned from 0006 future work (S-facilitator-scaling), requested by okarcz."
---

# Build the facilitator's settlement submitter on a channel-account pool

## Summary

Implement `packages/signer-pool`, the part of the facilitator that puts settlement transactions
on chain. One source account allows only one pending transaction, so one account gives at most 1
settlement per ledger. A pool of channel accounts gives about 1 per channel per ledger, up to the
network limit (about 105 per ledger, about 43 free on mainnet today). It serves `upto` now and
`exact` later, since both submit one Soroban call per payment.

## Context

- Architecture doc §3.3 plans a channel-account pool, and option (b) is a permissively licensed
  implementation of our own. **Clean room:** do not use, read or call OpenZeppelin's
  `relayer-plugin-channels` (AGPL).
- 0006 measured the design on testnet. Its numbers and reasons are in
  [S-facilitator-scaling](../archive/0006_RESEARCH_upto-settlement-scaling/notes/S-facilitator-scaling.md):
  - N channels gave N settlements per ledger.
  - 120 channels reached 102–103 per ledger.
  - Same-seller payments had no conflict.
  - The `delegated-bump` shape is the cheapest (2,516 B, about 41,000 stroops).
- The bench code in `0006…/bench/bench.ts` is a working reference for building, simulating,
  fee-bumping and placing transactions. It is research code, not production code.
- `packages/signer-pool` is an empty placeholder that pins `@stellar/stellar-sdk ^16.3.0`.
  **Testnet and mainnet are on protocol 29**, which needs SDK ≥ 17 to parse CAP-71 credentials.
  The bench used 17.2.0.

## Implementation Plan

### Step 1: Pool setup

- Create the channel accounts, each funded with the reserve only: 1 XLM, plus 0.5 XLM for the
  extra signer.
- Add the facilitator key as a signer on each channel (weight 1), with the option to set the
  channel's master weight to 0. The pool then needs only the facilitator key.
- Add, check and remove channels idempotently. Make the pool size configurable; the default comes
  from the target rate (step 4).

### Step 2: Transaction shape (`delegated-bump`)

- The channel is the transaction source, and the facilitator is the **operation** source of the
  contract call. Its `require_auth` then uses source-account credentials, not S8's address auth.
- Sign once with the facilitator key, then wrap the transaction in a fee bump that the
  facilitator pays. The channel never pays fees.
- Simulate with auth enforced, assemble, and re-check that the balance changes are only what
  §3.2 allows.
- Set the inclusion fee from `getFeeStats`; mainnet's p10–p99 was 200 stroops. Put a cap on the
  total fee, with headroom for one-time rent: a TTL extension cost 116,316 stroops once in 0006.

### Step 3: Scheduling and sequence tracking

- Keep one transaction in flight per channel, and queue settlements when every channel is busy.
- Track each channel's sequence number locally. **Reload it only after the in-flight transaction
  is final or past its time bound.** In 0006 the bench lost a transaction by reloading too early.
- Give every transaction a time bound. When ledgers are full, report `pending` rather than
  failure.

### Step 4: Pipelining and confirmation

- Find out about inclusion by watching new ledgers, or by batching status checks, instead of
  polling each transaction every 500 ms (about 10 RPC calls per settlement in 0006).
- While a channel's transaction is pending, prepare (build, simulate, sign) its next transaction
  for the next sequence number, and send it as soon as the previous one lands. Rebuild it if the
  previous one failed.
- Goal: about 1 channel per settlement per ledger instead of about 2. Measure it.

### Step 5: Zero-amount settlements

- When the actual amount is 0, submit no transaction and return `transaction: ""`, as the `upto`
  spec allows. Document the effect: the client's nonce stays unused until its deadline.

### Step 6: RPC and operations

- Use a configurable RPC URL with a fallback, plus metrics: in-flight count, queue depth,
  per-ledger landings and failures by result code.
- Alert when the facilitator's XLM balance falls below a threshold, since it pays every fee.

### Step 7: Testnet load test

- Port the 0006 bench scenarios to the real package: shapes, pool runs at 5, 20 and 50 channels,
  and one-seller vs many sellers.
- Record the throughput and the per-channel cycle with and without pipelining.

## Acceptance Criteria

- [ ] The pool creates, delegates and checks channels; channels hold only their reserve
- [ ] Settlements use the `delegated-bump` shape, signed with the facilitator key only
- [ ] At 50 channels on testnet: 50 settlements per ledger, 0 failures from the submitter
- [ ] No sequence-number errors under load, including after RPC errors during polling
- [ ] Pipelining measured: settlements per channel per ledger, before and after
- [ ] Zero-amount settlements submit nothing
- [ ] SDK ≥ 17; unit tests for scheduling and sequence handling; `typecheck`, `lint` and `test`
      pass

## Notes

- **Out of scope:** raising the network ceiling. That needs off-chain aggregation, a possible
  Stellar `batch-settlement` binding
  ([S-session-aggregation](../archive/0006_RESEARCH_upto-settlement-scaling/notes/S-session-aggregation.md)),
  which is not planned yet.
- **The `/verify` path** (simulation per request) belongs to the facilitator API, not this
  package. 0006's [R-verify-cost](../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-verify-cost.md)
  has its costs.
