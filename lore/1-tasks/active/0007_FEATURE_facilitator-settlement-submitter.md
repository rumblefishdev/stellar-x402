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
  - ../../../docs/x402-settlement-scaling-en.md
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
  - date: "2026-10-06"
    status: active
    who: claude
    note: >
      Scope updated from docs/x402-settlement-scaling-en.md (Adam): step 8 (queue-aware fee bid,
      ADR-R2) added; step 7 takes S4's targets; mainnet free capacity corrected to ~20 upto
      per ledger.
  - date: "2026-10-06"
    status: active
    who: claude
    note: >
      Step 8: feeEscalation in the submitter (base bid x factor per full round of queued calls,
      capped; fee-raised event; feeRaises in stats). Off by default. 40 tests (+5). Testnet
      20x80: 60 raised bids, fees charged unchanged (~43,900).
  - date: "2026-10-06"
    status: active
    who: claude
    note: >
      Step 7: 7 testnet runs at 100/150/200 channels (7,050 payments). 200 channels: steady 98.9
      per ledger with ledgers 94-105% full (the network cap); one seller 95.5; no pipelining
      75.8. 0 sequence errors. 30 RPC "Account not found" refusals on first sequence reads.
  - date: "2026-10-06"
    status: active
    who: claude
    note: >
      Sequence reads retried once per ledger up to timeoutSeconds (read-retry event,
      readRetries in stats). 42 tests (+2). Testnet rerun, 200 channels and one seller:
      1,200/1,200, 8 read retries, 0 refusals.
---

# Build the facilitator's settlement submitter on a channel-account pool

## Summary

Implement `packages/signer-pool`, the part of the facilitator that puts settlement transactions
on chain. One source account allows only one pending transaction, so one account gives at most 1
settlement per ledger. A pool of channel accounts gives about 1 per channel per ledger, up to the
network limit (about 105 `upto` per ledger network-wide). Mainnet is about 81% full, mostly with
KALE bots bidding 100–200 stroops, so at a 200-stroop bid about 20 `upto` per ledger are free on
average (13 at the median, per the 2026-10-06 analysis). It serves `upto` now and `exact` later,
since both submit one Soroban call per payment.

## Status: Active

> Started 2026-10-05 on branch `lore-0007-facilitator-settlement-submitter`.
> 2026-10-05: first slice in PR #4 (steps 1–3). Step 6 added on the same branch, along with a fix
> for thrown sends; there are now 30 unit tests. Steps 4 and 7 are still open (see Progress).
> 2026-10-06: step 4 measured and built. Beyond about 50 channels the cycle fell back to 2
> ledgers, so pipelining was built. Up to 90 channels, 82% of channel cycles are now 1 ledger,
> up from 36%. Also fixed: an `onSent` that throws no longer releases a pending channel.
> 35 unit tests. Step 7 is still open.
> 2026-10-06: scope updated from Adam's
> [settlement scaling analysis](../../../docs/x402-settlement-scaling-en.md):
> - step 8 added (a queue-aware fee bid);
> - step 7 now uses its S4 targets;
> - the mainnet numbers were corrected.
>
> Both steps come after the PR #4 review.
> 2026-10-06: step 8 built (`feeEscalation`), with 40 unit tests and a testnet check.
> 2026-10-06: step 7 done. At 200 channels the pool fills testnet's ledgers (a steady 98.9 per
> ledger, which is the network cap), with 0 sequence errors. It also found RPC "Account not
> found" refusals, now fixed by retrying the sequence read (Emerged 13).

## Progress

**Done in `packages/signer-pool`:**

