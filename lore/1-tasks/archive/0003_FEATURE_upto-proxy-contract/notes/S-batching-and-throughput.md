---
title: "Batching upto settlements and facilitator throughput"
type: synthesis
status: mature
tags: [upto, facilitator, throughput, batching]
links:
  - R-manual-testnet-verification.md
  - ../../../archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/G-upto-proxy-contract-spec.md
history:
  - date: "2026-10-02"
    status: mature
    who: okarcz
    note: "Discussed after the manual testnet run; recommendation: no batching, aggregate per session"
---

# Batching upto settlements and facilitator throughput

## The question

Can the facilitator put many `upto` payments into one on-chain transaction, so that it can serve
many clients at once (for example thousands in the same second)?

## What we have now

- The client signs a **Soroban authorization entry** (`SorobanAuthorizationEntry`) for one
  `settle_upto` call, with `approve` as a sub-invocation. It does not sign the transaction.
- The facilitator builds the transaction with the actual amount, is its source account (or uses a
  channel account), pays the fee and submits it.
- **One payment = one transaction.** The contract has no batch function.
- Measured on testnet (see [R-manual-testnet-verification](R-manual-testnet-verification.md)): a
  normal settlement costs 30,090–40,699 stroops, is 2,352 bytes, and writes 5 ledger entries.

## Constraints

- **A transaction that calls a contract may hold only that one operation.** Several
  `settle_upto` calls cannot go into one transaction as separate operations.
- **Network capacity is set per ledger** (every 5 s), summed over all transactions. With testnet's
  limits on 2026-10-02 that is about **110 settlements per ledger, roughly 22 per second for the
  whole network**. Transaction size is the binding limit (266,240 B per ledger). Mainnet limits are
  voted separately and may differ.
- **Batching does not lower resource use.** Each settlement still writes its own entries and
  carries its own signed entry. Shared overhead (header, source signature, read-only footprint)
  gives at most about 1.5–2×: still tens per second, not thousands.
- Stellar-core queues **one transaction per source account per ledger**, so a single facilitator
  account is a bottleneck long before the network is.

## What batching would require

- A **router contract** (separate and stateless), or a new `settle_upto_batch` in the proxy. The
  second changes the spec and the WASM hash.
- A **spike** confirming that the client's entry authorizes `settle_upto` when the router calls it,
  instead of it being the transaction's top-level call. Soroban allows such non-root authorization,
  but simulation only records it in non-root mode.
- **Error isolation:** by default one bad entry reverts the whole batch. A "try" call could skip
  it, but whether it catches auth failures is untested.

## What Stellar offers

| Option | What it gives | Use for us |
|---|---|---|
| Multi-operation transactions (up to 100 ops) | batches of classic operations | **No**: not allowed with contract calls, and fixed amounts break `upto` |
| Fee-bump transactions | one fee payer for transactions from many source accounts | **Yes**: the facilitator pays for its channel accounts |
| Channel accounts | N source accounts = N transactions in flight per ledger | **Yes, the key one**: proven by spike S8 |
| Many authorization entries in one invocation | the basis for a router | **Only with our own router contract** |
| Parallel contract execution (protocol 23+) | independent transactions run in parallel clusters | **Automatic**, but payments to the same seller likely conflict (not measured) |
| Off-chain payment channels | not part of the protocol | **No** |

## Recommendation

**Don't build batching.** It brings a small throughput gain, a negligible fee saving (the
~100-stroop inclusion fee per payment), a new contract, and the risk that one bad payment fails the
rest. Instead:

1. **Aggregate per `upto` session:** the client signs one ceiling for a session (for example up to
   5 USDC for an hour of API calls), the seller meters usage off-chain and settles once. A thousand
   requests become one transaction. This is the only way past the network limit.
2. **Scale `/verify` off-chain:** it is a signature check plus a simulation. Under heavy load, run
   our own RPC nodes.
3. **Channel-account pool plus fee bumps** in the facilitator, so the remaining settlements go out
   in parallel up to the network limit.
4. Keep a router-based batch only as an optional spike if a concrete need appears. The follow-up
   research is task 0006.

## Sources

- [Invoke and deploy smart contracts with InvokeHostFunctionOp](https://developers.stellar.org/docs/learn/fundamentals/contract-development/contract-interactions/stellar-transaction)
- [Proposed changes to transaction submission](https://stellar.org/blog/developers/proposed-changes-to-transaction-submission)
- [Fee-bump transactions](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions)
- [Fees, resource limits and metering](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering)
- Testnet limits: `stellar network settings --network testnet`, read 2026-10-02.
