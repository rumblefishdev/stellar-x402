# ADR 0008: Bazaar foundation: catalog after settle, validated and SSRF-safe

- Status: accepted
- Date: 2026-10-07

## Context

The Tranche 1 Bazaar foundation covers the `resources` endpoint and the cataloging pipeline, with
no ranking yet. The RFP and its technical architecture ask for:

- cataloging when a settled payment carries the discovery extension;
- soft-drop validation;
- `routeTemplate` normalization;
- an SSRF-safe `iconUrl`;
- cataloging outcomes in an `EXTENSION-RESPONSES` header;
- HTTP and MCP resource entries.

[ADR 0004](0004-facilitator-shape.md) also requires that cataloging never blocks or changes a
settlement.

## Decision

- **Trigger.**
  - A resource is cataloged only when its settlement reaches `success` and the client's payload
    carries `extensions.bazaar`.
  - Late successes count: a `resolved` event that finalizes a pending settlement as `success`
    triggers cataloging too.
  - Nothing else is indexed.
- **Validation.**
  - Types come from `@x402/extensions` (bazaar). `packages/bazaar` holds only a pure validator
    and normalizer.
  - Both `http` and `mcp` input types are accepted.
  - Malformed required fields reject the listing. Malformed optional fields (`serviceName`,
    `tags`, `iconUrl`) are dropped.
- **SSRF safety.**
  - `iconUrl` must be absolute https, with no IP literals and no loopback or private hosts.
  - The facilitator never fetches any seller-supplied URL in Tranche 1.
- **Catalog key.**
  - The key is `network + payTo + method + normalized resource URL` (with `routeTemplate`
    applied).
  - Upserts are idempotent and update `lastUpdated`.
- **Settle response.**
  - Only the pure, synchronous validation runs before the settle response.
  - It sets a best-effort `EXTENSION-RESPONSES` header (`processing` or `rejected`).
  - The store write runs after the response, fire-and-forget. Its errors are logged and counted.
  - The header never changes the response body or status.
- **`GET /discovery/resources`.**
  - It uses the upstream discovery list types.
  - Filters: `type`, `payTo`, `network`, `extensions`, `limit` (bounded, with a fixed default),
    `offset`.
  - No ranking in Tranche 1.

## Rationale

- **The trigger ties listings to real payments.** Every listing is backed by a settled payment,
  which is the catalog's trust anchor; curation and ranking come in Tranche 2.
- **Upstream types keep us interoperable** with the x402 discovery ecosystem, and avoid a
  parallel schema.
- **Never fetching seller URLs removes SSRF** as a class in Tranche 1, not just in `iconUrl`.
- **Validation before, storage after.** Reporting the validation result costs microseconds and
  can't fail a payment. Waiting for the store write could.

## Alternatives considered

- **Omit the `EXTENSION-RESPONSES` header in Tranche 1.** Simpler, but leaves an RFP item open.
  Rejected.
- **Catalog inside the settle request.** The catalog would always be consistent, but a Bazaar bug
  could fail or delay payments. Rejected.
- **Fetch and check seller URLs (health, icons).** SSRF exposure and outbound traffic we don't
  need yet. Deferred.

## Consequences

- Anyone who settles a real payment, even a tiny one, can create a listing. That is accepted for
  Tranche 1, and quality is handled by curation and ranking later.
- The store (task 0013) must enforce the catalog key and support the `resources` filters.
- The e2e gate routes carry the `bazaar` extension, so a gate run also exercises cataloging.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-8, AD-19, AD-20
- [RFP 7](../rfp/07-x402-facilitator-bazaar.md),
  [RFP technical architecture §4](../rfp/x402-facilitator-bazaar-technical-architecture.md)
