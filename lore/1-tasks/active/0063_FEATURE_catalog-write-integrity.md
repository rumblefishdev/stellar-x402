---
id: "0063"
title: "Keep catalog listings from being overwritten or padded before pubnet"
type: FEATURE
status: active
milestone: 1
related_adr: ["0008"]
related_tasks: ["0032", "0054", "0023", "0015", "0068", "0069", "0070", "0075"]
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
  - date: "2026-10-27"
    status: backlog
    who: karolkow
    note: >
      Grilled after a testnet run of both attacks: listing content comes from the seller's own
      402, field limits on offers. Decisions recorded below; 0070 spawned.
  - date: "2026-10-27"
    status: active
    who: karolkow
    note: >
      Work starts.
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
- Not here: loopback, private and IP resource URLs, refused on every network since 0054; rate
  limits (0023).

- Measured on testnet (2026-10-26, develop `8a96736`, real settlements): an outsider's 1-stroop
  settle to the seller's `payTo` and URL replaced the description and the 10000-stroop price with
  its own (`processing` header, the facilitator paid the ~10,550-stroop fee); four more 1-unit
  settles in self-deployed tokens grew `accepts` to 5; 100 entries with a ~63 KB `extra` made a
  6.4 MB page, and 20 concurrent page reads raised `/supported` p95 from 6 to 68 ms.
- Measured on the largest public x402 catalog (5,000 of 74,883 entries, 50 evenly spaced pages): per
  listing key at most 4 offers; no `extra` over 1.9 KB; 2% of offers carry fields outside the
  spec's seven, mostly x402 v1 names. 56 of 60 sampled sellers (one per host) answer an unpaid
  request with a usable 402: 53 with an empty body, the rest only with the listing's example.
- The spec says nothing on who may change a listing (`specs/extensions/bazaar.md`); upstream
  issue x402-foundation/x402#3005 is open on it.

## Decisions so far

