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
  - date: "2026-10-09"
    status: active
    who: akot
    note: >
      Cataloger, header encoder, metrics seam and CatalogStore stale guard built on the hooks.
      Plan from parallel GSD and BMAD runs, merged. /settle and resolved wiring stay with 0009/0019.
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

- [x] Given a settlement whose record turns `success`, immediately or later through a resolved event, with `extensions.bazaar` in the payload, when the on-success hook fires, then the entry is upserted into `CatalogStore` after the response is sent; upserts are idempotent and update `lastUpdated`
- [x] Given a payload without `extensions.bazaar`, a settlement that didn't succeed, or a payment that was only verified, when it is processed, then nothing is cataloged
- [x] Given a settlement with `extensions.bazaar`, when `/settle` responds, then the synchronous validation result is in a base64 JSON `EXTENSION-RESPONSES` header with status `processing` or `rejected`; the body and status of the settle response never change
- [x] Given a `CatalogStore` failure, when the upsert runs, then the settle response is unaffected and the error is logged and counted; the facilitator never fetches a seller-supplied URL

The criteria are met on the hook side; the real `/settle` route (0009) and the `resolved` path
(0019) call these hooks by the caller rules below.

## Design Decisions

1. **Plugs in only through `SettlementHooks`** (`src/catalog/cataloger.ts`): `extensionResponses`
   runs `validate()` synchronously; `onSuccess` validates again, then `normalize()` and upsert. It
   never rejects; `drain()` waits for in-flight writes (0025 shutdown).
2. **Caller rules for 0009 and 0019.** Set the header (`encodeExtensionResponses`) on every
   `success: true` settle answer, replays included, never on `success: false`. Call
   `onSuccess(record, "settle")` once, by the transition that won, after the response:
   `if (res.closed) dispatch(); else res.once("close", dispatch)`; a plain `once("close")` misses a
   client that left before the write. A `resolved` event or the startup re-check calls
   `onSuccess(record, "resolved")`. `/verify` and replays never call it.
3. **`lastUpdated` = when the record turned `success`**, so a repeated call writes the same state.
4. **Stale guard in the port (emerged).** `upsert` resolves `inserted | updated | stale`; an older
   `lastUpdated` changes nothing, so a late success can't regress a newer listing. 0022 inherits
   the contract case (a conditional upsert). `keyVersion` is stored with each entry.
5. **`rejectedReason`** replaces `reason` in `ExtensionResponses` (the spec's field; day-1 item).
6. **Metrics seam** (`src/metrics.ts`) until 0027: `catalog_upserts_total{origin,outcome}`,
   `catalog_rejections_total{origin,reason}`, `catalog_upsert_failures_total{origin}`,
   `catalog_internal_errors_total{stage}`, `catalog_route_template_ignored_total{origin}`.
7. **Not built until the day-1 review agrees:** the eligible-asset gate (RT1/RT2) and listing caps
   (RT4).
