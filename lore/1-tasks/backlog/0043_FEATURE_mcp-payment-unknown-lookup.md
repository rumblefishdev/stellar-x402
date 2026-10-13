---
id: "0043"
title: "Find the settlement on chain when a paid MCP call ends as payment_unknown"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0037"]
tags: [mcp, payments, priority-low, effort-small]
links: []
history:
  - date: "2026-10-13"
    status: backlog
    who: claude
    note: "Spawned from 0037 (W315): payment_unknown leaves the agent without a transaction hash."
---

# Find the settlement on chain when a paid MCP call ends as payment_unknown

## Summary

When `call_paid_http` ends with `payment_unknown` (the signed payment left, the seller's answer did
not arrive in time), look the payment up on Stellar testnet and tell the agent whether it settled,
with the transaction hash, instead of leaving it unknown.

## Context

- 0037: after the signed payment leaves the process, any failure is `payment_unknown`; the amount
  stays counted; there is no retry (a retry signs a second payment). The purchased response is lost
  either way: x402 has no refunds and sellers do not replay answers.
- Measured 2026-10-13 on testnet: a paid call takes ~5 s (4.8–5.7 s, 3 calls), so this case is
  rare; it matters when a facilitator or seller is slow.
- The signed authorization names payer, payTo, asset, amount and an expiry ledger; after the expiry
  an unsettled payment can no longer settle, so a lookup after it is final.

## Implementation (to decide)

- First step, cheap: the `payment_unknown` result names what was signed (payTo, asset, amount,
  the authorization's expiry) and tells the agent not to retry but to check after the expiry (W314).

- Where to look: Horizon or RPC, by payer → payTo transfer of that amount after the signing time,
  or by the authorization's nonce.
- Within the call's deadline (a short lookup), or a separate read-only tool `check_payment`.
- The result: `payment_settled_without_response` (hash) / `payment_unknown` (not yet visible) /
  `payment_expired` (nothing moved).

## Acceptance Criteria

- [ ] Given a paid call cut off after the payment was sent and settled, the agent gets the
      transaction hash and a code saying the payment settled but the response was lost
- [ ] Given one cut off whose payment never settles, the agent learns that nothing moved once the
      authorization expired
