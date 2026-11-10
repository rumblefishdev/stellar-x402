---
id: "0112"
title: "Decide what the facilitator keeps of a client's URL, and for how long"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008", "0011"]
related_tasks: ["0063", "0038"]
tags: [facilitator, bazaar, privacy, before-pubnet, priority-medium, effort-medium]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-11-04"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063: a client's URL can hold personal data, and it is kept in several places
      with no way to remove it.
---

# Decide what the facilitator keeps of a client's URL, and for how long

## Summary

As a client, I want my e-mail or ID number in a paid URL not to stay at the facilitator longer than
needed or become public, so that the facilitator meets GDPR before pubnet.

## Context

A client's URL can hold personal data: real sellers have routes such as `/screen/email/:email` and
`/screen/id/:government_id`, and `?email=` works on any route. Where it is today, once 0063 lands:

| Place | What | Who sees it | How long | Removable |
|---|---|---|---|---|
| Public listing | a path value the seller's 402 echoes | anyone | until the next check | no |
| `settlements.payment_payload` | URL with query, payer | operator | no limit | no |
| `catalog_attempts` | URL with query, copy, answer, payer | operator | 30 days | pruned |
| Logs in CloudWatch | URL on a refusal, payer | admins of the shared AWS account | 30 days | expire |
| Database backups | what the database holds | operator | 14 days | expire |
| Stellar | payer, amount | anyone | always | no |

- Measured 2026-11-04: 173 of 198 hosts echo the client's path value in their 402, 3 of 1,158 listings
  with values name an e-mail or ID number, and 33 of 104,924 URLs without a template hold an
  identifier-like value. 0063 accepted the public value and named it in ADR 0008.
- Outside settlement, only the cataloger reads the URL in `payment_payload`; reconciliation reads
  the transaction (`settlement/reconcile.ts`, read 2026-11-04).
- The payer's account stays out of scope: it is public on chain anyway.
- GDPR art. 5(1)(c) and (e): data limited to what is necessary, and kept no longer than necessary.
  EDPB Guidelines 02/2025 are known here from summaries only.
- Each new differing copy is a row (0063); whether that cost stays belongs here too.

## Implementation

Decided in this task, not before:

- What each place keeps of the URL, and when the stored payload loses it.
- Whether a public listing keeps path values, given the count above.
- What happens on a request to remove someone's data.
- A privacy policy for the facilitator.
- Questions for a lawyer: who is the controller of a self-hosted facilitator, whether the seller
  shares that role, and the legal basis.

## Acceptance Criteria

- [ ] A written decision, per place in the table: what it keeps and for how long
- [ ] Given a URL with a query, when its settlement and cataloging are finished, then the kept data
      matches that decision
- [ ] The facilitator has a privacy policy that states what it keeps
- [ ] The lawyer's answers are recorded
