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

## Implementation

- Treat `mimeType: ""` as absent: the entry is cataloged without a `mimeType`.
- Every other value keeps the RFC 6838 check.
- Resource URLs: accept `https`, `http` and `mcp` on every network; drop the host rules (IP
  literals, loopback, private, single-label) and `CATALOG_ALLOW_HTTP`, which nothing needs then.
- A canonical form for `mcp://` URLs: WHATWG gives non-special schemes an `origin` of `"null"`
  (upstream's bug, 0030 gap G11), so `origin + path` doesn't work for them.
- Add a line to ADR 0008 saying resource URLs carry no host rules, and why.

## Acceptance Criteria

- [ ] Given a settled payment whose `resource.mimeType` is `""`, when it is validated, then it is
      accepted and the entry carries no `mimeType`
- [ ] Given `resource.mimeType` of `" "` or `"json"`, when it is validated, then it is still
      refused as `invalid_info`
- [ ] Given resource URLs `http://localhost:4022/exact/stellar` and `mcp://tool/get_weather`, when
      they are validated on any network, then both are cataloged under a canonical URL
- [ ] Given a resource URL with the `javascript:`, `data:` or `file:` scheme, when it is
      validated, then it is refused as `invalid_resource_url`
- [ ] `CATALOG_ALLOW_HTTP` is gone from the config, its tests and the env examples