| # | What is done | From | Vs the task | Who does the same (checked) | Code | Test |
|---|---|---|---|---|---|---|
| 1 | A listing's content comes from the seller's own unpaid 402 (an MCP server's `PaymentRequired`), never from the payment. A successful settle carrying `extensions.bazaar` only triggers the check | grilling | changes it (the task listed a seller signature or first write wins) | spec silent; upstream issue #3005 open | | |
| 2 | The check runs only when a settle's echoed content differs from the stored listing, or no listing exists, and at most once per minute per listing key: buyers echo the seller's 402, so an unchanged listing costs no request | grilling | beyond it | spec silent | | |
| 3 | At most 30 checks per minute per host, plus a global budget; a check over budget is skipped with a log line, and the next payment tries again. Both numbers are assumptions | grilling | beyond it | spec silent | | |
| 4 | The check uses the listing's method and sends the listing's example input up to 16 KiB, as the MCP check does (row 5): `bazaar.info.input.queryParams` as the query, `body` as a POST body; without an example a POST sends `{}` and a GET no query. An unpaid request is answered with a 402 before the route runs, so the example's origin (the payment's echo) is not trusted with anything | grilling | changes it (the first round sent no parameters, so a route that needs one answered 400) | `bazaar.md` Input Types (`queryParams`, `body`) | | |
| 5 | An `https` MCP listing is checked with an MCP client: `initialize`, then `tools/call` without payment, with the payment's example arguments up to 16 KiB, since the MCP SDK validates arguments before the tool's handler (`server/mcp.js:125`, SDK 1.30.1). Upstream's wrapper answers `PaymentRequired` before the tool runs (`@x402/mcp` `paymentWrapper.ts:276-284`). Own PR | grilling | beyond it | upstream `@x402/mcp` | | |
| 6 | No usable answer (loopback or private host, `mcp://tool/…` without a server address, not a 402, no offer with the key's network and `payTo`, timeout): a new listing isn't created, an existing one stays as it was; a log line and a counter carry the reason | grilling | beyond it | RFC 8555 §10 (validate over the public internet only) | | |
| 7 | Only the seller's offers with the listing key's network and `payTo` are stored, and a check replaces `accepts` instead of merging into the stored one | grilling | beyond it | spec silent | | |
| 8 | An offer keeps only the spec's seven fields; the count of dropped fields is logged | grilling | matches it | x402 v2 §5.1.2; upstream `core/src/schemas/index.ts:160` | | |
| 9 | `extra` up to 4 KiB per offer, at most 8 offers per listing (twice the largest measured: 1,846 B and 4); the `bazaar` block keeps its 32 KiB. Over a limit the whole listing is refused as `too_large` with the field named in the log, and the payment never is | grilling | matches it | spec silent on these fields; its soft drop covers only `serviceName`, `tags`, `iconUrl` (`bazaar.md:380-391`) | | |
| 10 | Two checks of one key at once: the result of the one that started later is kept | agent | beyond it | — | | |
| 11 | `lastUpdated` is the time of the last confirmation from the seller | agent | beyond it | x402 v2 §8.3 names the field only | | |
| 12 | One counter by outcome: refreshed, not askable (with the reason), over budget, other `payTo`, too large | agent | beyond it | — | | |
| 13 | The URL guard moves from `packages/mcp` to a shared package in a `[structure only]` PR; its `allowInsecureLocal` switch is off by default, refused on pubnet, and on only in tests and local gate runs | grilling | beyond it | RFC 8555 §10 | | |
| 14 | ADR 0008's "the facilitator never fetches any seller-supplied URL" is replaced by these rules | agent | matches it | — | | |
| 15 | No stored listings to migrate: the facilitator isn't deployed yet | grilling | beyond it | — | | |
| 16 | `/settle` keeps accepting a payload whose `accepted` differs from `paymentRequirements`: no facilitator code reads `accepted`, and the signed transaction is checked against the requirements (`settle.ts:931`) | grilling | beyond it | upstream checks it in the resource server (`x402ResourceServer.ts:2127`) | | |
| 17 | A listing enters only through a settled payment, the seller's own first paid call included; there is no registration endpoint. A seller helper that makes that call is 0075 | grilling | matches it | RFP 07 "automatic cataloging"; architecture §2 "not a separate registration process"; `bazaar.md` Facilitator Behavior | | |
| 18 | An MCP check calls `tools/list` before the unpaid `tools/call`, so a missing tool is told apart from a server that is down | agent | beyond it | MCP spec `tools/list` | | |
| 19 | Offers stay in the listing's `jsonb`, checked against the upstream `PaymentRequirements` schema in the one function that writes the catalog (`upsertCatalog`); no typed offers table, so a new spec field needs a library bump, not a migration | grilling | beyond it | spec silent on storage (`bazaar.md:429`); upstream `core/src/schemas/index.ts:160` | | |
| 20 | A check that got no usable answer is not queued for a retry: the next payment tries again, and the seller helper (0075) tells the seller whether the listing appeared. The check runs right after the seller served a buyer, and the failures left (a route that needs other input, an over-budget host, a URL that isn't the seller's) don't pass with time | grilling | beyond it | spec silent | | |
| 21 | No cap on new listings per `payTo` or overall, and a seller paying itself is allowed. Each new listing still needs a settled on-chain payment whose fee the facilitator pays, `/settle`'s per-IP limit (0023) and the per-host check budget (row 3) | grilling | beyond it | spec silent | | |

## Not yet decided

- The measured cause of the `500` answers under 20 concurrent `/discovery/resources` reads
  (hypothesis: the database pool); its own task once measured.

## PR split

After the guard's error type (#71) and move (#72): one PR for listings from the seller's page
(field limits, HTTP check, ADR 0008), then one for MCP listings.

## Out of scope

- A "verified" badge for sellers who prove their `payTo` with `stellar.toml`: 0070.
- Listings whose seller stopped answering: 0069. The buyer's MCP refusing a price above the
  listing: 0068. Pubnet host rules at validation: 0054.

## Acceptance Criteria

- [ ] Decided and written into ADR 0008: who may change an existing listing, and the entry size
      limits
- [ ] Given an entry written by one settlement, when a settlement by another payer to the same
      key arrives, then it can't replace the entry's text or an existing price unless the
      decision above allows it
- [ ] Given a requirement with unknown fields or an oversized `extra`, when it is cataloged, then
      the stored entry stays within the decided limit
