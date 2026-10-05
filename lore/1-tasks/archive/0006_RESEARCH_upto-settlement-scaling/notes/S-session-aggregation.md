---
title: "Session aggregation: keep upto per request, put sessions in a batch-settlement binding"
type: synthesis
status: developing
spawned_from: notes/R-x402-batch-settlement.md
spawns: []
tags: [upto, session, batch-settlement, x402, design]
links:
  - R-x402-batch-settlement.md
  - R-network-limits-and-mainnet-usage.md
  - ../../../archive/0003_FEATURE_upto-proxy-contract/notes/S-batching-and-throughput.md
history:
  - date: "2026-10-05"
    status: developing
    who: claude
    note: "Answer to question 1; awaiting okarcz review"
---

# Session aggregation: keep upto per request, put sessions in a batch-settlement binding

Answers question 1.

## Conclusion

**Do not build session aggregation into `upto`.** Our `upto` stays one authorization per request
and one settlement per authorization, as the upstream spec requires. If high request rates matter,
build a **Stellar binding of x402 `batch-settlement`** as its own scheme and its own escrow
contract. It is a separate task, and **UptoProxy and the `upto` spec do not change.**

## Why this matters

One settlement per request caps a facilitator, network-wide, at about 105 settlements per ledger
on an empty network. On today's mainnet the free room is about 43 per ledger (about 8 per second;
see [R-network-limits-and-mainnet-usage](R-network-limits-and-mainnet-usage.md)). Channels and
fee bumps cannot raise that ceiling. Only taking requests off the chain can.

## Options

### A. Per-request `upto` (today)

- **Client signs:** one ceiling for each request.
- **Settlement:** one transaction for each request.
- **Limit:** the network share above, about 8–20 per second.
- **Changes needed:** none.

### B. One `upto` authorization reused for a session (deferred settle)

The client signs `max_amount` = the session budget, `deadline` = the session end, and an
`allowance_expiration_ledger` and auth-entry expiry that cover that time. The server accepts the
same payload on every request, meters usage, and settles once with the total.

- **The contract can already do this.** `deadline` is unbounded, and the allowance expiration can
  reach about 180 days (`max_entry_ttl`).
- **The seller is unsecured until settlement.** `approve` runs only inside `settle_upto`, so
  nothing locks the client's funds. The client can empty its balance, and the single settlement
  then fails. Every request in the session was served on credit.
- **It breaks the x402 flow.** `upto` responses carry a transaction hash for each request, and
  the spec excludes multi-request use. This would need a non-standard `extra` flag that clients
  have to opt into.
- **There is no partial settlement.** One nonce settles once, so a long session can only be cut by
  signing a new authorization ("rolling" authorizations). That is a homemade version of option C.
- **Changes needed:** server middleware plus a non-standard extension.
- **Not recommended.**

### C. Stellar `batch-settlement` binding (capital-backed channel)

The client deposits into an escrow contract once, then signs cumulative ed25519 vouchers per
request, off-chain. The seller (or facilitator) claims many channels in one transaction.

- **Per request:** zero transactions; one signature check, done locally.
- **Per session:** one deposit, plus a share of a batched claim/settle.
- **Seller safety:** funds are escrowed.
- **Changes needed:** a new contract, a new scheme spec for `stellar` (`batch-settlement`), and
  facilitator and SDK support.

## What C would need

These are design inputs, not a spec.

- **Contract:**
  - `deposit` (SEP-41 transfer under the payer's address auth);
  - `claim` (batched; verifies vouchers with `ed25519_verify` against a `payer_authorizer` key
    fixed in the channel config);
  - `settle`;
  - cooperative `refund`;
  - `initiate_withdraw` / `finalize_withdraw` with a delay.
- **Channel identity:** sha256 of the config XDR, with network and contract bound in.
- **Storage:** persistent entries with a TTL plan.
- **`PaymentRequirements.extra`:** the escrow contract, `receiverAuthorizer`, `withdrawDelay`, and
  an optional `minDeposit`, following the EVM binding.
- **Payload types:** `deposit`, `voucher`, `refund`.
- **Facilitator:** `/verify` checks the voucher signature and the on-chain channel balance (one
  `getLedgerEntries`, no simulation). `/settle` stores the voucher, or runs the batched
  `claim`/`settle` as a single transaction. These are exactly the transactions the channel pool
  from [S-facilitator-scaling](S-facilitator-scaling.md) carries.
- **Scope check:** the SCF RFP asks for an x402 facilitator with `exact` and Bazaar. `upto` is our
  addition, and `batch-settlement` would be another. **Whether it is in scope is okarcz's
  decision.**

## Answers to the sub-questions

- **How does a client sign one ceiling for many requests?** Under `upto` it should not; that is
  option B, rejected above. Under C the client signs a deposit once, then a running total per
  request, so there is no per-request ceiling to sign on-chain.
- **What does it need from `PaymentRequirements` and the facilitator?** For `upto`, nothing new.
  For C, see above.
- **Does it need a contract change?** Not to UptoProxy. C is a new contract.
