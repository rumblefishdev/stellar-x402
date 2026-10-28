---
id: "0073"
title: "Tell the payer to sign again only once their auth entry can't land"
type: FEATURE
status: active
milestone: 1
related_adr: ["0006"]
related_tasks: ["0019", "0009"]
tags: [facilitator, settlement, priority-high, effort-medium, payments]
links:
  - ../../archive/0019_FEATURE_settlement-record-lifecycle.md
history:
  - date: "2026-10-26"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0019 (decision 31): point 7 of Karol's (karolko9) PR #57 review, left out of
      that PR.
  - date: "2026-10-27"
    status: backlog
    who: okarcz
    note: "Renumbered from 0070, which Karol's catalog badge task also took."
  - date: "2026-10-28"
    status: backlog
    who: okarcz
    note: >
      Raised to high: until it is fixed, a payer told to sign again can pay twice.
  - date: "2026-10-28"
    status: active
    who: okarcz
    note: "Work started."
  - date: "2026-10-28"
    status: active
    who: okarcz
    note: >
      Converted to a directory for research notes: R-sign-again-prior-art (the x402 spec, upstream
      facilitators, Soroban auth, Stripe) and S-sign-again-rule (options; decision still open).
  - date: "2026-10-28"
    status: active
    who: okarcz
    note: >
      Rule decided (decisions 1-5): a 5-minute cap on the auth entry's life at /verify, the
      envelope lives as long as the auth entry, an unsent payment may be retried as is until its
      auth entry expires (its closed record reopens), and a test shows a deploy's 180 s grace with a 5-minute envelope still
      ends every transaction through reconciliation.
---

# Tell the payer to sign again only once their auth entry can't land

## Summary

Some `/settle` answers tell the payer to sign a new payment while the authorization entry they
already signed is still valid. Anyone who holds that payload could still land it, and the payer
would pay twice. Decide when such an answer is safe, and change it if needed.

## Context

- The answers that mean "sign a new payment": `settle_exact_stellar_transaction_expired`
  (reconciliation, once every hash is past its envelope bound), `settle_exact_stellar_interrupted`
  (a claim closed before signing) and the older `…_timeout` ones.
- The envelope's time bound is 60 s (signer-pool `timeoutSeconds`). The payer's auth entry stays
  valid until its own `signatureExpirationLedger`, which the client sets and which can be
  minutes later.
- Until then, whoever holds the payment payload can build a new envelope around the same auth
  entry: the seller's resource server, or anyone who saw the request. If the payer has re-signed
  with a new nonce meanwhile, both can land.
- 0019 decision 6 already reads the auth entry's expiry (`authExpiration`) as the fallback bound
  of a hash stored without one.

## Research

- [R-sign-again-prior-art](notes/R-sign-again-prior-art.md): no spec, upstream facilitator or
  Coinbase doc tells a payer to sign again while the old payment can still land; upstream Stellar's
  envelope lives `maxTimeoutSeconds`, ours 60 s; a Soroban auth entry can't be revoked.
