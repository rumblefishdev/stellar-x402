---
title: "Decision: no client-side cancellation in v1"
type: synthesis
status: mature
tags: [upto, decision]
links: []
history:
  - date: "2026-09-30"
    status: developing
    who: claude
    note: "Recommendation drafted; changes the interface, so awaiting okarcz"
    spawned_from: ["notes/S-nonce-storage.md"]
  - date: "2026-09-30"
    status: mature
    who: okarcz
    note: "Decided: no cancel function in v1"
---

# Decision: no client-side cancellation in v1

## Question

Should UptoProxy expose `cancel(from, nonce)`, which calls `from.require_auth()` and marks the
nonce used, so a client can void an authorization it signed before the deadline?

## Recommendation: do not add it in v1

1. **Authorizations expire quickly.** The window is bounded by `maxTimeoutSeconds`, typically
   60–300 s. After that, the signature and the allowance both expire on their own.
2. **Cancelling costs the client a transaction.** That means either XLM (which the client should
   not need, §3.2) or a facilitator willing to sponsor a cancellation. The facilitator is the
   party being cancelled, so it has no reason to.
3. **The upstream specs don't have it.** Neither `scheme_upto.md` nor the EVM spec defines a
   cancellation flow. Permit2's `invalidateUnorderedNonces` exists, but x402 does not use it.
4. **Smaller attack surface.** It is one fewer entry point in an immutable contract.

## Against the recommendation

The contract is immutable (S-immutable), so adding cancellation later means a new deployment and
a new canonical address. If it ever matters, for example for long `maxTimeoutSeconds` settings,
it has to be added before the mainnet deployment.

> Decided by okarcz on 2026-09-30: no `cancel` in v1.
