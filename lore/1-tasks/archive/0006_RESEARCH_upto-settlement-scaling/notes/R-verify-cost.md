---
title: "/verify cost: simulation latency and RPC load per payment"
type: research
status: mature
tags: [upto, facilitator, verify, rpc]
links:
  - ../bench/results/
  - R-testnet-throughput-measurements.md
history:
  - date: "2026-10-05"
    status: mature
    who: claude
    note: "Measured simulation latency and throughput on the public testnet RPC (question 6)"
---

# /verify cost: simulation latency and RPC load per payment

Answers question 6. The bench `verify` command does what the `upto` `/verify` does in the EVM
reference: it simulates the full settlement, with auth enforced, against the client's real
signature, and never submits it. Each request is a fresh payment from a different client. It ran on
2026-10-05 against `https://soroban-testnet.stellar.org`.

| Concurrency | Requests | OK | Simulation p50 / p95 / max | Simulations per second |
|---|---|---|---|---|
| 1 | 50 | 50 | 281 / 457 / 651 ms | 2.8 |
| 10 | 200 | 200 | 282 / 683 / 861 ms | 23.4 |
| 50 | 500 | 500 | 584 / 2,654 / 4,333 ms | 42.0 |
| 100 | 1,000 | 1,000 | 586 / 844 / 1,723 ms | 108.0 |
| 300 | 3,000 | 3,000 | 1,288 / 2,089 / 3,380 ms | 149.8 |

- One simulation takes about **0.3 s**, almost all of it network round trip plus RPC queueing.
  The contract work is only 1.6 M instructions.
- The public testnet RPC **levels off at about 150 simulations per second**, where latency is
  4–5× the idle value. One attempt at concurrency 100 failed early with a connection error, and a
  rerun passed. Throughput from the public endpoint varies and has no SLA.
- These numbers include building and signing the client's entry locally, which is negligible.

## RPC calls per payment

| Step | RPC calls |
|---|---|
| `/verify` | 1 `simulateTransaction` |
| `/settle` | 1 `simulateTransaction`, 1 `sendTransaction`, and about 8–10 `getTransaction` polls at 500 ms |

So a payment costs **about 12 RPC calls**, and the polling is most of them. A load-ready
facilitator should poll more slowly, or watch ledgers and match hashes. The `/verify` simulation
cannot be reused at `/settle`: the amount changes from the maximum to the actual amount, and so do
the resources.

## When a facilitator needs its own RPC

- **Mainnet always needs an RPC provider or its own node.** SDF runs a public RPC for testnet only.
  For this research we read mainnet through `mainnet.sorobanrpc.com`.
- At the network ceiling (about 20 settlements per second, see
  [R-network-limits-and-mainnet-usage](R-network-limits-and-mainnet-usage.md)) a facilitator
  makes about 40 simulations and about 200 polls per second. That is beyond what a shared public
  endpoint gives reliably (above). **Plan for an own node or a paid provider from the start of
  production**, and keep the RPC URL configurable, with more than one endpoint.
- `/verify` alone can grow beyond settlements, because it runs for every request, settled or not.
  Cheaper checks are possible: verify the ed25519 signature locally, then read balance and nonce
  with `getLedgerEntries`. This research did not measure them; it is a facilitator design option.
