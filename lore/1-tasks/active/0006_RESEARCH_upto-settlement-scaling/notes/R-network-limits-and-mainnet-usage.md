---
title: "Soroban network limits on testnet and mainnet, and how full mainnet is"
type: research
status: mature
tags: [upto, throughput, limits, mainnet]
links:
  - ../bench/results/mainnet-usage.json
  - ../bench/results/shapes.json
  - R-testnet-throughput-measurements.md
history:
  - date: "2026-10-05"
    status: mature
    who: claude
    note: "Read both networks' config settings and sampled one hour of mainnet ledgers (question 5)"
---

# Soroban network limits on testnet and mainnet, and how full mainnet is

Answers question 5. Both networks run **protocol 29**, so mainnet is no longer on 28.

## The limits are the same on both networks

These values come from `stellar network settings`, read on 2026-10-05. Mainnet was read through
`https://mainnet.sorobanrpc.com`. The only difference between the networks is
`soroban_state_target_size_bytes` (4 GB on testnet, 3 GB on mainnet), which affects rent and not
throughput.

| Setting | Per ledger | Per transaction |
|---|---|---|
| Instructions | 580,000,000 (per cluster) | 400,000,000 |
| Dependent tx clusters (parallel lanes) | 2 | — |
| Transaction size | 266,240 B | 132,096 B |
| Disk read entries / bytes | 1,000 / 400,000 B | 200 / 200,000 B |
| Write entries / bytes | 1,000 / 286,720 B | 200 / 132,096 B |
| Soroban transactions | 2,000 | — |
| Footprint entries | — | 400 |
| Ledger close time target | 5,000 ms | — |
| Temporary entry TTL | min 17,280 ledgers (about 1 day) | max entry TTL 3,110,400 (about 180 days) |

## What binds for one settlement

The cheapest facilitator shape is `delegated-bump` (see
[R-testnet-throughput-measurements](R-testnet-throughput-measurements.md)). One settlement uses
2,516 B, 1.6 M instructions, 792 write bytes, 5 read-write entries and 4 read-only entries. Three of
those entries are classic: the client account and two trustlines.

| Resource | Settlements per ledger |
|---|---|
| **Transaction size** (266,240 / 2,516) | **105** |
| Write entries (1,000 / 5) | 200 |
| Disk read entries (1,000 / 3 classic entries) | about 333 |
| Instructions (580 M / 1.6 M per cluster, 2 clusters) | 362 per cluster, 725 total |
| Write bytes (286,720 / 792) | 362 |
| Disk read bytes (400,000 / 392) | 1,020 |

**Transaction size is the binding limit:** about 105 settlements per ledger, or about 21 per
second, network-wide and for everyone combined. The testnet runs reached 103 of ours in one ledger,
which matches this.

## Mainnet is already more than half full

[`mainnet-usage.ts`](../bench/mainnet-usage.ts) read 720 ledgers (64,779,941–64,780,660, about
one hour on 2026-10-05) and added up the Soroban phase of each:

| Measure | Value |
|---|---|
| Soroban transactions per ledger | average 105, max 214 |
| Soroban envelope bytes per ledger | average 157,025 (59% of 266,240), median 178,676 |
| Ledgers above 90% of the size limit | 186 of 720 (26%) |
| Ledgers with more than one cluster or stage | 8 of 720 |
| Soroban inclusion fee (last 50 ledgers) | min 100, p10–p99 200 |

The byte count is the XDR size of each envelope. The largest ledger summed to 290,168 B, which is
above the limit, so the network counts slightly differently, for example without some signature
bytes. Treat the percentages as approximate.

**What this means:** on an average ledger about 109,000 B are free, or about **43 settlements**
(about 8 per second). In a quarter of ledgers fewer than about 10 fit. A facilitator competes for
this space with everyone else, through the inclusion fee. Paying 200 stroops instead of 100 costs
nothing noticeable next to the roughly 41,000-stroop resource fee.

## Parallel execution does not help at this load

Protocol 23+ can run transactions in up to 2 parallel clusters per stage, but in practice:

- Every testnet ledger we inspected, including ledgers with 115 Soroban transactions, had **one
  stage with one cluster** (see placement in the run results).
- Only 8 of 720 mainnet ledgers used more than one.

The builder only splits when one cluster would go over 580 M instructions. With size capping a
ledger at about 105 settlements (about 170 M instructions), that never happens for our traffic.
