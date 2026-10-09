---
id: "0031"
title: "Catalog resources after successful settlements"
type: FEATURE
status: active
milestone: 1
related_adr: ["0008", "0004"]
related_tasks: ["0012", "0030", "0017", "0009"]
tags: [bazaar, facilitator, priority-high, effort-small, discovery]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 4.2 (Discovery lane)."
  - date: "2026-10-09"
    status: active
    who: akot
    note: "Started by the Discovery lane, on top of the 0030 validator (PR #15)."
---

# Catalog resources after successful settlements

## Summary

As a seller, I want my resource listed automatically after a buyer pays for it, so that I don't need a separate registration step.

**Story:** [M1 Story 4.2](../../../docs/planning/m1-epics.md#story-42-catalog-resources-after-successful-settlements) · **Lane:** Discovery · **Covers:** FR15, FR17 (AD-8, AD-19)

## Context

- Plugs into the on-success hook from 1.1; uses a fake settle until 0009 calls the real hook.
- Related tasks: 0030, 0017, 0009.

## Implementation

- Cataloger in `apps/facilitator` that calls `packages/bazaar` and writes `CatalogStore`.
- Header builder for `EXTENSION-RESPONSES`.
- Tests for the trigger rules, the header and store failures.

## Acceptance Criteria

- [ ] Given a settlement whose record turns `success`, immediately or later through a resolved event, with `extensions.bazaar` in the payload, when the on-success hook fires, then the entry is upserted into `CatalogStore` after the response is sent; upserts are idempotent and update `lastUpdated`
- [ ] Given a payload without `extensions.bazaar`, a settlement that didn't succeed, or a payment that was only verified, when it is processed, then nothing is cataloged
- [ ] Given a settlement with `extensions.bazaar`, when `/settle` responds, then the synchronous validation result is in a base64 JSON `EXTENSION-RESPONSES` header with status `processing` or `rejected`; the body and status of the settle response never change
- [ ] Given a `CatalogStore` failure, when the upsert runs, then the settle response is unaffected and the error is logged and counted; the facilitator never fetches a seller-supplied URL
