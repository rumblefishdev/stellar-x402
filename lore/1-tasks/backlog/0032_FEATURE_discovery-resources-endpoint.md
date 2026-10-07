---
id: "0032"
title: "List resources in /discovery/resources"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008"]
related_tasks: ["0012", "0031", "0017"]
tags: [bazaar, facilitator, priority-high, effort-small, discovery]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 4.3 (Discovery lane)."
---

# List resources in `/discovery/resources`

## Summary

As a agent, I want to list catalog resources with the standard discovery filters, so that I can find Stellar services with the same client I use for other x402 facilitators.

**Story:** [M1 Story 4.3](../../../docs/planning/m1-epics.md#story-43-list-resources-in-discoveryresources) · **Lane:** Discovery · **Covers:** FR18 (AD-20)

## Context

- Reads `CatalogStore`; builds on the in-memory fake until 0022 lands.
- Search and ranking come in a later tranche.
- Related tasks: 0031, 0017.

## Implementation

- Route in `http/` with filter parsing and the upstream response types.
- Query through `CatalogStore`; tests per filter.

## Acceptance Criteria

- [ ] Given cataloged entries, when `GET /discovery/resources` is called, then the response uses the upstream discovery list types, with each resource's `accepts` terms, `extensions.bazaar.info` and `lastUpdated`
- [ ] Given the `type`, `payTo`, `network`, `extensions`, `limit` and `offset` filters, when they are used alone or combined, then only matching entries are returned
- [ ] Given no `limit`, or a `limit` above the maximum, when the endpoint is called, then the fixed default applies, or the value is clamped to the maximum; results come in a stable order with no ranking
