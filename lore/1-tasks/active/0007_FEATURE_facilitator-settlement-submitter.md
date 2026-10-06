---
id: "0007"
title: "Build the facilitator's settlement submitter on a channel-account pool"
type: FEATURE
status: active
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
  - date: "2026-10-05"
    status: active
    who: okarcz
    note: "Started after 0006 closed."
  - date: "2026-10-06"
    status: active
    who: claude
    note: >
      Step 4: the cycle reverted to 2 ledgers above ~50 channels, so pipelining was built
      (handOver to the next waiter). 90 channels: 1-ledger cycles 36% -> 82%, mean 50 -> 64
      per ledger; 120: 68.6 -> 80. 34 tests (+4).
---

# Build the facilitator's settlement submitter on a channel-account pool

## Summary

Implement `packages/signer-pool`, the part of the facilitator that puts settlement transactions
on chain. One source account allows only one pending transaction, so one account gives at most 1
settlement per ledger. A pool of channel accounts gives about 1 per channel per ledger, up to the
network limit (about 105 per ledger, about 43 free on mainnet today). It serves `upto` now and
`exact` later, since both submit one Soroban call per payment.

## Status: Active

> Started 2026-10-05 on branch `lore-0007-facilitator-settlement-submitter`.
> 2026-10-05: first slice in PR #4 (steps 1–3). Step 6 added on the same branch, along with a fix
> for thrown sends; there are now 30 unit tests. Steps 4 and 7 are still open (see Progress).
> 2026-10-06: step 4 measured and built. Beyond about 50 channels the cycle fell back to 2
> ledgers, so pipelining was built. Up to 90 channels, 82% of channel cycles are now 1 ledger,
> up from 36%. Also fixed: an `onSent` that throws no longer releases a pending channel.
> 35 unit tests. Step 7 is still open.

## Progress

**Done in `packages/signer-pool`:**

| File | What it does |
|---|---|
| `src/channel-pool.ts` | `ChannelPool`: one holder per channel, FIFO waiters; `handOver` to the next waiter while the transaction is pending |
| `src/submitter.ts` | `SettlementSubmitter`: `delegated-bump` shape; simulate, `checkSimulation` hook, fee cap, sign, fee bump, send, confirm; the sequence rules; pipelining (`pipeline`, default on) |
| `src/ledger-clock.ts` | `LedgerClock`: one shared `getLatestLedger` poll; each pending transaction is checked once per new ledger |
| `src/setup.ts` | `buildCreateChannelsTx` (1.5 XLM reserve, the facilitator as signer, master key disabled; at most 19 channels per tx because of the 20-signature limit) and `checkChannel` |
| `src/fees.ts` | `feeStatsInclusionFee`: bids a `getFeeStats` percentile, clamped and cached, with a fallback |
| `src/signer.ts` | `keypairSigner`: the SEP-43 `signTransaction` shape, the same as `@x402/stellar` |
| `src/fallback-rpc.ts` | `FallbackRpc`: tries several endpoints in order, with per-call timeouts; the endpoint that answers becomes active. `sendTransaction` is never retried inside it |
| `src/stats.ts` | `SubmitterEvent` (`sent`, `send-retry`, `prepared-ahead`, `final`, `refused`) through `onEvent`, and `submitter.stats()`: results by status, refusals, error codes, retries, prepared-ahead used/rebuilt, fees, and landings per ledger |
| `src/balance.ts` | `checkFacilitatorBalance`: spendable XLM after reserve, sponsorships and liabilities; settlements left; a `low` flag |
| `test/` | 35 tests (4 for pipelining) against a fake RPC that enforces sequence numbers and one pending tx per source. 20 seeded mutations were checked (16 in the first slice, 4 for pipelining): every real fault was caught, and the 2 survivors were equivalent (harmless; see Emerged 9) |
| `scripts/testnet-smoke.ts` | Creates delegated channels, then settles real UptoProxy payments. Reports the per-channel cycle (`cycleGaps`). `PIPELINE=0` and `POLL_MS` switch pipelining off and set the poll interval |

