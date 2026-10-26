---
id: "0054"
title: "Keep loopback, private and IP resource URLs out of the catalog"
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
      Decided with the team (Adam): the catalog refuses loopback, private, special-use,
      single-label and IP resource URLs and `mcp:` URLs on every network, testnet included;
      `CATALOG_LIST_LOCAL=true` (testnet only) lists them for local runs and the e2e gate. The
      payment always settles. Built on a GSD research and implementation, compared with a first
      pubnet-only version. 112 bazaar tests, 405 facilitator tests.
  - date: "2026-10-26"
    status: active
    who: akot
    note: >
      Oskar's review of PR #66: `.home`, `.corp` and `.mail` join the host rule; no cleanup of
      0053-era entries, since no durable catalog was deployed (docs say the rule applies from this
      version); stale scope in ADR 0008, 0029, 0063 and `conformance/README.md` fixed; the gate's
      Bazaar check moves to 0029; fixtures off `seller.example`; the task retitled.
---

# Keep loopback, private and IP resource URLs out of the catalog

## Summary

As the operator of a facilitator, I want the catalog to leave out loopback, private and IP
resource URLs, so that the public catalog doesn't list entries no buyer can reach, while a
payment for such a resource still settles.

Spawned as "Decide whether pubnet refuses loopback, private and IP resource URLs"; the decision
(decision 1) covers every network, so the title changed. The file and branch keep the
`pubnet-resource-hosts` slug.

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
      is refused, as `resource_not_public` (decision 5) rather than `invalid_resource_url`.
      Testnet does not keep accepting it, by decision 1: it refuses it too unless
      `CATALOG_LIST_LOCAL=true`

## Research

Measured 2026-10-26 from the live `/discovery/resources` of each catalog (GSD research, about
98,800 entries; CDP crawled twice). None lists a loopback, private, single-label or IP-literal
resource URL, on mainnet or testnet, and none lists an `mcp://` URL.

- **CDP:** about 74,100 entries, all `https`; 1,482 on Base Sepolia and Solana Devnet. Its docs
  ask for "a public HTTPS URL" and send testnet sellers to the same catalog. Whether a
  `localhost` URL fails CDP's settle or only its listing isn't documented. Its `network` filter
  is ignored.
- **PayAI:** 23,836 entries, 9,519 testnet-only; 798 `http://` with public names on all
  networks, 783 of them on mainnets.
- **OpenX402:** 50 entries (0053 saw `localhost` ones; gone now).
- **MCP registry:** refuses `localhost`, `127.0.0.1` and `*.localhost` remotes, requires https.
- **Upstream x402:** no host rules on resource URLs.
- Whether CDP and PayAI refuse such URLs or never receive them isn't documented; the ADR says
  "list none". "Vellar", named in a team message as refusing them, wasn't found.

## Result

- `packages/bazaar/src/validate.ts` step 5: after `canonicalizeUrl`, unless
  `options.listLocal`, a URL that fails `isPublicResourceUrl` is refused as
  `resource_not_public` (log-only detail "not a public http(s) host"), a new value in
  `REJECT_REASONS`; a malformed URL is still `invalid_resource_url`, checked first. `validate`
  takes a third argument, `ValidateOptions { listLocal?: boolean }`, exported. Both the
  `EXTENSION-RESPONSES` header and the store write call `validate`, so the seller sees `rejected`
  and no row is written; the settle body and status don't change.
- `packages/bazaar/src/url.ts`: `isPublicResourceUrl(canonical)` is `http(s)` and
  `!isForbiddenHost(hostname)`, the icon host rule, on the WHATWG-parsed canonical URL: every
  IPv4 spelling WHATWG folds into a dotted quad, bracketed IPv6, public IP literals, single-label
  names, encoded `localhost` and the private suffixes. `PRIVATE_SUFFIXES` gains `test`,
  `example`, `alt` and `onion`, and after the review `home`, `corp` and `mail`, for icons too.
- Still listed: public names over `https` or `http`, and names that resolve to loopback
  (`localtest.me`, `127.0.0.1.nip.io`): the catalog never resolves names (ADR 0008).
- `apps/facilitator`: `CATALOG_LIST_LOCAL` (`true`/`false`, default `false`), refused outside
  testnet ("is only allowed on testnet"), into `Config.catalog.listLocal`, `compose()` and the
  cataloger's `listLocal`, which passes it to `validate`. README section "What gets listed".
- No migration and no cleanup: `CATALOG_KEY_VERSION` stays 1, and no durable catalog has been
  deployed (0026 is in the backlog), so the first one starts under this rule (decision 13). A
  local catalog written before keeps its old entries until `docker compose down -v`.
- Tests: `packages/bazaar` 72 to 112. A 32-row table refused on testnet and pubnet with the
  header and listed with `listLocal`; 6 rows listed on both networks; `listLocal` still refusing
  a bad scheme, userinfo and a backslash; 0053's canonical-form cases run with `listLocal`; 4 icon
  rows for the new suffixes. `apps/facilitator`: a cataloger case per network and switch (header,
  entries, rejection metric, the `catalog_rejected` detail); 0053's upstream-defaults case with
  `listLocal`; a settle route case (pubnet localhost payment: 200, the settler's body, the
  rejected header from the real cataloger); config cases for the switch. Test fixtures move from
  `seller.example` to `seller.example.com`, since `.example` is now refused (after the review
  also in `discovery.test.ts`, `port-contracts.ts` and `postgres.test.ts`, which skip the
  validator). After the review: `.home`, `.corp` and `.mail` refused, and `mail.x.com`,
  `home.x.com` and `nas.lan` listed; bazaar 118.
