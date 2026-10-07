---
id: "0009"
title: "Wire the settlement submitter into the facilitator app and the upto scheme"
type: FEATURE
status: backlog
related_adr: []
related_tasks: ["0007", "0006"]
tags: [facilitator, signer-pool, upto, settlement, priority-high, effort-large]
links:
  - ../archive/0007_FEATURE_facilitator-settlement-submitter.md
  - ../../../docs/x402-settlement-scaling-en.md
history:
  - date: "2026-10-06"
    status: backlog
    who: claude
    note: "Spawned from 0007 future work and the PR #4 review (Adam)."
---

# Wire the settlement submitter into the facilitator app and the upto scheme

## Summary

Use `packages/signer-pool` (0007) from the facilitator's `/settle` for the `upto` scheme. The
submitter now gives the pieces the app needs: a `pending` result with a `resolved` event, an
`onSigned` hash hook, and a per-call `deadline`. This task builds the app side: the x402
responses, a durable record of settlements, and the rules the pool leaves to the scheme.

## Context

- 0007 built the pool and measured it on testnet: about 1 settlement per channel per ledger, up
  to the network ceiling.
- Adam's [settlement scaling analysis](../../../docs/x402-settlement-scaling-en.md) proposes
  ADR-R1: one payment = one transaction through this pool, with `settlement_pending` on timeout
  and a durable settlement registry.

## Implementation

- **`settlement_pending`:**
  - Map the submitter's `pending` result to x402 v2 `settlement_pending` with the hash.
  - Answer a retried `/settle` from the record, and record the final outcome from the `resolved`
    event.
- **Durable settlement record:**
  - Store the hash from `onSigned` before the first send, so a crash can't lose a payment that
    may still land.
  - Deduplicate on `(payer, nonce)`, as the `exact` spec requires and `upto` needs too.
- **Deadline:** pass `deadline` from the client's `signatureExpirationLedger`, so a payment isn't
  queued past the point where it can settle.
- **Zero-amount `upto`:** submit nothing and return `transaction: ""`, as the spec allows.
  Document that the client's nonce stays unused until its deadline. This was 0007 step 5, which
  moved here (0007 Emerged 2).
- **Fee and pool configuration:** turn on `feeEscalation`, set `maxFeeStroops`, and size the pool
  from the target rate. With pipelining that is about 1 channel per settlement per ledger.
- **Monitoring:** forward `onEvent` to metrics. Alert on `channel-quarantined`, on `pending`
  results, and on `checkFacilitatorBalance(...).low`.

## Acceptance Criteria

- [ ] `/settle` returns `settlement_pending` with the hash when the submitter reports `pending`,
      and the final outcome once it resolves
- [ ] Hashes are stored before sending; a duplicate `(payer, nonce)` is not settled twice
- [ ] A zero-amount `upto` settlement submits nothing
- [ ] The deadline comes from the client's signature expiry
- [ ] Metrics and alerts wired from `onEvent`
