---
title: "Bazaar validation landscape: upstream x402, other catalogs, prior art and a spike"
type: research
status: mature
spawns: [notes/G-day1-contract-and-tests.md]
tags: [bazaar, discovery, security, research]
links:
  - https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md
  - https://docs.cdp.coinbase.com/x402/seller/get-discovered.md
history:
  - date: "2026-10-08"
    status: mature
    who: akot
    note: "bmad-deep-recon run (technical + competitive), spike against @x402/extensions 2.28.0, party-mode and red team / pre-mortem pressure test."
---

# Bazaar validation landscape

Research for 0030, run on 2026-10-08. Upstream read at `x402-foundation/x402@7f2b2f1`
(2026-10-07); the bazaar code in `@x402/extensions` 2.27.0 and 2.28.0 is byte-identical, so the
0016 upgrade does not change it. The raw run folder (digests, spike scripts, transcripts) is local
and gitignored: `_bmad-output/planning-artifacts/research/technical-x402-bazaar-validation-and-catalog-keys-2026-10-08/`.

## Key findings

1. **We do our own bounded validation and never compile a seller-supplied JSON Schema in-process.**
   We validate `info` against a trusted shape (`validateDiscoveryExtensionSpec`) and treat
   `schema` as opaque data behind size, depth and node-count caps. This matters because our
   validation runs inside `/settle` (AD-8) and stored records are re-processed at startup (AD-16),
   so untrusted input on that path must be bounded. _A specific upstream security concern, its
   measurements and the proof of concept are held in a private note, not committed, pending
   coordinated disclosure to upstream per their `SECURITY.md` (HackerOne). Do not add those
   details to this repository._
2. **Upstream does not key, dedupe, limit or explain.** No SDK computes a catalog key or checks a
   `routeTemplate` against the URL. Nothing limits description, schema or extension size, and
   rejections are free text. TS, Python and Go build different canonical URLs for the same input
   (Python keeps `user:pass@`, host case and the port).
3. **The spec settles two of our open questions:**
   - MCP tools **must** be keyed by (`resource.url`, `toolName`).
   - An invalid `routeTemplate` is discarded and the concrete path is used.
   - The header field is `rejectedReason`. PR #7's `ExtensionResponses` calls it `reason`.
4. **Others leave room.**
   - Only Binance B402 publishes its key: `(merchantId, resourceUrl)`, with accepts keyed by `(scheme, network, asset)`.
   - CDP enforces a template-matches-resource check and a 500-char description limit. Its reasons are free text, and it auto-templates UUID, EVM and Solana IDs but not Stellar ones.
5. **No standard gives a schema byte limit.** Our numbers are policy, anchored on CDP (description
   500) and OpenAI Structured Outputs (depth 10, 1,000 enum values).

## Comparison

| | Validation | Sanitizing | Catalog key | SSRF (iconUrl) | Limits | Reason codes |
|---|---|---|---|---|---|---|
| Upstream TS | validates `info` against the payload's own schema; trusted-shape check only at server startup | serviceName 32, tags 5×32, iconUrl 2048; raw icon string returned | none; canonical URL `origin + (template or path)` | WHATWG parse; misses `localhost.`, `*.localhost` | none beyond metadata | free text |
| Upstream Python | `jsonschema`, first error | same rules | none; keeps userinfo, case, port | `urlparse`: accepts `127.1`, octal | none | free text |
| Upstream Go | gojsonschema (2020-12 support doubtful) | same rules, trims toolName | none; keeps userinfo, case | `url.Parse` (inferred like Python) | none | free text |
| CDP Bazaar | strict schema on `input` | icons rehosted | not published; MCP `url#toolName` (observed) | https only, no bare IPs | description 500 (fails settle); 30-day expiry | status + free-text reason |
| Binance B402 | JSON Schema 2020-12, silent skip | — | `(merchantId, resourceUrl)` + accepts `(scheme, network, asset)` | not documented | list 100 | none |
| x402scan | registration + 402 probe | tunnel denylist | `(resource, method)` | incomplete string checks | probe caps | tagged types |
| PayAI / thirdweb / OpenX402 | not documented | — | observed `(resource, toolName)` / CDP mirror / raw URL | OpenX402 lists localhost | — | none |

## Gaps found in upstream (spike: 221 probes, 89 non-OK; upstream TS tests 143/143 green)

Classification:
- **(a)** fix in our wrapper.
- **(b)** propose upstream; for a vulnerability, report privately.
- **(c)** accept.

