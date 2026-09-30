---
id: "0002"
title: "UptoProxy design on Soroban: validate §6.2 and write the contract spec"
type: RESEARCH
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0003", "0004", "0005"]
tags: [layer-contracts, layer-research, upto, priority-high, effort-medium]
links:
  - ../../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md
  - https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization
  - https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
history:
  - date: "2026-09-30"
    status: backlog
    who: claude
    note: "Task created with okarcz. First of the four M1 UptoProxy tasks."
---

# UptoProxy design on Soroban: validate §6.2 and write the contract spec

## Summary

Check the `upto` design in architecture doc §6.2 against the upstream x402 specs and Soroban's
authorization model, prove the risky auth mechanics with a small testnet spike, and write the
contract spec (a G- note) that 0003 implements. We write no production code until the spec is
approved.

## Status: Backlog

> Blocks 0003. Seed findings from the first review are in
> [notes/I-section-6-2-review-findings.md](notes/I-section-6-2-review-findings.md).

## Context

§6.2 says a client signs `require_auth_for_args` over a ceiling. Because `actual_amount` is not in
the signed payload, the facilitator can settle any amount up to that ceiling. The first review
found gaps: the token is not bound, facilitator binding has no on-chain check, a standing
allowance breaks concurrency and fee sponsorship, and the time units are not specified. If we
build on those gaps, the contract, the facilitator's verify/settle logic and the upstream
`scheme_upto_stellar.md` all inherit them.

## Implementation Plan

### Step 1: Research notes (R-)

- `R-x402-upto-specs`: the core properties in `scheme_upto.md`, how `x402UptoPermit2Proxy` binds
  the token, recipient and facilitator, zero settlement, and settle-time re-verification.
- `R-soroban-auth-model`: `require_auth_for_args`, how the auth tree matches sub-invocations
  (including the order the parent must authorize in), the native auth-entry nonce and
  `signatureExpirationLedger`, current-contract auto-auth, and CAP-71 V2 credentials (Protocol 28).
- `R-sep41-sac-allowance`: `approve` overwrite semantics, `expiration_ledger` rules, temporary
  allowance storage, `transfer_from`, and how the SAC differs from custom SEP-41 tokens.
- `R-exact-stellar-facilitator-rules`: which `exact` verification rules carry over to `upto` and
  which conflict with it (for example, "facilitator MUST NOT appear in any auth entry").

### Step 2: Testnet spike (throwaway code, not kept)

Prove on testnet, with a minimal contract:
1. One signed auth entry settles correctly with different `actual_amount` values, so the signature
   does not depend on the amount.
2. `approve` works as a sub-invocation within the one client auth entry (decision 1).
3. The proxy's `transfer_from` needs no second client signature.
4. A separate facilitator account can be the transaction source and pay the fee.

Record the transaction hashes in `R-testnet-spike`.

### Step 3: Decisions (S-) and spec (G-)

Write one S- note per open decision, then `G-upto-proxy-contract-spec`, which covers:
- the function signature and the exact signed-args vector (order and types)
- the auth tree the client signs, and the storage keys, TTL policy, errors, events and invariants
- the facilitator-side checks the contract relies on, which become input for `scheme_upto_stellar.md`

## Decisions confirmed by okarcz (2026-09-30)

1. **Allowance:** `token.approve(from, proxy, max_amount, expiration_ledger)` is a sub-invocation
   inside the client's single `settle_upto` auth entry. There is no separate approve transaction.
   The spike must prove it (I- note F3).
2. **Facilitator binding:** the contract calls `facilitator.require_auth()` (F2).
3. **Time bounds:** `valid_after`/`deadline` are unix seconds, checked against
   `env.ledger().timestamp()` (F4).
4. **Upgradeability:** immutable, with no admin and no upgrade entry point (F9).
5. **Token:** `settle_upto` takes `token: Address`, and the token is in the signed args (F1).
   Working signature: `settle_upto(token, from, to, facilitator, max_amount, actual_amount, nonce,
   valid_after, deadline)`, with signed args `[token, to, facilitator, max_amount, nonce,
   valid_after, deadline]`. The G- spec fixes the final order.

Still open for the S- notes, decided with testnet evidence: nonce storage and TTL (F5),
zero-amount handling (F6), `from == to`, and client-side cancellation of an unsettled
authorization. Any of these that changes the interface goes back to okarcz.

## Acceptance Criteria

- [ ] R- notes written, each with sources
- [ ] Spike proves points 1–4 on testnet, with transaction hashes recorded
- [ ] Every decision (confirmed and still open) has an S- note
- [ ] `G-upto-proxy-contract-spec` is complete and approved by okarcz
- [ ] Every deviation from arch doc §6.2 is listed, with its reason, for 0005
