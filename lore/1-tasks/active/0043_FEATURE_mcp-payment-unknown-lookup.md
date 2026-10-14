---
id: "0043"
title: "Find the settlement on chain when a paid MCP call ends as payment_unknown"
type: FEATURE
status: active
related_adr: []
related_tasks: ["0037"]
tags: [mcp, payments, priority-medium, effort-medium]
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

## Implementation (grilling 2026-10-14)

Measured facts it rests on:

- Testnet spike 2026-10-13 (5 paid calls, 1 expired): a 25 s authorization settles; settlement
  lands 1–2 ledgers after signing; an expired authorization is refused
  (`invalid_exact_stellar_payload_simulation_failed`) and nothing moves; the outcome is found by
  the authorization's nonce (RPC `getLedgerEntries`, 0.1–0.5 s), not by payer, payTo and amount
  (three identical transfers in one 7-ledger range). Signing takes ~1 s (0037 e2e).
- Mainnet, read-only, 272 settlements of the main Stellar seller: signing → settlement median
  11 s, p90 18 s, p99 36 s, max 182 s.
- Ledger close time (Horizon, 1,000 ledgers per point, 2026-10-14): 5.00 s on testnet and on
  mainnet this week; on mainnet 30–365 days ago a mean of 5.6–5.8 s, single ledgers up to 9 s,
  9 ledgers up to 58 s. Upstream estimates it as the mean of the last 20 ledgers, rounded up, and
  silently falls back to 5 s when Horizon fails (`@x402/stellar` `chunk-HBDJ2YHP.mjs`).
- The authorization expires at a ledger: `current + ceil(seconds / estimate)`
  (`chunk-EGJCLWK3.mjs:55`). The upstream client passes the same requirements object to the
  scheme and into `accepted` (`@x402/core` `client/index.mjs:280-305`), so a wrapped scheme can sign
  a shorter expiry while the seller still sees its own terms.
- The MCP client gives up after 60 s (SDK `DEFAULT_REQUEST_TIMEOUT_MSEC`; extending it on progress
  is the client's choice, off by default).
- A used nonce stays readable until the later of the expiry and the minimum temporary TTL (720
  ledgers on testnet, 17,280 on mainnet), so a lookup right after expiry is final.

Decided:

- **The chain is the clock after signing (W451 A):** the authorization is valid for **6 ledgers**,
  a constant: 6 × 9 s, the slowest ledger seen in a year, is 54 s, under the MCP client's 60 s. The
  call waits for the seller's answer until that ledger closes, never by a timer. The 300 s offer
  filter goes away (a seller's longer limit is only a ceiling). `STELLAR_X402_TIMEOUT_MS` stays for
  the catalog, the preview and the unpaid request (W443 A: its default becomes 45 s).
- **The chain decides every sent payment's outcome (W446 A, W444 A):** after the expiry ledger,
  the nonce says settled or not, whatever the seller said:
  - used → the result with the transaction hash, found by our nonce in the transaction, or
    `payment_settled_no_response` when no answer came; the amount stays spent;
  - not used → `payment_expired`: nothing was paid, the amount goes back to the budget;
  - a hash the seller reports is checked against our nonce, so an old or made-up hash does not
    pass (W435 A);
  - RPC unreachable → `payment_unknown` naming the expiry ledger, and the seller's hash passed on
    marked unverified (W445 B); the only case left without certainty.
- **Two PRs:** (1) the 6-ledger authorization without the 300 s filter; (2) the outcome from the
  chain for every sent payment.
- **Dropped:** a payment journal (W447 A: a local file proves nothing; the chain does); budget
  guards against a seller that keeps refusing (W448 A: the agent sees what was paid and can stop).
- **Upstream ideas, not in this task:** a request-bound nonce in `exact` on Stellar, receipts with
  the nonce and a response hash, an `auth-capture` binding for Stellar (W450; handoff kept outside
  the repo).

## Acceptance Criteria

- [ ] Given a paid call whose seller answers in time, nothing changes for the agent: the response
      and a hash that matches our nonce on chain
- [ ] Given a signed payment, its authorization expires 6 ledgers after signing; the seller still
      sees its own terms in `accepted`; tested on testnet
- [ ] Given a paid call cut off, or refused by the seller, after the payment settled, the agent gets
      the transaction hash found by our nonce; tested with a fake seller and on testnet
- [ ] Given a paid call whose authorization expires unused, the agent gets `payment_expired` and the
      budget is given back; tested with a fake seller and on testnet
- [ ] Given a seller-reported hash that is not our payment, it is not shown as verified
- [ ] Given the chain cannot be reached, the agent gets `payment_unknown` with the expiry ledger and
      the seller's hash marked unverified
