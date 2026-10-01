---
title: "Decision: approve is a sub-invocation of the client's settle_upto entry"
type: synthesis
status: mature
tags: [upto, decision, allowance]
links: []
history:
  - date: "2026-09-30"
    status: mature
    who: okarcz
    note: "Chosen by okarcz before research; confirmed by spike S1, S6, S7"
    spawned_from: ["notes/R-soroban-auth-model.md"]
---

# Decision: approve is a sub-invocation of the client's settle_upto entry

## Conclusion

The client signs one auth entry. Its root is `UptoProxy.settle_upto(<signed args>)`, with exactly
one sub-invocation, `token.approve(from, proxy, max_amount, allowance_expiration_ledger)`.
`settle_upto` calls `from.require_auth_for_args(..)` **first**, then `approve`, then
`transfer_from(proxy, from, to, actual_amount)`, which the proxy is authorized for automatically
as the direct caller.

## Reasoning

1. **One signature and one atomic transaction.** The client never submits anything and never
   holds XLM for fees. Spike: the client's XLM delta was 0.
2. **Concurrent authorizations don't interfere.** `approve` and `transfer_from` run in the same
   invocation, so they cannot interleave with another authorization, even though `approve`
   overwrites. Spike S7 settled two open authorizations out of order.
3. **No open-ended allowance.** The allowance lives only until `allowance_expiration_ledger`, and
   only the proxy can spend it, under a fresh signature. This keeps us clear of the upto spec's
   "open-ended allowances" exclusion.
4. **The payer needs only `actual` at settlement.** `transfer_from` pulls `actual`, not `max`.
   The verify step still requires a balance of at least `max` (the worst-case simulation).

## Alternatives considered

- **Separate `approve` transaction (as §6.2 is written):** needs a second transaction, which
  either the client pays for (breaking §3.2) or the facilitator sponsors. Concurrent payments
  overwrite each other's allowance. Rejected.
- **Escrow (pull `max`, refund the rest):** needs a balance of at least `max` at settlement, and
  makes three transfers and events instead of one. Rejected.

## Consequences

- `settle_upto` gains an `allowance_expiration_ledger: u32` parameter. The value is signed through
  the approve sub-invocation (see S-time-bounds-and-expiry).
- A leftover allowance of `max - actual` remains until it expires. It is harmless, and the next
  settlement overwrites it.
- A policy-based smart wallet must allow two contexts: `settle_upto` and `approve`.
