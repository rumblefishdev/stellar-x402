---
id: "0053"
title: "Catalog what upstream x402 servers send: empty mimeType, http, loopback and mcp URLs"
type: BUG
status: active
related_adr: ["0008"]
related_tasks: ["0030", "0032", "0028"]
tags: [bazaar, discovery, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-22"
    status: backlog
    who: karolkow
    note: >
      Found in a local gate run of the 0028 harness. Decided: treat an empty mimeType as absent;
      drop the host rules on resource URLs and keep a scheme allowlist (https, http, mcp).
  - date: "2026-10-22"
    status: active
    who: akot
    note: "Work starts."
---

# Catalog what upstream x402 servers send: empty mimeType, http, loopback and mcp URLs

## Summary

As a seller on the default upstream setup, HTTP or MCP, I want my resource cataloged after a paid
call, and as the operator I want the upstream e2e suite's Bazaar check to pass against our
catalog, so that the catalog takes what upstream servers actually send.

## Context

- Upstream's resource server sends `mimeType: routeConfig.mimeType || ""` (`@x402/core` 2.28.0),
  so every route without a `mimeType` sends an empty string. Spec v2 makes the field optional.
- Our validator (`packages/bazaar/src/validate.ts`, from 0030) accepts an absent `mimeType` but
  refuses `""` as `invalid_info` ("resource.mimeType is not a valid media type").
- Measured 2026-10-22: in a local gate run, all 16 HTTP settlements from the upstream e2e servers
  were refused for this. Of 40 sellers sampled from the CDP catalog (one per host, from the first
  1,000 of 31,851 entries), 4 sent `""`, 35 `application/json`, 1 gave no 402.
- Cataloging never blocks a settlement (ADR 0008), so payments are not affected; the listing is
  lost silently, seen only as a `catalog_rejected` log line.

- The suite's Bazaar check (`e2e/extensions/bazaar.ts:146-152` at `10b2d06`) expects
  `http://localhost:<port>/…` for HTTP servers and `mcp://tool/<name>` for MCP ones, and
  `@x402/mcp` 2.28.0 defaults to `mcp://tool/<name>`. Our validator refuses http (unless
  `CATALOG_ALLOW_HTTP`), loopback, private and IP hosts, and every non-web scheme.
- Why the host rules go: the facilitator never fetches a seller URL (ADR 0008); our MCP client
  (`packages/mcp/src/guard.ts`) checks the resolved address before every fetch, which a check on
  the URL text can't match (a public name may resolve to `127.0.0.1`), so that is where the guard
  belongs. Upstream catalogs any URL, OpenX402 lists localhost; CDP takes https only, without IP
  literals, and its 138 MCP entries all use https (measured 2026-10-22).
- What stays: a scheme allowlist, since a `javascript:` URL in a catalog rendered as links runs
  script (0030 research, gap G8). Spam is accepted as in ADR 0008: every entry costs a settled
  payment, and ranking comes in Tranche 2.
- The suite's Bazaar check also validates `/discovery/search` and fails without it
  (`e2e/extensions/bazaar.ts:606-612` at `10b2d06`), so this task makes the `/discovery/resources`
  half pass; the whole check waits for search (Tranche 2), as 0028 and ADR 0009 have it.

## Implementation

- Treat `mimeType: ""` as absent: the entry is cataloged without a `mimeType`.
- Every other value keeps the RFC 6838 check.
- Resource URLs: accept `https`, `http` and `mcp` on every network; drop the host rules (IP
  literals, loopback, private, single-label) and `CATALOG_ALLOW_HTTP`, which nothing needs then.
- A canonical form for `mcp://` URLs: WHATWG gives non-special schemes an `origin` of `"null"`
  (upstream's bug, 0030 gap G11), so `origin + path` doesn't work for them.
- Add a line to ADR 0008 saying resource URLs carry no host rules, and why.

## Acceptance Criteria

- [x] Given a settled payment whose `resource.mimeType` is `""`, when it is validated, then it is
      accepted and the entry carries no `mimeType`
- [x] Given `resource.mimeType` of `" "` or `"json"`, when it is validated, then it is still
      refused as `invalid_info`
- [x] Given resource URLs `http://localhost:4022/exact/stellar` and `mcp://tool/get_weather`, when
      they are validated on any network, then both are cataloged under a canonical URL
- [x] Given a resource URL with the `javascript:`, `data:` or `file:` scheme, when it is
      validated, then it is refused as `invalid_resource_url`
- [x] `CATALOG_ALLOW_HTTP` is gone from the config, its tests and the env examples

## Result

- `packages/bazaar/src/validate.ts`: `description: ""` and `mimeType: ""` count as absent and are
  left out of the entry; any other `mimeType` keeps the media-type check (`" "`, `"json"`, `null`
  and `0` are still `invalid_info`).
- `packages/bazaar/src/url.ts`: `canonicalizeUrl(raw, type)` takes the listing type in place of
  `UrlOptions`. `RESOURCE_SCHEMES`: an `http` listing takes `https` and `http`, an `mcp` listing
  also `mcp`; no host rules on resource URLs, on any network. Still refused: userinfo, a host
  ending in a dot, `//` in the path. `mcp:` is built by hand: lowercased DNS-style host (labels
  up to 63, host up to 253 characters), port kept, `/` for an empty path, no query or fragment,
  no backslash in the path. `catalogKey`, which had no caller and repeated `normalize`'s key
  logic, is gone. Icons keep https and the host rules (`parseIconUrl`). `https` keys don't change,
  so `CATALOG_KEY_VERSION` stays.
- `apps/facilitator`: `CATALOG_ALLOW_HTTP`, `Config.catalog` and the cataloger's `allowHttp` are
  gone; a leftover variable is ignored. The env examples never had it.
- Tests: `packages/bazaar` 72 (the rejection table with the dropped schemes, `mcp:` on an `http`
  listing, backslash, trailing dot, long labels and hosts, userinfo and `//` on `mcp:`, `mimeType` `" "`, `"json"`, `null`, `0`; the
  upstream defaults; no host rules; one canonical `mcp` URL per spelling; a template ignored on
  an `mcp` listing; icon host rules; pubnet; an unknown type), `cataloger.test.ts` the upstream default payloads through to the
  store, `config.test.ts` a leftover `CATALOG_ALLOW_HTTP` on testnet and pubnet. 16 mutants (each
  scheme rule, trailing dot, backslash, empty path, host case, the type guard, the icon suffixes
  and single-label rule, both empty-field rules, the label and host bounds, userinfo and `//` on
  `mcp:`, the http-only template) each fail a case.
- Reproduced with real upstream 2.28.0 servers: `@x402/express` and `@x402/mcp` with the e2e
  suite's route config, their 402s assembled as `@x402/core`'s client does, through our
  cataloger and `/discovery/resources?limit=1000` (develop plus #50, locally), checked with the
  suite's matching: 0 of 4 listed before, 4 of 4 after. The full gate wasn't run (no testnet
  USDC account locally).
- `docs/adr/0008-bazaar-catalog-integrity.md` and AD-19 in `docs/architecture/m1-spine.md`:
  resource URLs carry a scheme allowlist and no host rules, and why; empty fields; the `mcp:`
  key; the two accepted key splits.
- Notes added to 0041 (its "must not list localhost" no longer holds), 0029 (gate entries stay in
  the public testnet catalog) and 0044 (entries our MCP client can't call).

## Design Decisions

### From Plan

1. **An empty `mimeType` is absent** (Karol). Upstream's `@x402/core` sends
   `routeConfig.mimeType || ""`; spec v2 makes the field optional with no format. An empty string
   isn't a media type (RFC 6838), and treating exactly `""` as unset is the narrow, documented
   tolerance RFC 9413 accepts.
2. **No host rules on resource URLs, a scheme allowlist instead** (Karol). The facilitator never
   fetches them (ADR 0008); a client that does must check the resolved address at connection time
   (OWASP SSRF: DNS rebinding beats a check on the URL text), as `packages/mcp` does. The rules
   refused the upstream defaults and local sellers without stopping a public name that resolves
   to `127.0.0.1`. `javascript:`, `data:` and `file:` stay refused (OWASP XSS: links take http(s)
   only).
3. **`CATALOG_ALLOW_HTTP` goes** (Karol): nothing needs it once `http` is accepted.

### Emerged

4. **The scheme depends on the listing type** (research, in the review): `mcp:` only on an `mcp`
   listing. With `mcp:` on an `http` listing, the template path built `origin + template` and
   the key came out as `null/…` (0030 gap G11). `http` stays allowed on `mcp` listings: PayAI
   lists `http://` MCP entries.
5. **`mcp:` canonical form** (BMAD and GSD reviews, measured on Node 26): `mcp://srv` and
   `mcp://srv/` were two keys, so an empty path becomes `/`; WHATWG keeps the case of an opaque
   host, so it is lowercased and must be DNS-style; WHATWG keeps a backslash in a non-special
   path, which other parsers read as a separator, so one is refused. The port is kept: the spec
   says nothing against it.
6. **A host ending in a dot is refused,** as before: `x.com.` and `x.com` would key apart.
7. **Icons keep https and the host rules:** a browser fetches an icon as soon as the catalog is
   shown, with no guard in between.
8. **An empty `description` is absent too** (D2, decided by Adam): upstream sends it the same
   way (`|| ""`), and an entry shouldn't carry `description: ""` while it leaves out the empty
   `mimeType`.
9. **Two accepted key splits** (D3, D4, decided by Adam), written into ADR 0008:
   - `http` and `https` copies of one resource are two entries. `@x402/express` builds the URL
     from `req.protocol`, so a seller behind a TLS proxy without `trust proxy` sends `http://`.
     Folding the scheme into the key would change it (`CATALOG_KEY_VERSION`) and guess which
     scheme is real; curation in Tranche 2.
   - Two MCP servers of one `payTo` that both name a tool `mcp://tool/<name>` share one key.
     Requiring an https URL for MCP would refuse `@x402/mcp`'s default and the e2e suite.
10. **Loopback and private hosts are accepted on pubnet too, for now** (D1, decided by Adam).
    Pubnet is refused by the config until 0023, 0024 and 0025, and on testnet both options are
    the same. Refusing them on pubnet would be a listing-quality rule, as the MCP registry has
    (`localhost`, `127.0.0.1`, `*.localhost`), not an SSRF one; see Future Work.
11. **What our MCP client does with these entries is 0044's** (D5, decided by Adam): it is a
    different component; note added there.

## Future Work

- Before mainnet: decide whether pubnet refuses loopback, private and IP resource URLs as a
  listing-quality rule (the network is in `paymentRequirements`, so no config is needed). Not
  taken now because pubnet is refused until 0023, 0024 and 0025. Spawned as a backlog task when
  0053 closes and linked from a pubnet blocker (0053 review).
- The suite's whole Bazaar check, once `/discovery/search` exists (Tranche 2); then the gate can
  run with `--extensions=bazaar` (0028).
