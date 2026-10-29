---
id: "0085"
title: "Keep a payment refused for its fee from settling after its payer signed again"
type: BUG
status: backlog
milestone: 1
related_adr: ["0006"]
related_tasks: ["0073", "0009"]
tags: [facilitator, settlement, priority-medium, effort-medium]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073 decision 23 (PR #80 review): the same replay as `…_too_far`, which
      decision 22 closed on the requirements; a fee isn't in them.
---

# Keep a payment refused for its fee from settling after its payer signed again

## Summary

`/verify` and `/settle`'s checks refuse a payment with `invalid_exact_stellar_payload_fee_exceeds_maximum`
when our fee estimate is above our ceiling. The refusal records nothing, so the same payment
passes once fees drop. If its payer signed a second payment meanwhile, both can land.

## Context

- The scenario: P1 is refused on a fee spike, the seller asks for a new signature and settles P2,
  then P1 is sent again (a retry with backoff, a queued replay) after the spike and settles too.
  The README's "Callers" section says such a refusal "may succeed later", but nothing stops a
  seller from asking for a new signature meanwhile.
- Already on develop before 0073. 0073 decision 22 closed the same path for `…_too_far` by
  refusing on the resource's `maxTimeoutSeconds`, which doesn't change over time; a fee does.
- A refusal after the claim (`settle_exact_stellar_fee_exceeds_maximum`) is recorded already, and
  is not in #86's `UNSENT_REASONS`, so its record stays final and a replay is answered from it.
- Whoever holds P1 can always submit it on chain without us; this task is about our own path.

## Implementation

- Options seen in 0073's review: store a final `rejected` record under the payment's key on the
  refusal (`claim` then `finish`, in `/verify` and `/settle`), so AD-6's lookup answers a later
  attempt; or answer the refusal so the seller retries the same payment instead of asking for a
  new one. To be chosen when the task starts.
- If records are stored: `/verify` starts writing, so decide what a failed write answers and
  whether `/verify` refuses any known key.

## Acceptance Criteria

- [ ] Given a payment refused for its fee, when the same payment is sent again after fees drop,
      then it doesn't settle through the facilitator
- [ ] Given that refusal, when the seller reads the answer, then it says what to do without
      inviting a second signature that can land next to the first
