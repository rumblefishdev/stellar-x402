---
id: "0030"
title: "Bazaar validator and normalizer"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008"]
related_tasks: ["0012"]
tags: [bazaar, security, priority-high, effort-small, discovery]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 4.1 (Discovery lane)."
---

# Bazaar validator and normalizer

## Summary

As a agent looking for paid services, I want only well-formed, safe listings to reach the catalog, so that I can trust what discovery returns.

**Story:** [M1 Story 4.1](../../../docs/planning/m1-epics.md#story-41-bazaar-validator-and-normalizer) · **Lane:** Discovery · **Covers:** FR16 (AD-19)

## Context

- Pure library with no dependencies on the facilitator, so it can start on day 1.
- Types come from `@x402/extensions`; no parallel schema (ADR 0008).

## Implementation

- `packages/bazaar`: `validate()` and `normalize()` plus the catalog-key function.
- Unit tests for both input types, soft-drop cases, SSRF cases and route templates.

## Acceptance Criteria

- [ ] Given an `extensions.bazaar` block with an `http` or `mcp` input type, when it is validated, then a valid block becomes a normalized entry typed with `@x402/extensions`
- [ ] Given a malformed required field, when it is validated, then the listing is rejected with a reason; a malformed optional field (`serviceName`, `tags`, `iconUrl`) is dropped and the listing kept
- [ ] Given an `iconUrl`, when it is validated, then it is kept only if it is absolute https with no IP literal and no loopback or private host
- [ ] Given calls to `/users/42` and `/users/7` with `routeTemplate` `/users/:userId`, when their catalog keys are computed, then both produce one key: `network + payTo + method + normalized URL`; `packages/bazaar` does no I/O and reads no env, and is fully unit-tested
