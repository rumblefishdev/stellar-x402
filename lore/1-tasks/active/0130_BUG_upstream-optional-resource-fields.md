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
- The buyer's HTTP client is not affected: `@x402/fetch` and `decodePaymentRequiredHeader` never run the
  schema (checked in `@x402/core` 2.28.0, `dist/cjs/http/index.js:1846-1851`), so our pay tool
  pays such a seller. Upstream's own `x402MCPClient` does run it
  (`typescript/packages/mcp/src/client/x402MCPClient.ts:967-991`) and then takes the paid tool for
  a free one.
- Related upstream PR #3049 (open, spec only): metadata problems must not block payment.
- Related, not the same: upstream issue #2993 (a hosted facilitator rejects a too-long
  `description`).

## Premise

Attacked by a fresh reviewer on 2026-11-10. The problem is real, and it reaches our money path:

- Our facilitator's `/verify` and `/settle` run `PaymentPayloadV2Schema` on the payment
  (`apps/facilitator/src/http/app.ts:137`), and upstream's client copies the 402's resource into
  the payment (`@x402/core` 2.28.0 `dist/esm/client/index.mjs:304`). Measured: a payload whose
  resource has 5 tags parses, one with 6 tags does not, so such a payment is answered 400.
- The seller check's workaround removes the three fields before the parse, so it also lets a
  wrong-typed field through (`tags: "x"`); the upstream fix keeps the type check. After the bump
  such a 402 is refused where it passes today.
- A cheaper route to consider: a local patch of `@x402/core` with the upstream diff, which fixes
  all three places at once until the release.

## Decisions so far

| # | What is done | From | vs the task | Who does the same (checked) | Code | Test |
|---|---|---|---|---|---|---|
| 1 | Fix it in upstream `@x402/core`, not only in our code; our cleanup follows the release | grilling 2026-11-10 | matches | upstream Python `payments.py:38-40` and Go `v2.go:146-148` already accept these fields | — | — |
| 2 | The fix types `serviceName`, `tags` and `iconUrl` only; the Bazaar rules stay in extraction, so 6 tags become the first 5 in the catalog | grilling 2026-11-10 | changes it (the task said drop a bad field to undefined, which loses all 6 tags against `bazaar.md:390`) | upstream Python and Go type these fields only | upstream `core/src/schemas/index.ts` | upstream `core/test/unit/schemas/schemas.test.ts` |
| 3 | The upstream PR carries the core schema test only, no test of upstream's MCP client | grilling 2026-11-10 | matches | — | — | — |
| 4 | The upstream PR leaves the generated paywall bundles as they are; maintainers regenerate them with `pnpm build:paywall` if they want | grilling 2026-11-10 | beyond it | upstream #2774, #3285 and #3983 changed this schema without regenerating them | — | — |
| 5 | Until the release, our preview tool reads such a 402 too and shows the agent every field the seller sent (bounded by the 16 KiB header, as 0037 set); one shared workaround in `packages/bazaar` serves the seller check and the preview | grilling 2026-11-10 | beyond it | our seller check already does this | `packages/bazaar`, `apps/facilitator/src/catalog/seller-check.ts`, `packages/mcp/src/preview.ts` | `packages/mcp/test/pay.test.ts` |
| 6 | Until the release, a local `pnpm patch` of `@x402/core` 2.28.0 carries the upstream diff, so `/verify`, `/settle`, the preview tool and the seller check all read such a payment or 402; the seller check's workaround goes now. Replaces row 5's workaround | grilling 2026-11-10 | beyond it | none of the checked facilitators patches `@x402/core` | `patches/`, `pnpm-workspace.yaml`, `apps/facilitator/src/catalog/seller-check.ts` | `apps/facilitator/test`, `packages/mcp/test/pay.test.ts` |

## Not yet decided

Nothing.

## Upstream PR

- PR: not opened yet. Write its URL here when it is opened.
- Released in `@x402/core`: not yet. Write the version here.

## After the upstream PR merges and is released

1. Remove the `@x402/core` patch (`patches/` and its `pnpm-workspace.yaml` entry) and bump
   `@x402/core` to the release that carries the fix in `apps/facilitator`, `packages/bazaar` and
   `packages/mcp` (today `~2.28.0`; latest 2.30.0).
2. Keep the tests that a payment and a 402 with 6 tags are read; they must stay green after the
   bump.

## Acceptance Criteria

- [ ] The upstream PR is opened, with its URL in this file.
- [ ] Until the release: `@x402/core` patched; `/verify` accepts a payment whose resource has 6
      tags, the preview tool shows a 402 with 6 tags, the seller check's workaround is gone.
- [ ] The upstream PR is merged and released; the version is in this file.
- [ ] After the release: the patch removed, `@x402/core` bumped in all three packages, tests green.
