---
id: "0083"
title: "Raise the Bazaar schema depth limit so ordinary listings pass"
type: BUG
status: completed
related_adr: ["0008"]
related_tasks: ["0030", "0063"]
tags: [bazaar, discovery, priority-high, effort-small]
links: []
history:
  - date: "2026-10-28"
    status: active
    who: karolkow
    note: >
      Found while measuring 0063 on real listings: the depth limit from 0030 refuses most of them.
  - date: "2026-10-29"
    status: completed
    who: karolkow
    note: >
      PR #87 merged: `LIMITS.schemaDepth` is 32. A test lists a real three-objects-deep answer and a
      schema 32 levels deep, and refuses 33 as `schema_too_complex`. ADR 0008 names no depth, so it
      is unchanged. No follow-up tasks.
---

# Raise the Bazaar schema depth limit so ordinary listings pass

## Summary

A listing's JSON Schema may be at most 10 levels deep (`packages/bazaar/src/limits.ts`, from 0030).
Upstream's `declareDiscoveryExtension` already spends 4 levels on its wrapper
(`properties > output > properties > example`), and every nested object of the answer adds 2, so a
response three objects deep is refused as `schema_too_complex`.

## Context

- Measured on the largest public x402 catalog (all 92,900 entries, 2026-10-28): 61,283 fail on
  depth alone. Depth p50 11, p99 13, p99.9 16, max 25; node counts stay under the 1,000 cap (max 723).
- The limit protects buyers' tools that walk a schema recursively; our own walk uses an explicit
  stack and has no depth risk. The node cap and the 32 KiB block cap bound the work either way.
- Decided 2026-10-28: 32, which refuses none of the measured entries.

## Acceptance Criteria

- [x] A schema 25 levels deep (the deepest real one) is listed; one deeper than 32 is refused as
      `schema_too_complex`
- [x] ADR 0008's limits, if they name the depth, say 32 (it names none)