**Testnet results** (2026-10-05, proxy `CBEPV3F2…TEGY7`):

| Channels | Payments | Settled | Per ledger |
|---|---|---|---|
| 5 | 25 | 25 | 5, 5, 5, 5, 5 |
| 50 | 200 | 200 | 50, 50, 50, 36, 14 |
| 20, via `FallbackRpc` with a dead first endpoint | 80 | 80 | 20, 20, 20, 20 |

- Channel setup txs: `78ff2f0d…99f5`, `538d52a8…528a`, `98f13e86…9f22`.
- Example settlement: `df257e4c…abb6`, at 43,941 stroops.
- **Each channel lands one payment per ledger at up to 50 channels,** where the 0006 bench
  managed one every other ledger. Above that, the 2026-10-06 runs show the cycle growing again.

**Step 4: pipelining** (2026-10-06, same proxy).

- "1-ledger cycles" counts, over every pair of consecutive landings on the same channel, how many
  were one ledger apart.
- The "before" runs are the submitter with no pipelining.
- 0 failures, 0 send retries, and 0 rebuilt prepared envelopes in every run.

| Channels × payments | Pipelining | Per ledger | Mean per ledger | 1-ledger cycles | Wall clock |
|---|---|---|---|---|---|
| 90 × 450 | off | 90, 18, 90, 32, 58, 56, 62, 37, 7 | 50.0 (9 ledgers) | 129 / 360 (36%) | 46.3 s |
| 90 × 450 | on | 90, 79, 55, 90, 70, 62, 4 | 64.3 (7 ledgers) | 294 / 360 (82%) | 37.5 s |
| 90 × 450 | on, 250 ms poll | 90, 75, 78, 82, 76, 47, 2 | 64.3 (7 ledgers) | 311 / 360 (86%) | 35.3 s |
| 120 × 480 | off | 102, 36, 100, 20, 105, 64, 53 | 68.6 (7 ledgers) | 111 / 360 (31%) | 35.7 s |
| 120 × 480 | on | 106, 89, 99, 87, 33, 66 | 80.0 (6 ledgers) | 218 / 360 (61%) | 32.2 s |
| 0006 bench, 120 × 480 | — | peak 103 | 59.6 (8 ledgers) | about 2 ledgers per cycle | — |

- **Below the network cap** (90 channels), pipelining cut most 2-ledger cycles.
  - The unpipelined pattern was 90, 18, 90, 32. The post-landing work (status check, simulate,
    sign) missed the next ledger for most channels.
  - Prepared ahead, the next envelope goes out as soon as the landing is seen.
- **At the cap** (120 channels), the ledgers stay near full (106, 89, 99, 87) instead of
  alternating 102/36. The remaining 2-ledger cycles are mostly network queueing, not the
  submitter.
- **A 250 ms poll adds little** (82% → 86%) for 4× the `getLatestLedger` calls. The default stays
  at 1,000 ms.
- **Fees.** The unpipelined 120-channel run averaged 50,442 stroops per settlement, with some
  charged 81,924, which is probably surge pricing on full ledgers. The pipelined 120 run averaged
  41,000. One run each; not investigated further.

**Open:**

- Step 7: a recorded load test at 20 channels and with one seller vs many.
- Wiring into the facilitator app and an `upto` scheme, which is a separate task.

**Emerged:**

1. **Stay on SDK 16.3, not 17.** 16.3 already parses CAP-71 `AddressV2` credentials, fee bumps
   and protocol 29 meta. That was verified against real testnet transactions and ledgers. It is
   the version `@x402/stellar` uses, so there is one SDK copy and the classic XDR API.
   - The "≥ 17" premise came from 0002, which compared 15.x with 17.x.
2. **Zero-amount skipping belongs to the scheme, not the pool.** The pool submits whatever call
   it is given; the `upto` scheme decides not to call it for 0. So step 5 moves to the
   scheme/facilitator task.
3. **Confirmation uses `getTransaction` per pending hash, triggered by the ledger clock,** not
   `getTransactions`. The latter returns every transaction in the ledger with full meta (about
   300 per ledger on mainnet).