| File | What it does |
|---|---|
| `src/channel-pool.ts` | `ChannelPool`: one holder per channel, FIFO waiters; `handOver` to the next waiter while the transaction is pending |
| `src/submitter.ts` | `SettlementSubmitter`: `delegated-bump` shape; simulate, `checkSimulation` hook, fee cap, sign, fee bump, send, confirm; the sequence rules; pipelining (`pipeline`, default on); a queue-aware fee bid (`feeEscalation`, default off); a sequence read retried once per ledger |
| `src/ledger-clock.ts` | `LedgerClock`: one shared `getLatestLedger` poll; each pending transaction is checked once per new ledger |
| `src/setup.ts` | `buildCreateChannelsTx` (1.5 XLM reserve, the facilitator as signer, master key disabled; at most 19 channels per tx because of the 20-signature limit) and `checkChannel` |
| `src/fees.ts` | `feeStatsInclusionFee`: bids a `getFeeStats` percentile, clamped and cached, with a fallback |
| `src/signer.ts` | `keypairSigner`: the SEP-43 `signTransaction` shape, the same as `@x402/stellar` |
| `src/fallback-rpc.ts` | `FallbackRpc`: tries several endpoints in order, with per-call timeouts; the endpoint that answers becomes active. `sendTransaction` is never retried inside it |
| `src/stats.ts` | `SubmitterEvent` (`sent`, `send-retry`, `read-retry`, `prepared-ahead`, `fee-raised`, `final`, `refused`) through `onEvent`, and `submitter.stats()`: results by status, refusals, error codes, send and read retries, prepared-ahead used/rebuilt, fee raises and the highest bid, fees, and landings per ledger |
| `src/balance.ts` | `checkFacilitatorBalance`: spendable XLM after reserve, sponsorships and liabilities; settlements left; a `low` flag |
| `test/` | 42 tests (4 for pipelining, 5 for fee escalation, 2 for read retries) against a fake RPC that enforces sequence numbers and one pending tx per source. 30 seeded mutations were checked (16 in the first slice, 4 for pipelining, 6 for fee escalation, 4 for read retries): every real fault was caught, and the 3 survivors were equivalent (harmless; see Emerged 9 and 11) |
| `scripts/testnet-smoke.ts` | Creates delegated channels, then settles real UptoProxy payments. Reports the per-channel cycle (`cycleGaps`). `PIPELINE=0` and `POLL_MS` switch pipelining off and set the poll interval. `FEE_MAX` turns fee escalation on. `SELLERS=1` runs the one-seller scenario. `CHANNELS_FILE` reuses channels across runs. It also reports the steady mean and every ledger's total Soroban use next to ours, and counts refusals |

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

**Step 8: fee escalation** (2026-10-06): 20 channels × 80 payments, `FEE_MAX=1000`.

- 80 of 80 settled, at 20 per ledger, with 0 errors.
- 60 envelopes were built with a raised bid, the highest 800 stroops (3 rounds of backlog × 2³).
- The fee charged stayed at about 43,900 stroops per settlement, as in runs with no raise. In
  ledgers that aren't full, Stellar charges the network's base inclusion fee, not the bid, so a
  raised bid costs extra only in contested ledgers.

**Step 7: load test** (2026-10-06, S4 in the scaling analysis).

- Pool reused across runs (`CHANNELS_FILE`, 200 channels).
- "Steady" is the mean per ledger without the first and the last ledger.
- "Ledger fill" is everyone's Soroban envelope bytes as a share of the 266,240 B limit. It is
  approximate (it reads above 100% when the ledger is full).

| Channels × payments | Sellers | Pipelining | Settled | Steady per ledger | 1-ledger cycles | Ours / all Soroban txs in a full ledger | Ledger fill | Wall clock |
|---|---|---|---|---|---|---|---|---|
| 100 × 800 | 20 | on | 800 | 64.5 | 386 / 700 (55%) | 100 / 113 | up to 102% | 61.5 s |
| 100 × 800 | 1 | on | 800 | 68.1 | 413 / 700 (59%) | 100 / 107 | up to 102% | 61.0 s |
| 100 × 800 | 20 | off | 800 | 53.5 | 190 / 700 (27%) | 100 / 110 | up to 102% | 78.6 s |
| 150 × 1,050 | 20 | on | 1,050 | 87.9 | 319 / 900 (35%) | 106 / 111 | up to 105% | 62.5 s |
| 200 × 1,200 | 20 | on | 1,200 | **98.9** | 140 / 1,000 (14%) | 108 / 111 | 94–105% | 69.0 s |
| 200 × 1,200 | 1 | on | 1,186 + 14 refused | **95.5** | 270 / 986 (27%) | 110 / 113 | 91–105% | 68.8 s |
| 200 × 1,200 | 1 | on, with the read retry | 1,200 | 89.9 | 125 / 1,000 (13%) | 107 / 111 | 86–105% | 76.3 s |
| 200 × 1,200 | 20 | off | 1,184 + 16 refused | 75.8 | 4 / 984 (0.4%) | 108 / 116 | 0–105%, alternating | 87.6 s |

