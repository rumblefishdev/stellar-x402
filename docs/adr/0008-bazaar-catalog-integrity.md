# ADR 0008: Bazaar foundation: catalog after settle, validated and SSRF-safe

- Status: accepted
- Date: 2026-10-07, amended 2026-10-20 (task 0032: the `scheme` filter), 2026-10-22 (task 0053:
  resource URLs and empty fields) and 2026-10-26 (task 0054: resource hosts)

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
  - An empty `description` or `mimeType` counts as absent: upstream's resource server sends both
    as `|| ""` when a route sets none (task 0053).
- **SSRF safety.**
  - `iconUrl` must be absolute https, with no IP literals and no loopback, private or special-use
    hosts.
  - The facilitator never fetches any seller-supplied URL in Tranche 1.
  - Resource URLs carry a scheme allowlist by listing type (task 0053): an `http` listing takes
    `https` and `http`, an `mcp` listing also `mcp` (`@x402/mcp`'s `mcp://tool/<name>`). An `mcp:`
    host must be a DNS-style name (letters, digits, hyphens; labels up to 63 characters, the host
    up to 253), so `mcp://127.0.0.1/x` passes and `mcp://[::1]/x`, `mcp://my_srv/x` and non-ASCII
    hosts don't. A host ending in a dot is refused on every scheme.
  - On every network, a listed resource URL must be `http(s)` with a public host (task 0054).
    Refused as `resource_not_public`, a reason of its own, since the URL is well formed and its
    payment settles: IP literals (public ones too, in every spelling WHATWG folds into one),
    loopback, private and special-use names (`localhost`, `localdomain`, `local`, `internal`,
    `home.arpa`, `invalid`, `test`, `example`, `alt`, `onion` and their subdomains),
    single-label names, and `mcp:` URLs. It is the `iconUrl` host rule, run on the canonical URL.
    `http` with a public name stays listable. The payment settles as usual: only the listing is
    dropped, and the seller sees `rejected` in the header.
  - `CATALOG_LIST_LOCAL=true`, allowed on testnet only, lists such URLs too: for a facilitator
    run locally and the e2e gate. It opens hosts and `mcp:` URLs, not schemes.
- **Catalog key.**
  - The key is `network + payTo + method + normalized resource URL` (with `routeTemplate`
    applied). An `mcp:` URL is normalized by hand: lowercased host, `/` for an empty path, no
    query or fragment (its WHATWG origin is `"null"`).
  - `http` and `https` copies of one resource are two keys, and two MCP servers of one `payTo`
    that both name a tool `mcp://tool/<name>` share one. Both are accepted for Tranche 1.
  - Upserts are idempotent and update `lastUpdated`.
- **Settle response.**
  - Only the pure, synchronous validation runs before the settle response.
  - It sets a best-effort `EXTENSION-RESPONSES` header (`processing` or `rejected`).
  - The store write runs after the response, fire-and-forget. Its errors are logged and counted.
  - The header never changes the response body or status.
- **`GET /discovery/resources`.**
  - It uses the upstream discovery list types.
  - Filters: `type`, `payTo`, `network`, `extensions`, `limit` (bounded, with a fixed default),
    `offset`, and upstream's `scheme`, which T1 answers from the schemes it settles (task 0032).
  - No ranking in Tranche 1.

## Rationale

- **The trigger ties listings to real payments.** Every listing is backed by a settled payment,
  which is the catalog's trust anchor; curation and ranking come in Tranche 2.
- **Upstream types keep us interoperable** with the x402 discovery ecosystem, and avoid a
  parallel schema.
- **Never fetching seller URLs removes SSRF** as a class in Tranche 1, not just in `iconUrl`.
- **SSRF is checked where a URL is fetched.** A rule on the URL text can't stop a public name that
  resolves to `127.0.0.1` (OWASP: check the resolved address at connection time), which is what
  `packages/mcp` does before every call. On resource URLs the host rules only refused what
  upstream servers send by default (`http://localhost:<port>`, the e2e suite, local sellers). The
  scheme allowlist stays, since a catalog rendered as links would run `javascript:`. `iconUrl`
  keeps its host rules: a browser fetches an icon as soon as the catalog is shown.
- **The catalog lists only what a buyer can reach** (task 0054). This is listing quality, not
  SSRF: a public name that resolves to `127.0.0.1` is still listed, and its fetcher checks the
  address.
  - A loopback, private or IP resource URL names a machine no buyer can reach, or one that differs
    per buyer, and an `mcp://tool/<name>` URL names a tool, not a server. In a public catalog
    such entries are noise, and they publish internal host names.
  - No public catalog lists one. Measured 2026-10-26 across about 98,800 entries: CDP, PayAI and
    OpenX402 list none on mainnet or testnet, and no `mcp://` URL either. CDP asks sellers for "a
    public HTTPS URL". The MCP registry refuses `localhost`, `127.0.0.1` and `*.localhost`
    remotes.
  - Testnet refuses them too (team decision, 2026-10-26): sellers test against `localhost` on
    testnet, so a testnet-only exception would put exactly those entries into our public testnet
    catalog, which demos, our MCP server and reviewers read. The seller still pays, and the
    header tells it why nothing was listed.
  - A facilitator run locally can list them with `CATALOG_LIST_LOCAL`, and so can the e2e gate,
    whose upstream Bazaar check expects `http://localhost:<port>` and `mcp://tool/<name>` (task
    0028 turns it on with `/discovery/search`). The switch is config, not the payload, so no client
    can turn it on, and the config refuses it on pubnet.
  - The rule sits in the pure validator, which both the header and the store write call, so the
    two agree. Its reason is `resource_not_public`, not `invalid_resource_url`: the URL is not
    wrong and the payment went through, so a seller reading the header must not take it for a
    failed request. A malformed URL is still `invalid_resource_url`, checked first.
  - Plain `http` with a public name is still listed: a seller behind a TLS proxy without
    `trust proxy` sends it (task 0053), and PayAI lists such entries.
- **Validation before, storage after.** Reporting the validation result costs microseconds and
  can't fail a payment. Waiting for the store write could.

## Alternatives considered

- **Omit the `EXTENSION-RESPONSES` header in Tranche 1.** Simpler, but leaves an RFP item open.
  Rejected.
- **Catalog inside the settle request.** The catalog would always be consistent, but a Bazaar bug
  could fail or delay payments. Rejected.
- **Fetch and check seller URLs (health, icons).** SSRF exposure and outbound traffic we don't
  need yet. Deferred.
- **Refuse such resource URLs on pubnet only, list them on testnet** (task 0054). No config, and
  the e2e gate lists as is, but local tests would fill our public testnet catalog. Rejected.
- **Store such entries and hide them from `/discovery/resources`.** Rows nobody reads, counted by
  every page, and a non-standard parameter to show them. Rejected.

## Consequences

- Anyone who settles a real payment, even a tiny one, can create a listing. That is accepted for
  Tranche 1, and quality is handled by curation and ranking later.
- The same holds for an existing listing: a newer settlement to the same `payTo` and resource
  URL replaces its text and same-asset price, whoever paid. Accepted on testnet; task 0063
  decides it before pubnet.
- Loopback, private and IP resource URLs are listed nowhere unless `CATALOG_LIST_LOCAL` is set
  (task 0054), so gate runs leave none in a catalog without the switch.
- A seller testing a localhost route against our facilitator pays as usual and gets
  `rejected` / `resource_not_public` in `EXTENSION-RESPONSES`, next to a successful settle
  response; the buyer sees nothing of it.
- An MCP seller must set a real https URL (`@x402/mcp`'s `config.resource.url`) to be listed: the
  default `mcp://tool/<name>` is refused.
- The e2e gate's Bazaar check needs `CATALOG_LIST_LOCAL=true` once task 0028 turns it on.
- A name that resolves to loopback (`localtest.me`, `*.nip.io`) is still listed. The
  catalog never resolves names; a client that calls the URL checks the address.
- A client that calls catalog URLs must check the address it connects to.
- The store (task 0013) must enforce the catalog key and support the `resources` filters.
- The e2e gate routes carry the `bazaar` extension, so a gate run also exercises cataloging.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-8, AD-19, AD-20
- [RFP 7](../rfp/07-x402-facilitator-bazaar.md),
  [RFP technical architecture §4](../rfp/x402-facilitator-bazaar-technical-architecture.md)