4. **At most 19 channels per setup transaction:** each new channel signs its `setOptions`, and a
   transaction holds at most 20 signatures. Found by the 50-channel smoke run.
5. **Fix: a send that throws is "uncertain", not failed.** The first slice let a thrown
   `sendTransaction` escape. The channel was then released while the transaction might still
   land, so a payment could settle while the facilitator reported an error. Now:
   - the same envelope is resent (same hash, so this is safe);
   - a `txBadSeq` after an uncertain attempt is resolved by hash, because it may mean "already
     applied";
   - an expiry after an uncertain attempt re-reads the sequence.

   Found while designing step 6.
6. **The fallback never retries `sendTransaction` internally.** A retry there would hide the
   uncertainty from the submitter. The fallback moves the active endpoint and rethrows.
7. **Metrics are events, not a metrics library.** The package stays independent of any metrics
   library; the facilitator app forwards `onEvent` to whatever monitoring it uses.
8. **Pipelining hands the channel to the next queued call; there is no separate pre-build
   queue.**
   - Once a transaction is accepted (`PENDING`) and calls are waiting, the channel goes to the
     oldest waiter (`ChannelPool.handOver`).
   - That waiter builds, simulates and signs for the next sequence number, then waits until the
     pending transaction is final.
   - It sends only if that transaction used its sequence number and at least half the time
     bound is left. Otherwise it rebuilds, so `checkSimulation` can run twice.
   - A channel returns to the pool only after every transaction on it is final, even when the
     next call is refused before sending.
   - Only one transaction can be pending per source, so the depth is one envelope ahead.
9. **The sequence check before sending a prepared envelope is redundant today.** The seeded
   mutation that removed it survived. Every path that leaves a sequence number unused is an
   expiry, and by then the prepared envelope is also past half its time bound. The check stays
   as a direct guard. The other 3 seeded mutations were caught: no wait before release, sending
   without waiting, and ignoring `pipeline: false`.
10. **Known limit: a prepared envelope is simulated against pre-landing state.** For different
    clients, the footprints don't overlap except for shared read-mostly entries and the seller
    trustline. All 1,380 settlements in the pipelined testnet runs succeeded, 1,080 of them
    sent from prepared envelopes. This is the same risk as any Soroban transaction applied
    after other transactions in its ledger.
11. **Fix: an `onSent` that throws is ignored, like `onEvent`.**
    - Before the fix, the throw escaped while the transaction was pending, and the channel was
      released early. The next call on it then reused the sequence number and was rejected
      with `txBadSeq`.
    - Found while reviewing step 4. A regression test covers it.


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
- `packages/signer-pool` was an empty placeholder pinning `@stellar/stellar-sdk ^16.3.0`.
  Testnet and mainnet are on protocol 29. SDK 16.3 handles it (see Emerged 1).

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

- [x] The pool creates, delegates and checks channels; channels hold only their reserve
- [x] Settlements use the `delegated-bump` shape, signed with the facilitator key only
- [x] At 50 channels on testnet: 50 settlements per ledger, 0 failures from the submitter
- [x] No sequence-number errors under load, including after RPC errors during polling and
      sending (unit tests; 0 sequence errors in the testnet runs)
- [x] Pipelining measured: settlements per channel per ledger, before and after (2026-10-06,
      90 and 120 channels; see Step 4 under Progress)
- [ ] Zero-amount settlements submit nothing (moved to the scheme layer, see Emerged 2)
- [x] Unit tests for scheduling and sequence handling; `typecheck`, `lint` and `test` pass
      (SDK 16.3 is enough, see Emerged 1)

## Notes

- **Out of scope:** raising the network ceiling. That needs off-chain aggregation, a possible
  Stellar `batch-settlement` binding
  ([S-session-aggregation](../archive/0006_RESEARCH_upto-settlement-scaling/notes/S-session-aggregation.md)),
  which is not planned yet.
- **The `/verify` path** (simulation per request) belongs to the facilitator API, not this
  package. 0006's [R-verify-cost](../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-verify-cost.md)
  has its costs.