- **Every run: 0 sequence errors, 0 failed or expired transactions, and 0 rebuilt prepared
  envelopes.** There was 1 send retry in total.
- Fees averaged 41,000–41,500 stroops per settlement in every run, so there was no surge.
- **From 100 channels on, the network cap binds, not the pool.**
  - A ledger with 100 of ours is at about 100% of the byte limit.
  - At 200 channels, almost every ledger is full (94–105%), with ours at about 90–97% of its
    Soroban transactions.
  - The steady 98.9 per ledger is the ceiling: about 105 transactions fit, and testnet's own
    traffic takes the rest.
  - The "1-ledger cycles" share falls as channels grow, because more channels than seats means
    each one waits its turn.
- **Pipelining:**
  - At 100 channels, steady 64.5 vs 53.5 per ledger, and 55% vs 27% 1-ledger cycles.
  - At 200 channels, 98.9 vs 75.8 per ledger. Without pipelining the ledgers alternate full and
    nearly empty (108, 92, 97, 93, 10…).
- **One seller vs many:** no meaningful difference (95.5 vs 98.9 at 200, 68.1 vs 64.5 at 100).
  This matches 0006.
- **Refusals: "Account not found" from the public RPC.**
  - In the two 200-channel reruns, 14 and 16 submissions were refused when the submitter first
    read a channel's sequence (`getAccount`). That is 200 reads at once from a fresh submitter.
  - The channels exist (verified on Horizon), and `checkChannel` had passed seconds earlier.
  - Nothing was sent, so this is safe, but those payments failed when a retry would have
    succeeded.
  - The first attempt of these two runs crashed the script, so `Promise.allSettled` now counts
    refusals instead.
  - **Fixed** (Emerged 13). The rerun of 200 channels with one seller settled 1,200/1,200: 8
    failed reads recovered on the next ledger and 0 were refused.

**Open:**

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
11. **Fee escalation lives in the submitter, not in the fee provider.**
    - Only the submitter sees the queue, and it already emits events and keeps stats.
    - Any `inclusionFee` (a number or `feeStatsInclusionFee`) is the base bid.
    - The signal is backlog in rounds of the whole pool, `floor(queued / channels)`. One full
      round waiting means transactions are not landing every ledger.
    - Each round multiplies the base by `factor` (default 2), up to `max` (default 1,000). The
      bid never goes below the base, and it falls back as the queue drains (no state is kept).
    - **Off by default,** so a library user does not pay more without opting in. The
      facilitator app turns it on.
    - **Known limit:** if the pool is simply too small for the incoming load, a queue also
      builds and the bid rises without helping. That is bounded by `max`, and in uncontested
      ledgers the bid isn't charged (see the step 8 testnet note).
    - A pending envelope keeps its bid. Only envelopes built afterwards get the raise.
    - Of 6 seeded mutations, 5 were caught. The survivor was equivalent: removing the
      "0 rounds" early return, where `factor⁰ = 1` gives the base bid anyway.
12. **Fix: an `onSent` that throws is ignored, like `onEvent`.**
    - Before the fix, the throw escaped while the transaction was pending, and the channel was
      released early. The next call on it then reused the sequence number and was rejected
      with `txBadSeq`.
    - Found while reviewing step 4. A regression test covers it.
