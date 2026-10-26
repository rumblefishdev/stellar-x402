---
id: "0070"
title: "Tell the payer to sign again only once their auth entry can't land"
type: FEATURE
status: backlog
related_adr: ["0006"]
related_tasks: ["0019", "0009"]
tags: [facilitator, settlement, priority-medium, effort-medium, payments]
links:
  - ../active/0019_FEATURE_settlement-record-lifecycle.md
history:
  - date: "2026-10-26"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0019 (decision 31): point 7 of Karol's (karolko9) PR #57 review, left out of
      that PR.
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

## Implementation

- Decide the rule. Options seen so far:
  - answer `settlement_pending` ("repeat the same payment") until the auth entry's expiration
    ledger has passed, and expire the record only then;
  - keep the answers and record the risk as accepted, with the reason;
  - something in the requirements that keeps the auth entry's lifetime close to the envelope's.
- Apply the rule to every "sign again" answer, in `/settle` and in reconciliation.
- Update the README's settle answers and ADR 0006 if the rule changes them.

## Acceptance Criteria

- [ ] Given a payment whose transaction can no longer land but whose auth entry is still valid, when `/settle` or reconciliation answers it, then the answer follows the decided rule, and a test covers it
- [ ] Given the decided rule, when the task ends, then the decision and the options considered are recorded in this task
