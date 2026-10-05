---
title: "Testnet throughput: single account, channel pools and same-seller concurrency"
type: research
status: mature
spawns:
  - notes/S-facilitator-scaling.md
tags: [upto, throughput, testnet, evidence, channel-accounts, fee-bump]
links:
  - ../bench/README.md
  - ../bench/results/
  - R-network-limits-and-mainnet-usage.md
history:
  - date: "2026-10-05"
    status: mature
    who: claude
    note: "Bench runs on stellar:testnet against UptoProxy CBEPV3F2…TEGY7 (questions 2 and 3)"
---

# Testnet throughput: single account, channel pools and same-seller concurrency

All numbers come from [`bench/bench.ts`](../bench/bench.ts), run on 2026-10-05 against the 0003
deployment. The proxy is `CBEPV3F2FBNUXFSXFS6Q5R6D45KZADCUGCB62KBNWGFCCCMWL26TEGY7`, the token is
the `UPSPIKE` SAC `CCH46PUSMDVRYST4IC5QZ32OCSFGQV2SDM5MOJW3ETBYG5326OKHNQ2P`, and the facilitator
is `GA2YE73M…TR5Z`. The bench created 230 clients, 20 sellers and 120 channel accounts. The raw
per-transaction data, with hashes, is in [`bench/results/`](../bench/results/).

Each settlement is a real `settle_upto` with its own client signature. The bench does what a
facilitator would: it builds the transaction, simulates it with auth enforced, assembles, signs,
submits, and polls until the transaction is final. Each channel keeps one transaction in flight.

## 1. Transaction shapes

From [`shapes.json`](../bench/results/shapes.json). Each shape was settled once more after the
contract and token were warm.

| Shape | Tx source | How the facilitator authorizes | Size | Fee charged (stroops) | Instructions | Example tx |
|---|---|---|---|---|---|---|
| `source` | facilitator | source-account credentials | 2,352 B | 40,709 | 1.60 M | `62217ecd…66f` |
| `opsource` | channel | it is the **operation** source (2 signatures) | 2,460 B | 41,180 | 1.60 M | `ad6f966a…81f` |
| `opsource-bump` | channel, fee bump by facilitator | operation source | 2,588 B | 41,279 | 1.60 M | `9d7e1947…52a` |
| `addr` | channel | signed address-credential entry (spike S8) | 2,680 B | 49,368 | 2.15 M | `8edb9c07…a6d` |
| `addr-bump` | channel, fee bump | signed address-credential entry | 2,808 B | 49,468 | 2.15 M | `f5d73739…7e0` |
| **`delegated-bump`** | channel, fee bump | operation source; the facilitator key is a signer on the channel, so **one signature** covers both | **2,516 B** | **40,965** | 1.60 M | `4cd15714…a38` |

