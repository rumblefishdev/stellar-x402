---
id: "0043"
title: "Find the settlement on chain when a paid MCP call ends as payment_unknown"
type: FEATURE
status: backlog
milestone: 2
related_adr: []
related_tasks: ["0037"]
tags: [mcp, payments, priority-low, effort-medium]
links: []
history:
  - date: "2026-10-13"
    status: backlog
    who: karolkow
    note: "Spawned from 0037 (W315): payment_unknown leaves the agent without a transaction hash."
  - date: "2026-10-14"
    status: active
    who: karolkow
    note: >
      Work started after 0037 closed. Effort raised to medium: three PRs on the payment path.
  - date: "2026-10-15"
    status: backlog
    who: karolkow
    note: >
      Parked (W475 A). The short-authorization PR #42 was closed unmerged; the design depends on
      settlement delays we cannot know until our own facilitator runs (0009, 0026). Findings kept
      below for when it comes back.
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      0009 is done; still parked on 0026, since the delays come from our facilitator running in
      public.
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

## Parked (2026-10-15, W475 A)

Nothing is built. Today `call_paid_http` signs for what the seller asks (300 s cap) and answers
`payment_unknown` when a sent payment's outcome cannot be read. Come back when our own facilitator
settles payments in public (0026; 0009 is done) and its delays, queueing included, can be measured: the right shape
depends on them.

What was learned, so it need not be measured again:

- **Settlement delay on mainnet** (read-only, 2026-10-15): the main Stellar seller in the Bazaar
  catalog (560 of 585 Stellar offers, all asking 300 s), 279 settlements July–October; the
  signing ledger recovered per settlement from its expiry and the network's ledger time.
  Signing → settlement: median 12 s, p90 18 s, p95 23 s, p99 65 s, max 183 s. Settled within
  15 s 68.1%, 20 s 93.5%, 30 s 97.1%, 45 s 97.8%; 4 of 279 took over 60 s (61, 65, 180, 183 s).
- **Ledger time** (Horizon): 5.0 s this month on testnet and mainnet; on mainnet in the last
  year a mean of 5.6–5.8 s, single ledgers up to 12 s (a 300-page random sample), the slowest
  6 ledgers in a row 44 s.
- **The MCP client gives up after 60 s** (TypeScript SDK default; Claude Desktop reportedly
  cannot change it; Claude Code honours `MCP_TOOL_TIMEOUT`).
- **Upstream signs a shorter expiry if asked:** `@x402/core` passes the same offer to the scheme
  and into `accepted`, so a wrapped scheme can sign shorter while the seller sees its own terms;
  upstream verify rejects only an expiry that is too far. Our facilitator refuses fewer than 4
  ledgers left (`apps/facilitator`, `MIN_VALIDITY_LEDGERS`).
- **A used nonce is final:** Soroban refuses it a second time (`Error(Auth, ExistingValue)`); the
  entry stays readable until the later of the expiry and the minimum temporary TTL (720 ledgers on
  testnet, 17,280 on mainnet).

Shapes considered:

| Shape | For | Against |
| --- | --- | --- |
| Short authorization: expire before the call ends (PR #42, closed) | certainty within one call | ~3% of payments expire (30 s); sellers whose work outlasts ~30 s can never be paid; rests on guessed ledger and RPC times; clashes with our facilitator's 4-ledger minimum |
| 300 s and a `check_payment` tool reading the nonce (W461 C) | ~100% settle; no clock arithmetic; the agent checks when told | a second call; an agent that ignores the advice may pay twice (bounded by the limits) |
| The buyer cancels by consuming its own nonce first | certainty in ~3–5 s (testnet: works both ways) | rejected: costs the buyer XLM and a transaction per uncertain payment |

Decided while it ran, still valid: the chain decides a sent payment's outcome, not the seller's
word (W444 A, W446 A); a seller-reported hash is checked against our nonce (W435 A); no payment
journal (W447 A); no budget guards against a refusing seller (W448 A). Upstream ideas (a
request-bound nonce, receipts with a response hash, `auth-capture` for Stellar) are not part of
this task (W450).

## Acceptance Criteria

To be written when the task comes back, for the shape chosen then. Whatever the shape: the agent
learns whether a sent payment settled, from the chain, with the hash when it did.
