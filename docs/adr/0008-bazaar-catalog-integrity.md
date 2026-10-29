# ADR 0008: Bazaar foundation: catalog after settle, validated and SSRF-safe

- Status: accepted
- Date: 2026-10-07, amended 2026-10-20 (task 0032: the `scheme` filter), 2026-10-22 (task 0053:
  resource URLs and empty fields), 2026-10-26 (task 0054: resource hosts) and 2026-10-28 (task
  0063: listings from the seller's own 402, entry limits)

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
  - Nothing else is indexed, and there is no registration endpoint: a seller is listed after its
    first paid call, its own included (task 0063).
- **Who may change a listing (task 0063).**
  - A listing's content comes from the seller's own unpaid 402, never from the payment. A
    settlement's copy (the buyer's echo of that 402) only decides whether to ask the seller.
  - The seller is asked when the copy differs from the stored listing, or none exists, at most
    once a minute per listing key and 30 times a minute per host. No budget spans hosts, so one
    payer filling it holds back only the hosts it pays for; `/settle`'s per-IP limit (task 0023)
    and the settled payment each check needs bound the rest. Over a budget the check is
    skipped; the next payment tries again. There is no retry queue.
  - The request uses the listing's method and its example input up to 16 KiB: `queryParams` as
    the query, `body` as a JSON body (`{}` without one). Nothing proves before the request that
    the URL is an x402 seller, so a payer can have the facilitator send an unpaid request of any
    method to any public `https` URL, 30 a minute per host. It carries no credentials, so it can
    do only what the payer could do directly; what it adds is the facilitator's address as the
    sender. Real listings use `GET` and `POST` only (92,774 of 92,774 measured).
  - Only the seller's offers to the key's network and `payTo` are stored, and they replace the
    stored ones. A seller that answers with none of them, no listing, not a 402, or not within
    10 s, changes nothing: a new listing isn't created, an existing one stays.
  - Of two checks of one key, the result of the one that started later is kept. `lastUpdated`
    is the time of the seller's answer.
  - An `mcp` listing on a server URL is checked with an MCP client: `initialize`, `tools/list`,
    then the listing's tool called without payment with its example arguments up to 16 KiB (`{}`
    without one). Its terms are read from the error result's `structuredContent` or first text,
    as `@x402/mcp`'s payment wrapper sends them, and checked as an HTTP seller's are. A tool the
    server doesn't list (`no_tool`), a server that doesn't answer, and a tool that runs without
    asking for a payment (`not_402`) change nothing, as above. Its responses may take up to
    256 KiB each: a tool list carries every tool's schemas (largest measured 122,729 B).