- Address auth (S8) costs about 8,400 stroops, 550 k instructions and one extra written entry
  (the facilitator's auth nonce) more than making the facilitator the **operation source**. The
  operation-source pattern is better.
- A fee bump adds 128 B (5% of the ledger capacity) and about 100 stroops. In exchange the
  channels never hold fee money: after hundreds of fee-bumped settlements, every channel still had
  exactly its starting 20 XLM.
- `delegated-bump` saves the channel's own signature (72 B). The channel key never signs, so the
  facilitator manages one key, not N.
- **One-time costs:** the very first settlement of the day (`09e1d73c…39b`) cost 151,550
  stroops. Of that, 116,316 was rent for extending one persistent entry's TTL from ledger
  5,101,936 to 5,153,840, most likely the SAC instance, which extends itself when its TTL runs low.
  A client's first settlement also creates its allowance entry. Neither cost repeats per payment.

## 2. Single source account

From [`burst-20.json`](../bench/results/burst-20.json). The test built 20 settlements from the
facilitator account with consecutive sequence numbers and sent them without waiting:

| Send result | Count |
|---|---|
| `PENDING` (then `SUCCESS`) | 1 |
| `TRY_AGAIN_LATER` | 1 |
| `ERROR tx_bad_seq` | 18 |

**Stellar-core accepts only one pending transaction per source account.** A single account
settles at most one payment per ledger, about **0.2 per second**. Waiting between payments
confirms it: [`run … c1`](../bench/results/run-opsource-bump-c1-n8-many.json) settled 8 payments
in 8 consecutive ledgers.

## 3. Channel-account pools

Shape `opsource-bump`, unless the row says otherwise. "Sellers: many" spreads payments over 20
sellers, and "one" sends all of them to a single seller.

| Channels | Sellers | Settled | Peak per ledger | Mean per ledger | Ledgers | Simulation p50 / p95 | Send to final p50 / p95 |
|---|---|---|---|---|---|---|---|
| 1 | many | 8 / 8 | 1 | 1.0 | 5032957–64 | 322 / 413 ms | 4.2 / 4.6 s |
| 5 | many | 25 / 25 | 5 | 5.0 | 5032965–69 | 286 / 577 ms | 3.7 / 6.3 s |
| 20 | many | 80 / 80 | 20 | 16.0 | 5032972–76 | 512 / 793 ms | 3.9 / 6.5 s |
| 50 | many | 200 / 200 | 50 | 33.3 | 5032977–82 | 742 / 1,289 ms | 4.6 / 6.8 s |
| 50 (`delegated-bump`) | many | 200 / 200 | 50 | 40.0 | 5033186–90 | 657 / 914 ms | 4.6 / 7.7 s |
| 50 | **one** | 200 / 200 | 50 | 40.0 | 5033039–43 | 596 / 926 ms | 3.9 / 5.1 s |
| 120 | many | 478 / 480 ¹ | **103** | 59.6 | 5033016–23 | 1,086 / 2,205 ms | 6.2 / 11.7 s |
| 120 | **one** | 480 / 480 | **102** | 68.6 | 5033049–55 | 853 / 1,715 ms | 5.6 / 10.2 s |

¹ Both misses were on the bench side, not on chain. One `getTransaction` poll failed with a fetch
error, although its transaction (`b4fe5010…f39`) succeeded in ledger 5,033,017. The bench then
reloaded the channel's sequence too early, and its next transaction failed with
`tx_fee_bump_inner_failed` (`tx_bad_seq`). **Lesson for the facilitator:** never reload a
channel's sequence number while one of its transactions might still be pending.

**Throughput grows linearly with channels, one settlement per channel per ledger, until the
network limit.** At 120 channels a ledger took 98–103 of ours, together with other testnet traffic
(up to 115 Soroban transactions in total). The rest waited for the next ledger, which gives the
alternating 103 / 21 / 102 pattern. Measured over the whole run, the closed loop reached 10–13
settlements per second (wall clock, including ramp-up). The steady-state ceiling is about 102 per
ledger, about 20 per second.

No transaction failed for capacity reasons. Surplus transactions were not rejected: they queued
and went into the next ledger. At inclusion fee 100 the fee did not rise, because our transactions
competed only with each other.

## 4. Same-seller concurrency (question 3)

Every settlement to one seller writes the same seller trustline, so in theory they conflict. In
practice:

- **Nothing failed or serialized in a way we could measure.** 50 channels to one seller gave the
  same 50 per ledger as many sellers. At 120 channels one seller reached 102 per ledger, the same
  as many sellers (103).
- **Placement:** the bench read each ledger's transaction set (`placement` in the run JSON files).
  Every ledger in every run was **one stage with one cluster**, whether it held many sellers or
  one. Conflicting transactions in one cluster run sequentially, but the cluster limit is 580 M
  instructions (about 360 settlements). The size limit (about 105) is reached long before that.
- The same holds for one client paying concurrently (its trustline and allowance entry): the
  conflict stays inside one cluster and is harmless at this volume. The bench kept one client per
  channel, so this case was not measured separately.

## 5. Facilitator-side latency

- **Simulation** takes 0.3 s at low load. At 120 concurrent channels it rises to about 1 s p50 and
  2 s p95 on the public testnet RPC (see [R-verify-cost](R-verify-cost.md)).
- **Send to final** takes about 4–5 s p50: inclusion in the next ledger (5 s target), then polling
  every 500 ms. At saturation, the queued transactions add one ledger (about 10 s p95).
- **Cycle per channel:** at saturation each channel landed about once every 2 ledgers. Plan on
  **about 1.5–2 channels per settlement per ledger** you want to sustain.
