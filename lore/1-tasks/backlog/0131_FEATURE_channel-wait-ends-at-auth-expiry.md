---
id: "0131"
title: "Ledger-time guesses in settlement: the channel wait estimate and the 66-ledger cap"
type: FEATURE
status: backlog
related_adr: ["0011"]
related_tasks: ["0046", "0073", "0074"]
tags: ["effort-small", "priority-low", "money-path"]
links: []
history:
  - date: "2026-11-10"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0074. Left as it is for now; the two ways to change it are kept here, to
      build only once a case shows.
---

# Ledger-time guesses in settlement: the channel wait estimate and the 66-ledger cap

## Summary

`/settle` waits for a free channel until the earlier of its 30 s budget and an estimate of when
the payer's auth expires: ledgers left times 5 s (`settle.ts`, `deadline` in `submit`). The pool
times its own waits at 6 s a ledger (`LEDGER_SECONDS_ESTIMATE`, `signer-pool/src/submitter.ts`).
Two guesses of one length, used only when a payment arrives with 4 or 5 ledgers left.

## Context

- The estimate decides the wait only at 4–5 ledgers left: at 6 or more, 5 s a ledger is at
  least the 30 s budget. `MIN_VALIDITY_LEDGERS` (4) refuses fewer at `/verify`.
- Ending early can drop a payment that could still settle only when ledgers average above about
  6.3 s (5 left) or 6.7 s (4 left): after a channel frees, the pool refuses to sign with fewer
  than 2 ledgers left (`tooCloseToBound`), so the payment is dead before the auth expires.
  Derived from the code, 2026-11-10.
- Measured: 8,000 ledger intervals on 2026-11-05 were all 5 s; the last year averaged 5.6–5.8 s
  (0043). In 279 mainnet settlements of the main Stellar seller (0043, 2026-10-15) the longest
  took 183 s from signing on a 300 s window, so none reached `/settle` with 5 or fewer left.
- Nothing about money depends on it: the pool's check before signing and the envelope's own
  ledger bound keep every transaction inside the auth's life.

## Decided 2026-11-10

- **Now:** leave both estimates as they are. 0 of 279 cases; the harm needs ledgers slower than
  6.3 s on average and a payment on its last 4–5 ledgers.
- **Kept for later, pick one when a case shows:**
  - A: the pool ends the wait for a channel when the latest ledger leaves fewer than 2 to the
    auth's expiry, or at the 30 s budget, whichever comes first; `/settle` drops its estimate
    (about 1–2 h).
  - D: `/settle` drops its estimate and waits the 30 s budget alone; the pool's check before
    signing still refuses a dead payment, which then gets its "nothing sent" answer up to 10 s
    later (about 30 min).
- **The sweep keeps its wall clock** (budget plus 5 s, `reconcile.ts`): it measures how long our
  own process could still sign, not the network. Closing at the expiry ledger instead would hold
  an abandoned claim up to 5.5 minutes rather than about 35 s.

## Also parked here: the 66-ledger cap on faster ledgers

- `MAX_VALIDITY_LEDGERS` (66 by default, 0073 decision 6) is sized for 5 s ledgers: upstream's
  client signs a 300 s offer for 60 ledgers, its check allows 2 more, the rest is spare. If the
  validators vote 4 s ledgers, the same offer signs 75 ledgers and every such payment is refused
  with `…_signature_expiration_too_far` until the cap is raised (about 81: 75 + 2 + 4 spare).
- Measured with the block explorer's database (one row per ledger, 2026-11-10): no month of the
  last year averaged under 5.0 s; the last two averaged 5.0 s, earlier ones 5.1–5.8 s.
- **Decided 2026-11-10:** nothing is built for it now. When a vote for shorter ledgers is
  announced, raise the cap before it takes effect, and consider deriving it from the ledger time.
- Upstream reads the ledger time from Horizon for this; OpenZeppelin uses a 5 s constant.

## Acceptance Criteria

- [ ] A case of a payment dropped while still landable is measured, or ledgers average above 6 s
- [ ] A or D is picked, with a test that fails before the change
- [ ] Before a vote for shorter ledgers takes effect, `MAX_VALIDITY_LEDGERS` fits the new ledger time
