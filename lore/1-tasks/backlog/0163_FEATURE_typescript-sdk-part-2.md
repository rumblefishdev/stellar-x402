---
id: "0163"
title: "TypeScript SDK, part 2: validateListing, the buyer's core, upto and npm"
type: FEATURE
status: backlog
milestone: 3
related_adr: ["0001"]
related_tasks: ["0102", "0162", "0075", "0041", "0015", "0034", "0140"]
tags: [sdk, typescript, priority-medium, effort-medium, dev-tools]
links:
  - ../archive/0102_FEATURE_sdk-helpers-from-the-rfp/notes/R-sdk-helper-survey.md
history:
  - date: "2026-11-25"
    status: backlog
    who: akot
    note: >
      Spawned from 0102 when its helper list was decided: the tranche table puts SDK helpers in #2
      and #3, and no task held the half that waits for M3.
---

# TypeScript SDK, part 2: validateListing, the buyer's core, upto and npm

## Summary

As a developer selling or buying on Stellar with x402, I want the TypeScript SDK from 0102 to check
my listing before my first sale, to pay with `upto`, and to install from npm, so that the SDK the
proposal describes is complete.

## Context

- 0102 is part 1, in Tranche #2: five helpers, in a package that stays `private`. This task is
  what 0102 put off, each item waiting for something M2 doesn't have. The reasons are in 0102's
  [R-sdk-helper-survey](../archive/0102_FEATURE_sdk-helpers-from-the-rfp/notes/R-sdk-helper-survey.md),
  decisions 3, 4, 7, 10 and 11. The split follows the Rust crate's (0136, 0140).
- Dropped for good in 0102, not put off: `searchAndPay`, and adding a trustline (`changeTrust`).
- The example integrations are 0041's; this task gives them what they call.

## Implementation Plan

- Read 0102's closing notes first: they may add to or cut this scope.
- **`validateListing`**: a seller checks its discovery declaration against the catalog's limits
  before the first sale and gets the refusal reason without paying. It runs the catalog's own
  code, which is in the private `@stellar-x402/bazaar`: decide whether that package is published
  or built into the SDK. With the seller guide (0075).
- **SQLite budget store**: `apps/mcp-local/src/daily.ts` as `/sqlite`, or it stays in MCP. Decide
  from what the buyer in 0041's examples needs; "stays in MCP" closes this item without code.
- **The buyer's core as a public API**: the client made per call, so the same limits hold outside
  HTTP. 0162 (paid MCP tools) is its first user; export it with that task, not before.
- **`upto` helpers**, seller and buyer, once the facilitator settles `upto` (0015) and upstream
  has the scheme (0034). If either is late, this item waits and the rest ships.
- **Publish to npm**: the `@stellar-x402` scope's owner, the version policy, a release step in CI,
  and what the guide (0075) tells a developer to install. With the Rust crate's release (0140).

## Acceptance Criteria

- [ ] Each item above is built, or the owner has dropped it in writing with the reason
- [ ] `@stellar-x402/sdk` installs from npm, and the guide names it
- [ ] Given a listing the catalog would refuse, when a seller runs `validateListing`, then it gets
      the catalog's reason before any payment, and a test covers it