- [S-sign-again-rule](notes/S-sign-again-rule.md): our answers in two groups (nothing sent / sent
  and past the envelope bound), five options (the fifth, a cap on the auth entry's life, came
  from okarcz's 7-day attack), and the code checks behind them.

## Implementation

- **Cap** (decision 2): `/verify`, and `/settle`'s re-check, refuse an auth entry whose
  `signatureExpirationLedger` is more than 60 ledgers ahead, with
  `invalid_exact_stellar_signature_expiration_too_far` and a message naming the cap. A config
  value with 60 as its default.
- **Envelope** (decision 1): when the call sets `maxLedger`, the envelope's time bound no longer
  ends it early: drop it, or set it past the ledger bound. The confirm wait follows the ledger
  bound, so a transaction that never shows up holds its channel up to the cap, not 60 s.
  Reconciliation's `expired` then fires only once the auth entry can't land.
- **Retry of an unsent payment** (decision 3): a record closed with nothing sent (`timeout`,
  `rpcUnavailable`, `interrupted`, `shuttingDown`, `noChannelInTime`, `noChannels`) can be claimed
  again by the identical payload (same fingerprint) while its auth entry is valid. Those answers
  say "retry the same payment" until the expiration ledger, and "sign a new payment" only after
  it. Look at upstream's `…_submission_retryable` with `extra.retryable` for the answer's shape.
  The record reopens (decision 5): `claim()` moves a `rejected` record with no hash and the same
  fingerprint back to `claimed` in one compare-and-set, only while its auth entry is valid. A
  different payload on the same nonce stays refused. Amend AD-16 for this one backward edge, and
  keep the earlier answer in a log line or an attempt count.
- **Drain** (decision 4): keep 0025's fallback. Test it: a transaction sent just before SIGTERM,
  with a 5-minute envelope, outlives the 180 s grace; the next process takes the lease and its
  reconciliation ends the record with the transaction's real outcome.
- Update the facilitator README's settle answers, ADR 0006 (answers) and spine AD-22 (the cap and
  the envelope bound).

## Acceptance Criteria

- [ ] Given an auth entry that expires more than 60 ledgers ahead, when `/verify` or `/settle` checks it, then it is refused with `…_signature_expiration_too_far`, whatever `maxTimeoutSeconds` says
- [ ] Given a sent transaction, when its envelope is built, then it can land until the auth entry's expiration ledger and no earlier bound ends it; reconciliation answers `…_transaction_expired` only once that ledger has passed
- [ ] Given a payment closed with nothing sent, when the identical payload comes back while its auth entry is valid, then it is settled once; after the expiration ledger the answer is "sign a new payment"; a different payload on the same nonce is still refused
- [ ] Given a transaction sent just before SIGTERM with a 5-minute envelope, when the 180 s grace ends before it is final, then the next process takes the lease and its reconciliation ends the record with the transaction's real outcome (test)
- [x] Given the decided rule, when the task ends, then the decision and the options considered are recorded in this task (decisions 1-4, S-sign-again-rule)

## Design Decisions

### From Plan

1. **The envelope lives as long as the auth entry** (okarcz, 2026-10-28): `expired` must mean
   "can no longer land", as the x402 family rule puts it. The 60 s time bound made `expired`
   unsafe for up to `maxTimeoutSeconds` minus 60 s. Chosen over keeping 60 s with a pending
   record, a cap alone, and accepting the risk.
2. **A 5-minute cap (60 ledgers) on the auth entry's life** (okarcz, 2026-10-28): without it,
   decision 1 lets a caller who writes both payload and requirements sign for days, and every
   dropped transaction would hold its channel that long. 300 s fits the main mainnet seller
   (0043). No facilitator found caps this; client-side clamps of 300 s exist.
3. **An unsent payment is retried as is, not re-signed, while its auth entry is valid**
   (okarcz, 2026-10-28): the payload stays landable by whoever holds it, so "sign a new payment"
   invites a double payment. Matches upstream EVM and SVM, Coinbase's guidance and Stripe's rule.
   Chosen over accepting the risk and over keeping the record open until expiry.
4. **The deploy keeps its 180 s grace** (okarcz, 2026-10-28): 0025's fallback (cut connections
   past 150 s, let the lease expire, the next process reconciles) covers a 5-minute envelope; a
   test must show it.
5. **An unsent record reopens on retry, rather than staying open** (okarcz, 2026-10-28): it
   closes at once and releases its spend reservation, and the identical retry reopens it
   (`rejected → claimed`, compare-and-set, before the auth expiry) and reserves again. So an
   abandoned payment holds no budget: in an outage, 200 open records would hold 200 USDC for up
   to 5 minutes. Cost: AD-16's forward-only states get one written exception. Chosen over a
   non-final `unsent` state closed by a sweep after the expiry.
