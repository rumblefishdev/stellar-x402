---
id: "0063"
title: "Keep catalog listings from being overwritten or padded before pubnet"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008"]
related_tasks: ["0032", "0054", "0023", "0015"]
tags: [bazaar, discovery, security, priority-medium, effort-medium]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: >
      Found in the PR #50 review: /discovery/resources makes the catalog public, and with it two
      gaps in how entries are written.
---

# Keep catalog listings from being overwritten or padded before pubnet

## Summary

As a seller listed in the Bazaar, I want only my own settlements to change my listing, and as the
operator, I want a listing page to stay small, so that nobody can rewrite another seller's
description or price, and nobody can make `/discovery/resources` answer megabytes.

## Context

- **Overwrite.** An entry's key is network + `payTo` + method + resource URL
  (`packages/bazaar/src/normalize.ts`). On a newer ledger, `mergeCatalogEntry`
  (`apps/facilitator/src/adapters/rules.ts:78`) takes every field from the incoming write and
  replaces the requirement with the same `scheme|network|asset`. Anyone can call `/settle` with
  the victim's `payTo`, a 1-stroop payment and the victim's resource URL: there is no minimum
  amount and no asset allowlist, and the facilitator pays the fee. The victim's description, icon
  and price are then the caller's.
- **Size.** Only the `extensions.bazaar` block is capped (32 KiB, `validate.ts:111`). `accepts`
  keeps the caller's requirements as sent (`normalize.ts:44`), `extra` included, bounded only by
  `BODY_LIMIT_BYTES` (64 KiB), and grows by one requirement per distinct asset. Measured in the
  PR #50 review: a 100-entry page of such entries is 4.7–6.4 MB, and 20 concurrent listings
  raised a cheap route's p95 on the same process to 743 ms.
- ADR 0008 accepts that anyone who settles a tiny payment can **create** a listing; it doesn't
  cover replacing someone else's. `packages/mcp` pays whatever `payTo` a 402 names
  (`packages/mcp/src/pay.ts`), so a buyer that picks resources by `payTo` from the catalog can be
  sent elsewhere.
- Not here: loopback and private resource URLs on pubnet (0054); rate limits (0023).

## Options to decide

- Changes to an entry only with the seller's signature (the `payTo` key).
- The first write keeps the entry's text and prices; later writes refresh `lastUpdated` and add
  new assets only. Simple, but a seller can't change a price or description.
- For size: store only the spec's `PaymentRequirements` fields, cap `extra` and the length of
  `accepts`.

## Acceptance Criteria

- [ ] Decided and written into ADR 0008: who may change an existing listing, and the entry size
      limits
- [ ] Given an entry written by one settlement, when a settlement by another payer to the same
      key arrives, then it can't replace the entry's text or an existing price unless the
      decision above allows it
- [ ] Given a requirement with unknown fields or an oversized `extra`, when it is cataloged, then
      the stored entry stays within the decided limit
