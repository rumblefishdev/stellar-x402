---
id: "0054"
title: "Decide whether pubnet refuses loopback, private and IP resource URLs"
type: FEATURE
status: active
milestone: 1
related_adr: ["0008"]
related_tasks: ["0053", "0023", "0024", "0025", "0044"]
tags: [bazaar, discovery, priority-low, effort-small]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-10-22"
    status: backlog
    who: claude
    note: >
      Spawned from 0053 Future Work at Oskar's request in the PR #55 review, so that something on
      the way to pubnet points at it. Linked from 0023.
  - date: "2026-10-26"
    status: active
    who: akot
    note: >
      Work starts.
  - date: "2026-10-26"
    status: active
    who: akot
    note: >
      Implemented: pubnet (any network but testnet) refuses loopback, private, special-use,
      single-label and IP resource URLs and `mcp:` URLs as `invalid_resource_url`; testnet keeps
      listing them; the payment is untouched. ADR 0008 and AD-19 amended. Four scope choices
      (http, mcp, special-use suffixes, testnet exemption) follow the research and wait for review.
---

# Decide whether pubnet refuses loopback, private and IP resource URLs

## Summary

As the operator of a pubnet facilitator, I want a decision on whether the catalog refuses
loopback, private and IP resource URLs on pubnet, so that the public catalog doesn't list entries
no buyer can reach, or so that we say on purpose that it does.

## Context

- 0053 dropped the host rules on `http(s)` resource URLs on every network: the facilitator never
  fetches them, and SSRF is checked by whoever does, at connection time (ADR 0008).
- On testnet that is needed: the upstream e2e suite and local sellers send `http://localhost:…`.
  On pubnet, such an entry is only noise for buyers.
- The rule would be about listing quality, not SSRF, as the MCP registry refuses `localhost`,
  `127.0.0.1` and `*.localhost`. The network is in `paymentRequirements`, so no config is needed.
- Pubnet is refused by the config until 0023, 0024 and 0025, so this has to be decided before
  that refusal goes.

## Acceptance Criteria

- [x] Decided and written into ADR 0008: pubnet refuses loopback, private and IP resource URLs,
      or lists them as sent, and why
- [x] If refused: given a pubnet payment with such a resource URL, when it is validated, then it
      is refused as `invalid_resource_url`, and testnet keeps accepting it

## Result

- Decided (product owner): pubnet refuses loopback, private and IP resource URLs; testnet keeps
  listing them; the payment settles as usual and only the listing is dropped.
- `packages/bazaar/src/validate.ts` step 5: after `canonicalizeUrl`, on any network but
  `STELLAR_NETWORKS.testnet`, a URL that fails `isPublicResourceUrl` is refused as
  `invalid_resource_url` with the log-only detail "not a public http(s) host, listed on testnet
  only". Both the `EXTENSION-RESPONSES` header and the store write call `validate`, so the seller
  sees `rejected` / `invalid_resource_url` and no row is written; the settle body and status
  don't change.
- `packages/bazaar/src/url.ts`: `isPublicResourceUrl(canonical)` is `http(s)` and
  `!isForbiddenHost(hostname)`, the icon host rule, on the WHATWG-parsed canonical URL. It
  catches every IPv4 spelling WHATWG folds into a dotted quad (`127.1`, `2130706433`,
  `0x7f000001`, `0177.0.0.1`, `127.0.0.1.`, `0`), bracketed IPv6 (also `[::ffff:127.0.0.1]`),
  public IP literals, single-label names, encoded `localhost` (`local%68ost`, full-width) and the
  private suffixes. `PRIVATE_SUFFIXES` gains `test`, `example`, `alt` and `onion`, for icons too.
  Not exported from the package.
- Still listed on pubnet: public names over `https` or `http`, and names that resolve to loopback
  (`localtest.me`, `127.0.0.1.nip.io`): the catalog never resolves names (ADR 0008).
- No new reject reason, no config, no migration: `CATALOG_KEY_VERSION` stays 1, and no pubnet
  rows can exist yet (the config refuses pubnet).