- **Entry limits (task 0063).**
  - An offer keeps the spec's seven fields (the upstream `PaymentRequirements` schema); its
    `extra` takes up to 4 KiB. A listing keeps up to 8 offers. The `bazaar` block keeps its
    32 KiB.
  - Over a limit the whole listing is refused as `too_large`, the paid requirement's `extra`
    included; the payment never is.
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
  - The facilitator calls a seller URL only for the listing check above, through the
    `packages/seller-fetch` guard: https only, the address checked where it connects (no
    loopback, private or special-use address), no redirects, a 10 s deadline and a 64 KiB body
    cap. `CATALOG_LIST_LOCAL` also opens http to this machine.
  - Resource URLs carry a scheme allowlist by listing type (task 0053): an `http` listing takes
    `https` and `http`, an `mcp` listing also `mcp` (`@x402/mcp`'s `mcp://tool/<name>`). An `mcp:`
    host must be a DNS-style name (letters, digits, hyphens; labels up to 63 characters, the host
    up to 253), so `mcp://127.0.0.1/x` has a canonical form and `mcp://[::1]/x`, `mcp://my_srv/x`
    and non-ASCII hosts don't. A host ending in a dot is refused on every scheme. An `mcp:` URL is
    listed only with `CATALOG_LIST_LOCAL` (below).
  - On every network, a listed resource URL must be `http(s)` with a public host (task 0054).
    Refused as `resource_not_public`, a reason of its own, since the URL is well formed and its
    payment settles: IP literals (public ones too, in every spelling WHATWG folds into one),
    loopback, private and special-use names (`localhost`, `localdomain`, `local`, `internal`,
    `home.arpa`, `invalid`, `test`, `example`, `alt`, `onion`, the TLDs ICANN will never
    delegate, `home`, `corp` and `mail`, and their subdomains),
    single-label names, and `mcp:` URLs. It is the `iconUrl` host rule, run on the canonical URL.
    The payment settles as usual: only the listing is dropped, and the seller sees `rejected` in
    the header.
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
  - Only the pure, synchronous validation of the payment's copy runs before the settle response.
  - It sets a best-effort `EXTENSION-RESPONSES` header (`processing` or `rejected`).
  - The seller check and the store write run after the response, fire-and-forget. Their errors
    are logged and counted.
- **Listing attempts (task 0063).** Every attempt, accepted or not, is a row in
  `catalog_attempts`: who paid, the key and URL, where it ended (the payment's copy or the
  seller's 402), the outcome and reason, the size of a field over a limit and a content hash.
  Once the copy differs from the stored listing, the row also keeps the copy and the seller's
  402 as answered, so what a payer sent can be compared with what the seller says; a copy equal
  to the listing keeps none. Rows are pruned after 30 days.
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
- **Only the seller speaks for its listing** (task 0063). Before it, anyone who paid 1 stroop to
  a seller's `payTo` replaced that seller's description and price (measured on testnet), and a
  buyer that picks by `payTo` could be sent elsewhere. The spec says nothing on who may change a
  listing (x402-foundation/x402#3005 is open). A seller signature or "first write wins" needs a
  key or locks a seller out of its own listing; the seller's own 402 is what every buyer already
  trusts before it pays.
- **Asking only on a difference keeps the cost to new and changed listings.** Buyers echo the
  seller's 402, so an unchanged listing costs no request; the budgets bound what a flood of
  paid copies can make the facilitator send.
- **The check runs after the settle response** because the seller's middleware holds the
  buyer's answer until `/settle` returns (`@x402/express` 2.28.0). Payment latency comes first.
- **A whole listing is refused over a limit**, not trimmed: the spec's soft drop covers only
  `serviceName`, `tags` and `iconUrl`, and a listing missing an offer misleads a buyer. The limits
  are twice the largest measured in the largest public catalog (5,000 entries: `extra` at most
  1,846 B, at most 4 offers per listing key).
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
    a public Stellar catalog list none on mainnet or testnet, and no `mcp://` URL either. CDP asks sellers for "a
    public HTTPS URL". The MCP registry refuses `localhost`, `127.0.0.1` and `*.localhost`
    remotes.
  - Testnet refuses them too (team decision, 2026-10-26): sellers test against `localhost` on
    testnet, so a testnet-only exception would put exactly those entries into our public testnet
    catalog, which demos, our MCP server and reviewers read. The seller still pays, and the
    header tells it why nothing was listed.
  - A facilitator run locally can list them with `CATALOG_LIST_LOCAL`, and so can the e2e gate,
    whose upstream Bazaar check expects `http://localhost:<port>` and `mcp://tool/<name>`. That
    check waits for `/discovery/search` (after Tranche 1); task 0029 decides which facilitator the
    gate runs against. The switch is config, not the payload, so no client
    can turn it on, and the config refuses it on pubnet.
  - The rule sits in the pure validator, which both the header and the store write call, so the
    two agree. Its reason is `resource_not_public`, not `invalid_resource_url`: the URL is not
    wrong and the payment went through, so a seller reading the header must not take it for a
    failed request. A malformed URL is still `invalid_resource_url`, checked first.
  - Plain `http` with a public name passes the copy's validation, but the seller check calls
    `https` only (task 0063), so it is not listed: the seller's answer sets the listed price, and
    over `http` anyone on the path could change it. None of 92,774 real listings uses `http`.
- **Validation before, storage after.** Reporting the validation result costs microseconds and
  can't fail a payment. Waiting for the store write could.

## Alternatives considered

- **Omit the `EXTENSION-RESPONSES` header in Tranche 1.** Simpler, but leaves an RFP item open.
  Rejected.
- **Catalog inside the settle request.** The catalog would always be consistent, but a Bazaar bug
  could fail or delay payments. Rejected.
- **Fetch and check seller URLs for health or icons.** Outbound traffic we don't need yet.
  Deferred; the listing check fetches only the resource itself, unpaid.
- **Let the payment's copy write the listing** (before task 0063). Lets any payer rewrite another
  seller's listing. Rejected.
- **A seller signature, or the first write wins.** A key for every seller, or a seller locked out
  of its own listing. Rejected.
- **Merge offers into the stored ones.** Grows `accepts` by one entry per asset anyone pays in.
  Rejected: the seller's answer replaces them.
- **Wait for the seller check inside `/settle`.** The buyer would wait for it. Rejected.
- **A retry queue for failed checks, and caps on new listings per `payTo`.** The next payment
  retries, and every listing still costs a settled payment. Not needed yet.
- **Refuse such resource URLs on pubnet only, list them on testnet** (task 0054). No config, and
  the e2e gate lists as is, but local tests would fill our public testnet catalog. Rejected.
- **Store such entries and hide them from `/discovery/resources`.** Rows nobody reads, counted by
  every page, and a non-standard parameter to show them. Rejected.

## Consequences

- Anyone who settles a real payment, even a tiny one, can create a listing. That is accepted for
  Tranche 1, and quality is handled by curation and ranking later.
- An existing listing changes only when the seller's own 402 says so (task 0063). A seller that
  doesn't answer the unpaid request with a usable 402 within 10 s is not listed.
- A plain-`http` resource URL is no longer listed outside `CATALOG_LIST_LOCAL`: the check calls
  https only. None of 10,126 entries in the largest public catalog uses one (2026-10-28).
- An `mcp://tool/<name>` listing can't be checked (`mcp_tool_url`), so the e2e gate's MCP
  listing is not listed even with `CATALOG_LIST_LOCAL` (task 0029).
- A tool that is free after all runs once for the check, with the listing's example arguments.
  A paid tool doesn't: upstream's payment wrapper answers before the tool's handler.
- Loopback, private and IP resource URLs are listed nowhere unless `CATALOG_LIST_LOCAL` is set
  (task 0054), so gate runs leave none in a catalog without the switch. The rule applies to
  writes from this version on. Entries written before it stay, and can't be refreshed: a new
  payment for the same key is refused. Only local catalogs can hold them, since no durable
  catalog was deployed before (task 0026); `docker compose down -v` clears a local one.
- A seller testing a localhost route against our facilitator pays as usual and gets
  `rejected` / `resource_not_public` in `EXTENSION-RESPONSES`, next to a successful settle
  response; the buyer sees nothing of it.
- An MCP seller must set a real https URL (`@x402/mcp`'s `config.resource.url`) to be listed: the
  default `mcp://tool/<name>` is refused.
- The e2e gate's Bazaar check, once `/discovery/search` exists, needs a facilitator with
  `CATALOG_LIST_LOCAL=true` (task 0029).
- A name that resolves to loopback (`localtest.me`, `*.nip.io`) passes validation, but the check
  refuses its address, so it is not listed, with `CATALOG_LIST_LOCAL` too: that switch opens
  `localhost` names and loopback addresses written in the URL, not names that resolve there.
- A client that calls catalog URLs must check the address it connects to.
- The store (task 0013) must enforce the catalog key and support the `resources` filters.
- The e2e gate routes carry the `bazaar` extension, so a gate run also exercises cataloging:
  without the switch only the `resource_not_public` rejection, since its URLs are `localhost` and
  `mcp://`; with it, the listing.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-8, AD-19, AD-20
- [RFP 7](../rfp/07-x402-facilitator-bazaar.md),
  [RFP technical architecture §4](../rfp/x402-facilitator-bazaar-technical-architecture.md)
