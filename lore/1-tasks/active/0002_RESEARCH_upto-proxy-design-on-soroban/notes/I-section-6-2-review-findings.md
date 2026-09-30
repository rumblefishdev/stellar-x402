---
title: "Review findings on architecture doc §6.2 (UptoProxy)"
type: idea
status: mature
tags: [upto, contracts, review]
links:
  - ../../../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md
history:
  - date: "2026-09-30"
    status: seed
    who: claude
    note: "First-pass review of §6.2 against upstream upto/exact specs"
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "All findings resolved by research and spike; see S- notes and G- spec"
    spawns:
      - notes/R-x402-upto-specs.md
      - notes/R-soroban-auth-model.md
      - notes/R-sep41-sac-allowance.md
      - notes/R-exact-stellar-facilitator-rules.md
      - notes/R-testnet-spike.md
      - notes/S-immutable.md
---

# Review findings on architecture doc §6.2 (UptoProxy)

Each finding below is a hypothesis for 0002 to confirm, reject or refine. The references are to
arch doc §6.2 and the upstream specs as of 2026-09-30.

## F1. The token is not bound (must fix)

`settle_upto(from, to, facilitator, max_amount, actual_amount, nonce, valid_after, deadline)` has
no `token` parameter. The contract has to know which SEP-41 token to move, so a `token` parameter
is needed, and it must be in the signed args. On EVM the token is bound through
`permit.permitted.token`. Without that binding, a facilitator could settle in any token the payer
has approved to the proxy.

## F2. The facilitator is signed but not enforced

`facilitator` is in the signed args, but §6.2 never checks it. On EVM,
`x402UptoPermit2Proxy` checks `msg.sender == witness.facilitator`. The Soroban equivalent is
`facilitator.require_auth()`. Without that call, anyone who has the client's auth entry could
front-run settlement with a different `actual_amount`, for example 1 stroop, which cheats the
seller. `require_auth` is satisfied by source-account credentials or by an address auth entry, so
it still works with channel accounts (§3.3). This conflicts with the `exact` rule "facilitator
address MUST NOT appear in any authorization entries", so `scheme_upto_stellar.md` has to scope
that rule to client-signed entries only.

## F3. A standing allowance ("separately, the client grants…") causes problems

- SEP-41 `approve` overwrites the allowance, and there is one slot per (from, spender). Two
  concurrent `upto` payments from the same payer through the one canonical proxy would clobber
  each other.
- A separate `approve` transaction is a second on-chain step. Either the client pays its fee,
  which breaks §3.2 ("buyers never need XLM"), or the facilitator sponsors a second transaction.
- A long-lived allowance comes close to "open-ended allowances", which `scheme_upto.md` puts out
  of scope.

**Proposed alternative:** put `token.approve(from, proxy, max_amount, expiration_ledger)` into the
client's single auth entry, as a sub-invocation of `settle_upto`. All of its arguments are known
at signing time. `settle_upto` then calls `from.require_auth_for_args(...)`, then
`token.approve(...)`, then `token.transfer_from(proxy, from, to, actual_amount)`. The
`transfer_from` call is authorized automatically because the proxy is the spender. The result is
one signature and one atomic transaction, with no race between payments. The leftover allowance
(`max - actual`) expires at `expiration_ledger`, and only the proxy can spend it, which it only
does under a fresh client signature. The spike must prove this.

**Other option:** escrow. The client authorizes `transfer(from, proxy, max)`, and the proxy pays
`actual` and refunds the rest. This needs no allowance entry, but it moves the full ceiling and
needs a balance of at least `max`.

## F4. Time units are not specified

`valid_after`/`deadline` could be unix seconds (x402 and EVM semantics, checked with
`env.ledger().timestamp()`) or ledger sequence numbers (like `signatureExpirationLedger`).
Proposal: unix seconds in the contract, with the auth entry's `signatureExpirationLedger` as an
extra native bound.

## F5. Replay protection has two layers

Soroban already makes each auth entry single-use, through the native nonce and expiration. The
x402 `nonce` adds replay protection at the payload level, which the facilitator can check
off-chain and read on-chain. Proposal: `nonce: BytesN<32>`, keyed by `(from, nonce)` in
**temporary** storage with a TTL that reaches past `deadline`. This avoids persistent rent. Both
layers stay in place.

## F6. Zero settlement

The spec says the amount MAY be 0, and a zero settlement needs no on-chain transaction. Proposal:
the contract accepts 0 (it consumes the nonce, makes no transfer and emits an event), and the
facilitator normally does not submit it.

## F7. Auth-tree order

In enforcing mode, a child `require_auth` is matched as a sub-invocation only after the parent
frame has authorized the same address. So `require_auth_for_args` must run before the `approve`
call. Test this explicitly.

## F8. Other contract hardening

- Reject `max_amount <= 0`, `actual_amount < 0`, `actual_amount > max_amount` and
  `valid_after >= deadline`.
- Consider rejecting `from == to`.
- Use typed `#[contracterror]` codes, which map to x402 error reasons in the facilitator.
- Emit a settlement event with `(token, from, to, facilitator, max, actual, nonce)`.
- Soroban does not allow re-entrancy, so a malicious token cannot re-enter the proxy. Still, no
  state may be written after the external calls unless that ordering is intended: consume the
  nonce before calling the token.
- Measure the resource cost per settlement and compare it with the `exact` fee ceiling of 50,000
  stroops.

## F9. Upgradeability

For a "canonical" proxy, trust minimization points to an immutable contract with no admin.
Decide this before deploying.