| # | Gap | Evidence | Class |
|---|---|---|---|
| G1 | Seller-supplied schema handling on the extract path (details withheld) | private security note, not committed | a + b (private, coordinated disclosure) |
| G2 | `info` validated only against its own schema; `schema: {}` admits method TRACE or an object `toolName` | spec validator unused on extract path, dist 711-765 vs 783 | a + b |
| G3 | Throws on missing/invalid `resource.url` and missing `info.input` | dist 809, 838 | a + b |
| G4 | `routeTemplate` never matched to the URL (`/premium` can stand in for `/cheap`) | dist 810; CDP enforces it (#3019) | a + b |
| G5 | `routeTemplate` applied to MCP URLs | dist 810 before type branch | a + b |
| G6 | Loose template grammar: `//evil.com`, `%00`, CRLF, bidi, 100k chars | regex dist 548 | a + b |
| G7 | iconUrl: `localhost.`, `*.localhost` accepted; raw string stored (parser differential with `\@`) | dist 583-657 | a + b |
| G8 | Non-http resource schemes cataloged (`javascript:` → key `nullalert(1)`), IP/loopback hosts | dist 771, 809 | a + b |
| G9 | No size caps (10 MB description accepted) | dist 815-836 | a; c for the helper (spec leaves envelope limits to facilitators) |
| G10 | TS/Python/Go disagree on IP forms and canonical URL | spike cross-SDK probe | a (own canonicalizer); b (issue) |
| G11 | `mcp://` canonical URL is `"null/…"` | issue #3121, PR #3138 open | a; b exists |
| G12 | Internal DNS names in iconUrl (nip.io, rebinding) | static checks only | c: we never fetch; document |
| G13 | v1 coercions without validation | dist 423-512 | c: we catalog v2 only |

Open upstream threads relevant to us: #3005 (no provenance for echoed metadata), #3226 (spec
allows cataloging on verify), #2281 / #3266 / #3281 / #3677 (opaque CDP rejections).

## Red team (applied to our proposed rules)

- **RT1/RT2 — provenance.** Anyone can settle a payment to a victim's `payTo` in a worthless
  self-issued token (AD-9 allows any SEP-41 token) and overwrite the victim's listing or pollute
  its `accepts`. The `payTo` in the key does not stop it. → **To raise in review:** catalog only
  settlements in a configured eligible-asset set above a minimum amount (ADR 0008 amendment + 0031).
- **RT3 — same route, two keys.** Templates that differ only by parameter names. → **Decided:**
  erase parameter names in the key; keep the original template for display only.
- **RT4/RT5 — catalog inflation.** Wildcard subdomains, and IDs in paths when there is no template.
  → **To raise in review:** per-`payTo` and per-host listing caps (0031 / 0022). Stellar
  auto-templating is a follow-up.
- **RT6 — stack overflow.** A recursive depth walk over a 32 KiB nested payload overflows. →
  **Decided:** walk the schema iteratively with early stop at the depth / node caps.

Decisions are reflected in the 0030 [README](../README.md#decisions); cross-task items stay open
for the day-1 review.

## Not verified

- Go runtime behaviour (no toolchain).
- Whether CDP has an internal reason enum.
- The MCP `toolName` grammar.
- AWS and Azure metadata host names.
- Questflow, Heurist, Mogami and AltLayer were not searched.

## Sources

- [x402 bazaar spec @ 7f2b2f1](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md):
  - l.282 MCP key;
  - l.384-391 sanitizing;
  - l.487-516 `EXTENSION-RESPONSES`;
  - l.535-582 `routeTemplate`;
  - l.590 v1.
- x402 issues and PRs:
  - [#3005](https://github.com/x402-foundation/x402/issues/3005),
    [#3019](https://github.com/x402-foundation/x402/issues/3019),
    [#3121](https://github.com/x402-foundation/x402/issues/3121),
    [#3226](https://github.com/x402-foundation/x402/issues/3226);
  - [PR #3039](https://github.com/x402-foundation/x402/pull/3039) (external `$ref` fix).
- [CDP: get discovered](https://docs.cdp.coinbase.com/x402/seller/get-discovered.md) (accessed 2026-10-08).
- Binance B402 Bazaar docs; live discovery endpoints of CDP, PayAI, thirdweb, OpenX402 (2026-10-08).
- [Merit-Systems/x402scan](https://github.com/Merit-Systems/x402scan).
- Standards:
  - [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) §4.2.3–4.2.4;
  - [RFC 3986](https://www.rfc-editor.org/rfc/rfc3986) §6;
  - [WHATWG URL](https://url.spec.whatwg.org/);
  - [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1) path templating;
  - [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761);
  - [IANA special-purpose registries](https://www.iana.org/assignments/iana-ipv4-special-registry/).
- Security guidance and advisories:
  - [OWASP SSRF cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html);
  - [Ajv security](https://ajv.js.org/security.html);
  - CVE-2023-42282, CVE-2024-45296, CVE-2025-8020.
- [OpenAI Structured Outputs limits](https://platform.openai.com/docs/guides/structured-outputs).