13. **The public testnet RPC can answer "Account not found" for an existing account under
    load.** Found by the step 7 load test.
    - It hit the first sequence read of 200 channels at once: 30 of 2,400 submissions.
    - The submitter refuses such a submission before sending anything, which is safe but loses a
      payment that would have settled.
    - **Fix:** `readSequence` retries the read once per new ledger, for up to `timeoutSeconds`,
      before refusing. This is safe because nothing has been sent.
      - Each retry emits `read-retry` and is counted in `stats().readRetries`.
      - A channel that really is gone is refused after `timeoutSeconds`.
      - On the testnet rerun, 8 reads were retried and 0 were refused.
      - All 4 seeded mutations were caught.
    - The smoke script now counts refusals (`Promise.allSettled`) instead of crashing.


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
- Adam's [settlement scaling analysis](../../../docs/x402-settlement-scaling-en.md) (2026-10-06)
  recommends this pool (option A0) as the production path for `exact` and `upto`. Its proposed
  ADR-R1 to R6 feed this task:
  - R2: the fee bid regulates throughput. That is step 8.
  - S4: the load test. That is step 7.
  - Its mainnet sample: 81% of the Soroban byte budget used on average, 47% of ledgers more than
    90% full, about 98% of it KALE.
  - Its `settlement_pending` response and durable settlement registry belong to the facilitator
    app, not this package. `onSent` already gives the hash early.
  - It assumes 1.5–2 channels per target settlement per ledger. With pipelining (step 4) it is
    about 1 up to 90 channels.
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

### Step 7: Testnet load test (S4 in the scaling analysis)

- Run the real package through `scripts/testnet-smoke.ts` at 100–200 channels, with one seller
  and with many sellers, with and without pipelining (`PIPELINE=0`).
  - The smoke script cycles through all 20 sellers. A "one seller" mode needs a small flag.
- Target: a steady 100 or more settlements per ledger on testnet, and 0 sequence errors.
  - Testnet carries other traffic, so record the ledgers' total Soroban usage next to ours.
- Record the throughput, the per-channel cycle (`cycleGaps`), fees per settlement, and the
  `stats()` snapshot for each run.
- The 2026-10-06 run at 120 channels (peaks of 106, a mean of 80, 0 errors) is the first data
  point.

### Step 8: Queue-aware inclusion fee (ADR-R2 in the scaling analysis)

- **Why:** on mainnet a 200-stroop bid loses in about half the ledgers. Free capacity depends on
  the bid, not on the protocol.
- **Today:** `feeStatsInclusionFee` bids a fixed percentile of recent fees. It does not react to
  our own backlog.
- **Change:** raise the bid while calls wait in the pool's queue, up to a configured ceiling, and
  lower it again when the queue drains.
  - Count every raise in `stats()`, and emit an event for it.
  - Keep the total under `maxFeeStroops`. A 1,000-stroop bid adds about 2% to an `upto`
    settlement.
- **Out of scope:** the mainnet bid-to-delay experiment (S3). This step builds the mechanism and
  unit-tests it.

## Acceptance Criteria

- [x] The pool creates, delegates and checks channels; channels hold only their reserve
- [x] Settlements use the `delegated-bump` shape, signed with the facilitator key only
- [x] At 50 channels on testnet: 50 settlements per ledger, 0 failures from the submitter
- [x] No sequence-number errors under load, including after RPC errors during polling and
      sending (unit tests; 0 sequence errors in the testnet runs)
- [x] Pipelining measured: settlements per channel per ledger, before and after (2026-10-06,
      90 and 120 channels; see Step 4 under Progress)
- [x] Load test with S4's targets on testnet: a steady ≥100 per ledger at 100–200 channels, one
      seller and many, with and without pipelining, 0 sequence errors (step 7; 2026-10-06).
      - 98.9 steady at 200 channels, with the ledgers at 94–105% of the byte limit. This is the
        network ceiling, so the remaining gap to 100 is testnet's own traffic.
      - 0 sequence errors in every run.
      - 30 of 2,400 refused by RPC "Account not found" before the read-retry fix; 0 of 1,200
        after it (Emerged 13).
- [x] The inclusion-fee bid rises with the pool's queue up to a ceiling, and each raise is
      counted in `stats()` (step 8: `feeEscalation`, `fee-raised`, `feeRaises`)
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
