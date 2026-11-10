---
id: "0002"
title: "UptoProxy design on Soroban: validate §6.2 and write the contract spec"
type: RESEARCH
status: completed
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
  - date: "2026-09-30"
    status: active
    who: okarcz
    note: "Started. stellar-cli upgraded to 28.1.0 beforehand."
  - date: "2026-10-01"
    status: completed
    who: okarcz
    note: >
      Spec approved: PR #1 merged into develop (e0fb014, f698424). 15 notes (1 I-, 5 R-, 8 S-,
      1 G-), 4 upstream sources, and a testnet spike (S1-S8 with tx hashes). 5 decisions from
      okarcz, 5 emerged. 8 deviations from arch doc §6.2 (D1-D8) handed to 0005. Unblocks 0003.
---

# UptoProxy design on Soroban: validate §6.2 and write the contract spec

## Summary

Check the `upto` design in architecture doc §6.2 against the upstream x402 specs and Soroban's
authorization model, prove the risky auth mechanics with a small testnet spike, and write the
contract spec (a G- note) that 0003 implements. We write no production code until the spec is
approved.

## Status: Completed

> The spec, [notes/G-upto-proxy-contract-spec.md](notes/G-upto-proxy-contract-spec.md), was
> approved by okarcz when PR #1 merged into `develop` on 2026-10-01. 0003 implements it.

**Notes:** the [I- review findings](notes/I-section-6-2-review-findings.md) led to the R- notes
(the [x402 upto specs](notes/R-x402-upto-specs.md), the
[Soroban auth model](notes/R-soroban-auth-model.md),
[SEP-41/SAC allowance](notes/R-sep41-sac-allowance.md), the
[exact-Stellar rules](notes/R-exact-stellar-facilitator-rules.md) and the
[testnet spike](notes/R-testnet-spike.md)), then the S- decisions, then the G- spec.
The spike code is in [spike/](spike/README.md) and the upstream spec copies are in `sources/`.

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

### Step 2: Testnet spike (throwaway code, kept in `spike/` as evidence)

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

Decided afterwards in S- notes, from the research and the spike:
[nonce storage](notes/S-nonce-storage.md) (temporary, lives until the allowance expiry) and
[zero and edge inputs](notes/S-zero-amount-and-edge-inputs.md) (0 settles with no transfer, and
`from == to` is rejected). Also [token scope](notes/S-token-scope.md) (any SEP-41 token, no
allowlist) and the new `allowance_expiration_ledger` parameter
([S-time-bounds-and-expiry](notes/S-time-bounds-and-expiry.md)). Decided by okarcz afterwards:
[no cancellation function in v1](notes/S-cancellation.md).

## Acceptance Criteria

- [x] R- notes written, each with sources (5 notes, and 4 upstream docs in `sources/`)
- [x] Spike proves points 1–4 on testnet, with transaction hashes recorded (S1–S8 in R-testnet-spike)
- [x] Every decision (confirmed and still open) has an S- note (8 decided)
- [x] `G-upto-proxy-contract-spec` is complete and approved by okarcz (PR #1, merged 2026-10-01)
- [x] Every deviation from arch doc §6.2 is listed, with its reason, for 0005 (G- spec §11, D1–D8)

## Implementation Notes

- **Notes:** 1 I- (review of §6.2, findings F1–F9), 5 R-, 8 S- and 1 G- note in `notes/`.
- **Sources:** `scheme_upto.md`, `scheme_upto_evm.md`, `scheme_exact_stellar.md` and SEP-41
  copied into `sources/`.
- **Spike:** a minimal Soroban contract plus a TS client in `spike/` (throwaway, kept as evidence).
  Scenarios S1–S8 ran on testnet, with transaction hashes in
  [R-testnet-spike](notes/R-testnet-spike.md). All four points in Step 2 were proven, with both
  V1 (`ADDRESS`) and V2 (`ADDRESS_V2`) credentials.
- **PR #1 review:** fixed 3 findings (c095d4f, now f698424): invariant I4 narrowed to the nonce
  entry's lifetime plus a facilitator nonce record (spec §8.1), `to == proxy` rejected
  (`InvalidRecipient = 8`), and the spike recipient test isolated with a control run.

## Issues Encountered

- **Client draft source:** if the client is the draft transaction's source, it receives
  source-account credentials. The draft must use the facilitator address as its source.
- **Simulation needs balance ≥ max:** simulating with `actual = max` failed with
  `Error(Contract, #10)` while the client held less than max. This matches the EVM verify rule.
- **V1/V2 credentials vary between runs:** the testnet RPC returns either kind. Only
  `@stellar/stellar-sdk` 17.x parses CAP-71 V2; 15.x throws. Testnet is on protocol 29 (mainnet 28).
- **stellar-cli:** upgraded to 28.1.0 via cargo. A stale 25.0.0 copy remains at
  `/usr/local/bin/stellar`, shadowed on PATH.

## Design Decisions

### From Plan

1. **Allowance in the auth tree:** `approve` is a sub-invocation in the client's single
   `settle_upto` auth entry ([S-allowance-in-auth-tree](notes/S-allowance-in-auth-tree.md)).
2. **Facilitator binding:** `facilitator.require_auth()`
   ([S-facilitator-binding](notes/S-facilitator-binding.md)).
3. **Time bounds:** `valid_after`/`deadline` in unix seconds against the ledger timestamp
   ([S-time-bounds-and-expiry](notes/S-time-bounds-and-expiry.md)).
4. **Immutable:** no admin and no upgrade entry point ([S-immutable](notes/S-immutable.md)).
5. **Token in signed args:** `token: Address` is a parameter and is signed (F1).

### Emerged

6. **`allowance_expiration_ledger` parameter:** `approve` needs a ledger number, not a timestamp,
   so the client signs it explicitly ([S-time-bounds-and-expiry](notes/S-time-bounds-and-expiry.md)).
7. **Temporary nonce storage until allowance expiry**
   ([S-nonce-storage](notes/S-nonce-storage.md)).
8. **Zero and edge inputs:** 0 settles with no transfer; `from == to` and `to == proxy` are rejected
   ([S-zero-amount-and-edge-inputs](notes/S-zero-amount-and-edge-inputs.md)).
9. **Any SEP-41 token, no allowlist** ([S-token-scope](notes/S-token-scope.md)).
10. **No cancellation function in v1:** decided by okarcz ([S-cancellation](notes/S-cancellation.md)).

## Future Work

Already covered by backlog tasks, so none were spawned:
- 0003: implement the contract from the G- spec.
- 0004: testnet E2E, deploy scripts, and re-measuring fees.
- 0005: deviations D1–D8 from §6.2 and the rule list for `scheme_upto_stellar.md`.
