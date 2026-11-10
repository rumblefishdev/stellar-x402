---
id: "0130"
title: "Upstream fix: @x402/core refuses a whole 402 for one bad optional resource field"
type: BUG
status: active
related_adr: []
related_tasks: ["0053"]
tags: [upstream, bazaar, mcp, priority-medium, effort-small]
links:
  - https://github.com/x402-foundation/x402/issues/2993
history:
  - date: "2026-11-10"
    status: active
    who: karolkow
    note: >
      Created and started: fix it upstream, since the source fix is smaller than our workaround
      plus a second one in the MCP server. The upstream PR is not opened yet.
---

# Upstream fix: @x402/core refuses a whole 402 for one bad optional resource field

## Summary

`@x402/core`'s `ResourceInfoSchema` validates `serviceName`, `tags` and `iconUrl` strictly, so one
over-long optional field makes the whole `PaymentRequired` (and `PaymentPayload`) fail to parse.
The Bazaar spec says to drop only that field. This task sends the fix upstream and, once it is
released, removes our workaround and proves our MCP server can pay such a seller.

## Context

- Upstream code, at `main` ff58685 (2026-11-10):
  `typescript/packages/core/src/schemas/index.ts:68-95` (`ResourceInfoSchema`): `serviceName` 1–32
  printable ASCII, `tags` at most 5 items of 1–32 printable ASCII, `iconUrl` at most 2048 chars.
- Spec: `specs/extensions/bazaar.md:378-391` (soft-drop rules, "A field that fails its rule is
  discarded; the surrounding metadata is preserved") and `:414-415` ("Hard rejection only happens
  at the JSON envelope level").
- Upstream's Python (`python/x402/schemas/payments.py:38-40`) and Go (`go/types/v2.go:146-148`)
  types accept any string or string list there; only the TypeScript schema refuses.
- Effect for us: 47 of 400 live sellers in a public Bazaar catalog had such a field (measured
  2026-10-28, see `apps/facilitator/test/cataloger.test.ts:140`). Our catalog works around it in
  `apps/facilitator/src/catalog/seller-check.ts` (`shapeError`). Our MCP server's preview tool
  (`packages/mcp/src/preview.ts:70`) still answers `unsupported_payment` for such a seller.
- Paying over HTTP is not affected: `@x402/fetch` and `decodePaymentRequiredHeader` never run the
  schema (checked in `@x402/core` 2.28.0, `dist/cjs/http/index.js:1846-1851`), so our pay tool
  pays such a seller. Upstream's own `x402MCPClient` does run it
  (`typescript/packages/mcp/src/client/x402MCPClient.ts:967-991`) and then takes the paid tool for
  a free one.
- Related upstream PR #3049 (open, spec only): metadata problems must not block payment.
- Related, not the same: upstream issue #2993 (a hosted facilitator rejects a too-long
  `description`).

## Decisions so far

| # | What is done | From | vs the task | Who does the same (checked) | Code | Test |
|---|---|---|---|---|---|---|
| 1 | Fix it in upstream `@x402/core`, not only in our code; our cleanup follows the release | grilling 2026-11-10 | matches | upstream Python `payments.py:38-40` and Go `v2.go:146-148` already accept these fields | — | — |
| 2 | The fix types `serviceName`, `tags` and `iconUrl` only; the Bazaar rules stay in extraction, so 6 tags become the first 5 in the catalog | grilling 2026-11-10 | changes it (the task said drop a bad field to undefined, which loses all 6 tags against `bazaar.md:390`) | upstream Python and Go type these fields only | upstream `core/src/schemas/index.ts` | upstream `core/test/unit/schemas/schemas.test.ts` |
| 3 | The upstream PR carries the core schema test only, no test of upstream's MCP client | grilling 2026-11-10 | matches | — | — | — |

## Not yet decided

- Whether our preview tool gets a workaround while the upstream PR waits.
- Whether the upstream PR regenerates the paywall bundles.

## Upstream PR

- PR: not opened yet. Write its URL here when it is opened.
- Released in `@x402/core`: not yet. Write the version here.

## After the upstream PR merges and is released

1. Bump `@x402/core` to the release that carries the fix (today we pin `~2.28.0` in
   `apps/facilitator`, `packages/bazaar` and `packages/mcp`; latest is 2.30.0).
2. Delete `shapeError` in `apps/facilitator/src/catalog/seller-check.ts` (the function and its two
   calls), and parse with `PaymentRequiredV2Schema` directly.
3. Adjust `apps/facilitator/test/cataloger.test.ts:140` if its comment or assertion names the
   workaround.
4. Add a test in `packages/mcp/test/pay.test.ts` (its preview cases): a fake seller whose 402
   carries 6 tags gets its terms previewed, not refused with `unsupported_payment`.

## Acceptance Criteria

- [ ] The upstream PR is opened, with its URL in this file.
- [ ] The upstream PR is merged and released; the version is in this file.
- [ ] `@x402/core` bumped in all three packages.
- [ ] `shapeError` and its calls removed; catalog tests green.
- [ ] MCP test: a seller with 6 tags is previewed.
