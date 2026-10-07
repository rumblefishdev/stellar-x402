---
title: "Decision: how the facilitator scales upto settlement"
type: synthesis
status: developing
spawned_from: notes/R-testnet-throughput-measurements.md
spawns: []
tags: [upto, facilitator, throughput, channel-accounts, fee-bump, recommendation]
links:
  - R-testnet-throughput-measurements.md
  - R-network-limits-and-mainnet-usage.md
  - R-verify-cost.md
  - S-session-aggregation.md
  - ../../../archive/0003_FEATURE_upto-proxy-contract/notes/S-batching-and-throughput.md
history:
  - date: "2026-10-05"
    status: developing
    who: claude
    note: "Recommendation from the 0006 measurements; awaiting okarcz review"
  - date: "2026-10-07"
    status: developing
    who: claude
    note: "Cited the official sources for the one-transaction-per-account rule"
---

# Decision: how the facilitator scales upto settlement

## Conclusion

The facilitator submits through a **pool of channel accounts**:

- Each channel account is the transaction source and has the **facilitator key as a signer**.
- The facilitator is the **operation source** of `settle_upto`, so its binding uses
  source-account credentials.
- Each transaction is wrapped in a **fee bump that the facilitator pays**.

This is the `delegated-bump` shape, and it gives one signature per transaction from one key. Size
the pool at about 2 channels per settlement per ledger you need, up to about 200.

**Neither the contract nor the `upto` spec needs to change.** Batching through a router is not
worth building. Throughput beyond the network share comes only from taking requests off the chain
([S-session-aggregation](S-session-aggregation.md)).

This confirms 0003's
[S-batching-and-throughput](../../../archive/0003_FEATURE_upto-proxy-contract/notes/S-batching-and-throughput.md)
with measurements, and corrects one detail: **spike S8's address auth is the worse way to bind a
channel-submitted transaction.**

## Evidence

From [R-testnet-throughput-measurements](R-testnet-throughput-measurements.md):

| Setup | Measured |
|---|---|
| Single source account | 1 pending transaction allowed (`TRY_AGAIN_LATER`, then `tx_bad_seq`), so about 0.2 settlements per second. This is the documented rule: one transaction per account per ledger ([Stellar docs](https://developers.stellar.org/docs/learn/fundamentals/transactions/transaction-lifecycle), [SDF blog](https://stellar.org/blog/developers/proposed-changes-to-transaction-submission)) |
| N channels, N ≤ 50 | N per ledger, 0 failures |
| 120 channels | 102–103 per ledger, the network size limit; the surplus queues to the next ledger |
| Same seller vs many | the same throughput; every ledger was one cluster |
| `delegated-bump` vs S8 address auth | 2,516 B / 40,965 stroops vs 2,680 B / 49,368 stroops, plus 0.55 M instructions and a nonce write |

From [R-network-limits-and-mainnet-usage](R-network-limits-and-mainnet-usage.md):

- Mainnet and testnet limits are identical. The ceiling is about 105 settlements per ledger,
  network-wide.
- Mainnet already fills about 59% of it on average, so about 43 per ledger are free.

## Answers to question 2

- **How many channels?** Each channel lands at most one transaction per ledger, and the cycle
  (simulate, sign, send, confirm) takes 1–2 ledgers. So **channels ≈ 2 × the target settlements
  per ledger.** About 80 channels covers mainnet's typical free share (about 40 per ledger). More
  than about 200 cannot help, because the network caps everyone at about 105.
- **Funding.** With fee bumps, channels pay nothing. Each one holds only its reserve: 1 XLM base
  plus 0.5 for the extra signer. The bench's channels kept exactly their starting balance. The
  facilitator's account pays every fee, about 41,000 stroops (0.0041 XLM) per settlement.
  Monitor its balance.
- **Rotation.** Keys never need rotating: the channel key never signs, and its master weight can
  be set to 0 once the facilitator is a signer. The pool needs only sequence management:
  - one transaction in flight per channel;
  - track the sequence number locally;
  - reload it only after the in-flight transaction is final or its time bound has passed. The
    bench lost one transaction by reloading too early.
- **Fee bump or address auth?** Use **a fee bump plus the facilitator as operation source**.
  Address auth (S8) costs more in every resource, writes an extra nonce entry, and needs a
  signature per transaction anyway.

## Question 4 (batch router): not pursued

The task made this optional, for use only if questions 1–3 left a gap. The remaining gap is the
network's per-ledger byte budget. A router saves only the shared envelope overhead: the source
account, the signature, and some read-only footprint, which is at most a few hundred bytes of the
2.5 KB. Each settlement still carries its own client auth entry and writes its own entries. Over
the 1.5–2× bound from 0003, a router adds a new contract, non-root auth, and failure-isolation
risk, so it is not worth a spike. Off-chain aggregation (option C in S-session-aggregation)
addresses that same gap and removes transactions entirely.

## Other facilitator inputs

- **RPC.** Mainnet needs a provider or an own node. Measure the provider's limits; the public
  testnet RPC leveled off at about 150 simulations per second. Cut polling, which is about 10
  `getTransaction` calls per settlement ([R-verify-cost](R-verify-cost.md)).
- **Inclusion fee.** Mainnet pays 200 stroops (the p10–p99 value). Set the bid from
  `getFeeStats`. The cost is negligible next to the resource fee.
- **One-time rent.** Occasional TTL extensions, such as the SAC instance (+116,316 stroops once),
  fall on whichever settlement triggers them. Budget for them in the fee-bump maximum.
- **Back-pressure.** When ledgers are full, transactions wait instead of failing. The facilitator
  should time-bound each transaction (the bench used 120 s). It should also report "pending"
  rather than assume failure.

## Follow-up work

- Facilitator settlement submitter: the channel pool, fee bump, delegated signer, sequence
  tracking and RPC strategy (backlog task).
- Optional: a Stellar `batch-settlement` binding (research task). Its scope needs okarcz's
  decision first.
- 0005 docs: publish the throughput numbers and the "one settlement per request" limit of
  `upto`.
