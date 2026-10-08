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
    who: claude
    note: "Created by 0012 from M1 Story 4.1 (Discovery lane)."
  - date: "2026-10-08"
    status: active
    who: Adam Kot
    note: >
      Started by the Discovery lane. Added the upstream helpers to wrap, the dependency on the
      0017 CatalogStore types, and open questions on the catalog key and rejection reasons.
  - date: "2026-10-08"
    status: active
    who: akot
    note: >
      Research session (no code): bmad-deep-recon, a spike against @x402/extensions 2.28.0,
      party mode and red team / pre-mortem. Converted to a directory with notes R- and G-.
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

## Open Questions

**Status: proposed — to confirm in the day-1 review** with Payments (0017) and the 0031 owner.
Evidence for each answer is in the [R note](notes/R-bazaar-validation-landscape.md); the full
contract is in the [G note](notes/G-day1-contract-and-tests.md).

- **URL normalization in the key.** Proposed: WHATWG parse; https only; reject userinfo, IP
  literals, `localhost` / `*.localhost` and trailing-dot hosts; drop the default port, query and
  fragment; resolve dot segments and normalize percent-encoding (RFC 3986 §6.2.2); **keep** path
  case and the trailing slash (RFC 9110: only scheme and host are case-insensitive; merging
  distinct resources is worse than a duplicate). Changed from the earlier bracketed proposal.
- **MCP entries.** Proposed: key `(network, payTo, method = toolName, canonical URL)`, as the spec
  requires (`resource.url` + `toolName`) and PR #7 encodes; `routeTemplate` ignored for MCP.
- **Template mismatch.** Proposed: the template must match the concrete path segment by segment,
  have at least one static segment and pass a stricter grammar; otherwise it is discarded and the
  concrete path is used, as the spec says, and counted in metrics. Parameter names are erased in
  the key. Open: CDP rejects instead; we follow the spec unless the review prefers rejecting.
- **Reason codes.** Proposed closed set, sent as the value of the spec's `rejectedReason`:
  `invalid_extension`, `invalid_info`, `invalid_resource_url`, `too_large`, `schema_too_complex`,
  `unsupported_version`, `internal_error`. Needs PR #7's `reason` renamed to `rejectedReason`.
- **Size limits.** Proposed: extension ≤ 32 KiB, description ≤ 500 chars (CDP parity, rejects the
  listing, never the payment), schema depth ≤ 10 and ≤ 1,000 nodes, `routeTemplate` ≤ 256,
  `toolName` ≤ 128, URL ≤ 2048.
- **x402 v1 payloads.** Proposed: catalog v2 only (the spec does not expect v1); anything else is
  `unsupported_version`.
- **New, from the red team: provenance.** Anyone can settle a payment to a victim's `payTo` in a
  worthless self-issued token and overwrite the victim's listing. Proposed: catalog only
  settlements in eligible assets above a minimum amount. Decision needed; touches ADR 0008 and
  0031, not this package.

## Acceptance Criteria

- [ ] Given an `extensions.bazaar` block with an `http` or `mcp` input type, when it is validated, then a valid block becomes a normalized entry typed with `@x402/extensions`
- [ ] Given a malformed required field, when it is validated, then the listing is rejected with a reason; a malformed optional field (`serviceName`, `tags`, `iconUrl`) is dropped and the listing kept
- [ ] Given an `iconUrl`, when it is validated, then it is kept only if it is absolute https with no IP literal and no loopback or private host
- [ ] Given calls to `/users/42` and `/users/7` with `routeTemplate` `/users/:userId`, when their catalog keys are computed, then both produce one key: `network + payTo + method + normalized URL`; `packages/bazaar` does no I/O and reads no env, and is fully unit-tested
- [ ] Given the upstream helpers, when the package is reviewed, then validation and sanitizing call `@x402/extensions` instead of reimplementing its rules
- [ ] Given a rejected listing, when the result is returned, then it carries a reason code from the fixed set that 0031 uses
- [ ] Given a payload whose JSON Schema exceeds our size, depth or node-count caps, when it is validated, then the result is `schema_too_complex` and the schema is never compiled in-process
