---
id: "0030"
title: "Bazaar validator and normalizer"
type: FEATURE
status: active
milestone: 1
related_adr: ["0008"]
related_tasks: ["0012", "0017", "0016", "0031"]
tags: [bazaar, security, priority-high, effort-small, discovery]
links:
  - ../../../../docs/planning/m1-epics.md
  - ../../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: akot
    note: "Created by 0012 from M1 Story 4.1 (Discovery lane)."
  - date: "2026-10-08"
    status: active
    who: akot
    note: >
      Started by the Discovery lane. Added the upstream helpers to wrap, the dependency on the
      0017 CatalogStore types, and open questions on the catalog key and rejection reasons.
  - date: "2026-10-08"
    status: active
    who: akot
    note: >
      Research session (no code): spike against @x402/extensions 2.28.0, red team /
      pre-mortem. Converted to a directory with notes R- and G-.
      Open questions now carry proposed answers; added an AC on bounded schema handling.
---

# Bazaar validator and normalizer

## Summary

As an agent looking for paid services, I want only well-formed, safe listings to reach the catalog, so that I can trust what discovery returns.

**Story:** [M1 Story 4.1](../../../../docs/planning/m1-epics.md#story-41-bazaar-validator-and-normalizer) · **Lane:** Discovery · **Covers:** FR16 (AD-19)

## Context

- Pure library with no dependencies on the facilitator, so it can start on day 1.
- Types come from `@x402/extensions`; no parallel schema (ADR 0008).
- **Upstream already ships the parsing and soft-drop rules.** `@x402/extensions/bazaar` exports
  `extractDiscoveryInfo`, `validateDiscoveryExtensionSpec`, `sanitizeResourceServiceMetadata`
  (soft-drop of `serviceName`, `tags`, `iconUrl`), `isValidIconUrl` and `isValidRouteTemplate`.
  This task wraps them and adds what upstream lacks: the catalog key, the template-to-URL check,
  limits and reason codes. Reimplementing them would be the parallel schema ADR 0008 forbids.
- **We never compile a seller-supplied schema in-process.** We validate `info` against a trusted
  shape and cap `schema` by size, depth and node count. (Security rationale is in a private note,
  not committed, pending coordinated upstream disclosure — do not add those details here.)
- **Research:** [R-bazaar-validation-landscape](notes/R-bazaar-validation-landscape.md) (upstream,
  other catalogs, prior art, spike, red team) and
  [G-day1-contract-and-tests](notes/G-day1-contract-and-tests.md) (signatures, limits, test plan).
- **Version.** `packages/bazaar` pins `~2.27.0`; 0016 upgrades `@x402` to 2.28. The bazaar code is
  byte-identical in 2.27.0 and 2.28.0, so either works.
- **Output shape.** The normalized entry is what `CatalogStore` (0017 types PR) stores. Agree on
  it in the day-1 review, before coding the normalizer.
- **Consumer.** 0031 puts the rejection reason into the `EXTENSION-RESPONSES` header and metrics.

## Implementation

- `packages/bazaar`: `validate()` and `normalize()` plus the catalog-key function, built on the
  upstream helpers above.
- `payTo` and `network` for the key come from the verified `PaymentRequirements`, never from the
  client-echoed extension block.
- Unit tests for both input types, soft-drop cases, SSRF cases and route templates. Reuse the
  upstream test cases where they exist, so we stay in sync with the TS/Python/Go implementations.

## Decisions

Resolved for this package by the research session (2026-10-08). Evidence is in the
[R note](notes/R-bazaar-validation-landscape.md); the full contract is in the
[G note](notes/G-day1-contract-and-tests.md). Items that reach outside `packages/bazaar` are
listed separately below and stay open for the day-1 review.

### Settled for `packages/bazaar`

- **URL normalization in the key.** WHATWG parse; https only; reject userinfo, IP literals,
  `localhost` / `*.localhost` and trailing-dot hosts; drop the default port, query and fragment;
  resolve dot segments and normalize percent-encoding (RFC 3986 §6.2.2); **keep** path case and
  the trailing slash (RFC 9110: only scheme and host are case-insensitive; merging distinct
  resources is worse than a duplicate).
- **MCP entries.** Key `(network, payTo, method = toolName, canonical URL)`, as the spec requires
  (`resource.url` + `toolName`) and PR #7 encodes; `routeTemplate` ignored for MCP.
- **Template mismatch — spec fallback (decided).** The template must match the concrete path
  segment by segment, have at least one static segment and pass the stricter grammar; otherwise it
  is **discarded and the concrete path is used**, as the x402 spec mandates, and the fallback is
  counted as `route_template_ignored` in metrics. We chose this over CDP's reject-the-listing
  behaviour to stay interoperable with the ecosystem (ADR 0008); seller feedback on a dropped
  template is a follow-up (a dry-run validate endpoint, see Future Work).
- **Parameter names erased in the key (decided, red-team RT3).** `/users/:id` and `/users/:userId`
  produce one key; the original template is kept for display only. **Accepted limit:** erasure
  applies only to an accepted template, so `/users/42` without one (or with a discarded one) is a
  second key for the same resource. Bounded by the RT4 caps; RT5 auto-templating (Future Work)
  removes most of it.
- **Checks run on the raw payload before upstream extraction (decided).** `extractDiscoveryInfo`
  throws on a bad `resource.url` or missing `info.input` and returns `null` for several distinct
  cases, so presence, version, shape, URL and limits are checked first and it is called last. Its
  `resourceUrl` (`origin + routeTemplate`) is never stored. Order and codes are in the G note.
- **Reason codes.** Closed set, sent as the value of the spec's `rejectedReason`:
  `invalid_extension`, `invalid_info`, `invalid_resource_url`, `too_large`, `schema_too_complex`,
  `unsupported_version`, `internal_error`.
- **Size limits.** Extension ≤ 32 KiB and description ≤ 500 chars (`too_large`; CDP parity;
  rejects the listing, never the payment), schema depth ≤ 10 and ≤ 1,000 nodes
  (`schema_too_complex`), `toolName` ≤ 128 (`invalid_info`), URL ≤ 2048
  (`invalid_resource_url`). `routeTemplate` ≤ 256 is part of the template grammar: a longer one is
  discarded with the spec fallback, not rejected.
- **`http` requires `method` (decided).** Upstream allows it to be absent; we reject with
  `invalid_info` rather than default it.
- **Bounded schema handling (decided, red-team RT6).** The schema is walked **iteratively** for
  the caps above, so a deeply-nested payload cannot overflow our own stack, and it is never
  compiled in-process.
- **`keyVersion` on every entry (decided).** The normalized entry carries `keyVersion = 1`, so a
  later change to the normalization rules can be migrated rather than silently re-keying. (Storage
  of the field is 0022's concern.)
- **x402 v1 payloads.** Catalog v2 only (the spec does not expect v1); anything else is
  `unsupported_version`.

### To raise in the day-1 review (reach beyond `packages/bazaar`)

- **Rename `ExtensionResponses.reason` → `rejectedReason`**, typed as the closed reason set. Owner:
  0017 / PR #7.
- **Provenance — eligible assets + minimum amount (red-team RT1/RT2).** Anyone can settle a payment
  to a victim's `payTo` in a worthless self-issued token and overwrite their listing. Proposed:
  catalog only settlements in a configured eligible-asset set above a minimum amount. Owner: ADR
  0008 amendment + 0031. (Settlement itself stays allowlist-free per AD-9.)
- **Listing caps per `payTo` and per host (red-team RT4).** Bound catalog inflation from wildcard
  subdomains and per-ID paths. Owner: 0031 / 0022.

## Acceptance Criteria

- [ ] Given an `extensions.bazaar` block with an `http` or `mcp` input type, when it is validated, then a valid block becomes a normalized entry typed with `@x402/extensions`
- [ ] Given a malformed required field, when it is validated, then the listing is rejected with a reason; a malformed optional field (`serviceName`, `tags`, `iconUrl`) is dropped and the listing kept
- [ ] Given an `iconUrl`, when it is validated, then it is kept only if it is absolute https with no IP literal and no loopback or private host
- [ ] Given calls to `/users/42` and `/users/7` with `routeTemplate` `/users/:userId`, when their catalog keys are computed, then both produce one key: `network + payTo + method + normalized URL`; `packages/bazaar` does no I/O and reads no env, and is fully unit-tested
- [ ] Given the upstream helpers, when the package is reviewed, then validation and sanitizing call `@x402/extensions` instead of reimplementing its rules
- [ ] Given a rejected listing, when the result is returned, then it carries a reason code from the fixed set that 0031 uses
- [ ] Given a payload whose JSON Schema exceeds our size, depth or node-count caps, when it is validated, then the result is `schema_too_complex` and the schema is never compiled in-process

## Future Work

Out of scope for 0030; spawn as backlog tasks when 0030 ships.

- **Auto-template Stellar identifiers** (G…/M…/C… StrKeys, 64-hex tx hashes, UUIDs) when a seller
  gives no `routeTemplate`, so per-ID paths don't inflate the catalog (red-team RT5). CDP does this
  for EVM/Solana but not Stellar.
- **Dry-run validate endpoint** so a seller can check a listing (and see why a template was
  dropped) before paying — CDP offers `/x402/validate`.