- Mutants, each failing a case (GSD's run on the pubnet-only version, rerun for the switch): no
  switch check, the switch ignored, no scheme check, https only, no host check, `url.host` for
  `hostname`, no IPv4, single-label or suffix clause, suffixes without subdomains, no `onion`,
  no `example`, no log detail. The IPv6 bracket clause is an equivalent mutant (a WHATWG IPv6
  host has no dot, so the single-label clause catches it); kept for intent.
- ADR 0008 (Decision, Rationale, Alternatives, Consequences), AD-19 in
  `docs/architecture/m1-spine.md`, `conformance/README.md` (the Bazaar check needs the switch),
  notes in 0023, 0041 and 0044.

## Design Decisions

### From Plan

1. **Refused on every network, testnet included; `CATALOG_LIST_LOCAL` lists them** (decided by
   Adam after the team meeting and a teammate's proposal). The meeting's goal: a payment to a
   `localhost` resource settles, so people can test locally, but the entry is not in the Bazaar.
   Sellers test on testnet, so a pubnet-only rule would list exactly those entries in our public
   testnet catalog. CDP and PayAI list none on testnet either. A facilitator run locally and the
   e2e gate, whose upstream Bazaar check expects `localhost` and `mcp://tool/<name>`, set the
   switch; the config refuses it on pubnet. Rejected: pubnet only (the first version and GSD's),
   and storing such entries but hiding them from `/discovery/resources`.
2. **Payments are untouched.** The rule is in the pure validator, which runs after `settle()`
   returns; the header is best-effort and the store write runs after the response.
3. **In `validate` step 5, on the canonical URL** (GSD research). One place for header and store,
   the reason the criterion names, and WHATWG has already normalized the host. Not in
   `canonicalizeUrl`, which defines the key, nor as a read-side filter.
4. **Reuse the icon host rule, refuse every IP literal** (GSD research). One list to keep; no
   `ipaddr.js`, no `node:net` (the purity test forbids it). Public IPs fall under "IP resource
   URLs", as on CDP.
5. **A reason of its own, `resource_not_public`** (decided by Adam in the PR, replacing the GSD
   research's `invalid_resource_url`). The seller reads `rejected` next to a successful settle;
   `invalid_resource_url` would read as a broken request although the URL is fine and the payment
   went through. The new value shows in the header and as a `catalog_rejections_total` label.
6. **The switch is a validator option, not the network.** The validator stays pure (no env); the
   facilitator reads `CATALOG_LIST_LOCAL` and passes it, as `CATALOG_ALLOW_HTTP` did before 0053.
   It opens hosts and `mcp:` URLs only, not schemes or userinfo.

### Emerged

7. **Plain `http` with a public name stays listable** (GSD's call, kept). A seller behind a TLS
   proxy without `trust proxy` sends `http://` (0053 decision 9), and PayAI lists 783 such
   entries on mainnets (798 on all networks). CDP lists only https; parity can come with curation.
8. **`mcp:` URLs are refused** (GSD's call, in line with the teammate's proposal; to confirm in
   review). `mcp://tool/<name>` names a tool, not a server a buyer can reach, and no public
   catalog lists one. An MCP seller sets a real https URL through `@x402/mcp`'s
   `config.resource.url`, or a local run uses the switch.
9. **The special-use suffixes `test`, `example`, `alt` and `onion` join the host rule** (GSD's
   call; to confirm in review). RFC 6761, 9476 and 7686 reserve them; it tightens icons too.
10. **The function is `isPublicResourceUrl`:** it applies to every network, and 0044 may reuse it
    for a client-side filter.
11. **Two implementations compared first.** A pubnet-only version written here and an independent
    GSD research and implementation (blind to it) agreed on the place, the host rule and the
    reason; GSD's had the route and cataloger tests and the AD-19 and notes updates, so it became
    the base, with decision 1 on top.
12. **The IPv6 bracket clause stays although its mutant survives.**

### From the review (PR #66, Oskar)

13. **No one-off cleanup of entries listed under 0053** (decided by Adam). They can't refresh any
    more, but no durable catalog was ever deployed (0026 is in the backlog), so only local
    catalogs hold them; ADR 0008 and the README say the rule applies to writes from this version
    on.
14. **`.home`, `.corp` and `.mail` join the host rule; `.lan` doesn't** (decided by Adam). ICANN
    decided in 2018 never to delegate the first three, so like `.internal` they can only be
    internal names. `.lan` is a router default but not reserved.
15. **The gate's Bazaar check moves to 0029.** 0028 is completed; 0029 decides whether the check
    runs against a facilitator of its own with `CATALOG_LIST_LOCAL=true` or the hosted one with
    the switch on.