- Tests: `packages/bazaar` 72 to 110. The old "no network decides them" case became a 32-row
  table (refused on pubnet with the header, listed on testnet with today's canonical URL), 6
  rows listed on pubnet, a third network refused like pubnet, 4 icon rows for the new suffixes.
  `apps/facilitator`: a cataloger case per network (header, entries, rejection metric, the
  `catalog_rejected` detail) and a settle route case (pubnet localhost payment: 200, the
  settler's body, the rejected header from the real cataloger).
- Mutants, each failing a case: no network condition, `=== pubnet` for `!== testnet`, no scheme
  check, https only, no host check, `url.host` (with the port) for `hostname`, no IPv4,
  single-label or suffix clause, suffixes without subdomains, no `onion`, no `example`, no log
  detail. The IPv6 bracket clause is an equivalent mutant: a WHATWG IPv6 host never has a dot, so
  the single-label clause catches it; kept for intent.
- `docs/adr/0008-bazaar-catalog-integrity.md` (Decision, Rationale, Consequences) and AD-19 in
  `docs/architecture/m1-spine.md`. Notes added to 0041, 0044 and 0023.

## Design Decisions

### From Plan

1. **Pubnet refuses loopback, private and IP resource URLs; testnet lists them** (product
   owner). Listing quality, not SSRF: no buyer can reach such a host. CDP, PayAI and OpenX402
   list none on any network (about 98,800 entries, measured 2026-10-26), and the MCP registry
   refuses `localhost` remotes. Testnet keeps them for upstream's e2e suite and local sellers.
2. **Payments are untouched** (product owner). The rule is in the pure validator, which runs
   after `settle()` returns; the header is best-effort and the store write runs after the
   response.
3. **In `validate` step 5, on the canonical URL** (research). One place for header and store, the
   reason the acceptance criterion names, and WHATWG has already normalized the host. Not in
   `canonicalizeUrl`, which defines the network-independent key.
4. **Reuse the icon host rule, refuse every IP literal** (research). One list to keep; no range
   tables or `ipaddr.js`, and no `node:net` (the purity test forbids it). Public IPs are covered by
   "IP resource URLs".
5. **`invalid_resource_url`, no new reason** (research, Q5). `REJECT_REASONS` is closed and goes
   to the header and metrics; the log-only detail tells the cases apart.
6. **Plain `http` with a public name stays listable on pubnet** (implementer's call from the
   research's Q1; not decided by the product owner, to confirm in review). The decision is about
   hosts; a seller behind a TLS proxy without `trust proxy` sends `http://` (0053 D3), and PayAI
   lists 783 such mainnet entries. CDP parity (https only) can come with curation (0063).
7. **`mcp:` URLs are refused on pubnet** (implementer's call from the research's Q2; to confirm in
   review). `mcp://tool/<name>` names a tool, not a server a buyer can reach, the same reasoning
   as the decision, and no public catalog lists one. `mcp://tool/x` is single-label and refused by
   the host rule anyway; refusing the scheme adds `mcp://srv.example.com/x` and avoids WHATWG not
   IPv4-parsing opaque hosts (`mcp://0x7f.0.0.1/x`). An MCP seller sets a real https URL through
   `@x402/mcp`'s `config.resource.url`. Fallback if refused in review: the host rule on the
   lowercased `mcp:` host only.
8. **The special-use suffixes `test`, `example`, `alt` and `onion` join the host rule**
   (implementer's call from the research's Q3; to confirm in review). RFC 6761, 9476 and 7686
   reserve them; none is a public DNS name, and no live catalog entry uses one. It tightens icons
   too, which ADR 0008's "no loopback or private hosts" already intends.
9. **Testnet is the exception, not pubnet the rule: `!== testnet`** (implementer's call from the
   research's Q4; to confirm in review). A network added later gets the strict rule. With today's
   two networks the two forms are the same, so a third-network case pins the choice.

### Emerged

10. **The function is named `isPublicResourceUrl`, not `isListableOnPubnet`:** it applies to every
    network but testnet, and 0044 may reuse it for a client-side filter.
11. **A settle route case with the real cataloger's header** (research marked it optional): it pins
    the product owner's "payments settle normally" end to end at the route, 200 with the
    settler's body and the rejected header.
12. **The IPv6 bracket clause stays although its mutant survives:** WHATWG serializes IPv6 in hex,
    so a bracketed host never has a dot and the single-label clause already refuses it.
