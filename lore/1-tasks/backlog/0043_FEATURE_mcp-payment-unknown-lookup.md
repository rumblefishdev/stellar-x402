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
    who: karolkow
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

## Implementation (decided 2026-10-13, W326 A)

Measured on testnet 2026-10-13 (spike, 5 paid calls + 1 expired, scripts outside the repo):
a 25 s authorization settles (x402.org and upstream 2.28 verify only reject an expiry that is too
far); a 10 s one settled in its last valid ledger (too tight); ledgers close every 5.0 s; a paid
call takes 5.2–9.7 s, signing 0.8–1.5 s, settlement lands 1–2 ledgers after signing; an expired
authorization is refused with `invalid_exact_stellar_payload_simulation_failed` and nothing moves;
the outcome is found by the authorization's nonce (its temporary ledger entry exists once used,
0.1–0.5 s via RPC `getLedgerEntries`; the tx hash via the transfer event and the envelope's nonce),
not by payer/payTo/amount alone (three identical transfers in one 7-ledger range).

- The buyer signs with an expiry of **what is left of the call's window** (about 45 s after a fast
  402; the MCP client waits 60 s), never longer than the seller's `maxTimeoutSeconds`; the seller
  still sees its own terms in `accepted` (W351 A, 2026-10-14). Measured on mainnet (read-only, 272
  settlements of the main Stellar seller in the Bazaar catalog): signing → settlement median 11 s,
  p90 18 s, p99 36 s, max 182 s; 45 s covers 98.9%. The rest expire unused: nothing is paid, the
  budget comes back (`payment_expired`), the agent may retry. The 300 s offer filter goes away: the
  seller's value is only a ceiling.
- `call_paid_http` waits for the paid answer up to **35 s** after signing.
- No answer: wait until the latest ledger passes the expiry ledger (≤ 5 s), then look the nonce up:
  - used → `payment_settled_no_response` with the transaction hash; the amount stays spent;
  - not used → `payment_expired`: nothing was paid, the amount goes back to the budget(s);
  - RPC unreachable → `payment_unknown` (kept only for this case).
- Worst case ~45–50 s, under the MCP client's 60 s.
- A settlement header that arrived before the body failed (too large, stalled) is used, not
  discarded: the hash is known, so the result is `payment_settled_no_response` without a chain
  lookup (found while documenting the codes, PR #35).
- First step, cheap: the `payment_unknown` result names what was signed (payTo, asset, amount,
  the authorization's expiry) and tells the agent not to retry (W314).

## Acceptance Criteria

- [ ] Given a paid call whose seller answers within the window, nothing changes: 200 and the hash
- [ ] Given a paid call cut off after the payment settled (within its validity), the agent gets
      `payment_settled_no_response` with the transaction hash; tested with a fake seller and on
      testnet
- [ ] Given a paid call cut off whose authorization expires unused, the agent gets
      `payment_expired` and the budget is given back; tested with a fake seller and on testnet
      (an expired authorization sent late is refused and nothing moves)
- [ ] Given the chain cannot be reached, the agent gets `payment_unknown` with what was signed
