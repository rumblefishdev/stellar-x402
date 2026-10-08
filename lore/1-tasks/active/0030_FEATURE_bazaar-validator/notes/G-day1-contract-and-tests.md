---
title: "packages/bazaar contract draft and test plan"
type: generation
status: developing
spawned_from: notes/R-bazaar-validation-landscape.md
tags: [bazaar, contract, tests]
links:
  - ../../../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-10-08"
    status: developing
    who: akot
    note: "Draft for review with 0017 (CatalogStore) and 0031 (EXTENSION-RESPONSES). Proposed, not agreed."
---

# `packages/bazaar` contract draft and test plan

**Status: proposed.** For review with Payments (0017 types, PR #7) and the 0031 cataloger. Every
rule comes from [R-bazaar-validation-landscape](R-bazaar-validation-landscape.md).

## Flow

```
payload + requirements
  └─ validate()            pure; never compiles the payload schema
       ├─ undefined         no extensions.bazaar → no header, nothing cataloged
       ├─ { ok: false }     → EXTENSION-RESPONSES {status:"rejected", rejectedReason:<code>}
       └─ { ok: true }      → normalize() → NormalizedEntry → CatalogStore.upsert (after the response)
```

## Signatures

```ts
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { DiscoveredResource, DiscoveryResource } from "@x402/extensions/bazaar";

export const CATALOG_KEY_VERSION = 1;

/** Closed set; the value goes into `bazaar.rejectedReason` as is. */
export type BazaarRejectReason =
  | "invalid_extension"     // bazaar block missing pieces or malformed
  | "invalid_info"          // fails validateDiscoveryExtensionSpec or our method / toolName rules
  | "invalid_resource_url"  // unparsable, non-https, userinfo, IP / localhost / trailing-dot host, > 2048
  | "too_large"             // extension, description or field over its limit
  | "schema_too_complex"    // depth, node count, non-local or recursive $ref, long pattern
  | "unsupported_version"   // x402Version !== 2
  | "internal_error";       // the wrapper caught an unexpected throw

export type ValidationResult =
  | { ok: true; discovered: DiscoveredResource; routeTemplateIgnored: boolean }
  | { ok: false; reason: BazaarRejectReason; detail?: string }; // detail: logs only, never the header

/** Pure: no I/O, no env, no clock. Returns undefined when there is no `extensions.bazaar`. */
export function validate(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): ValidationResult | undefined;

export interface CatalogKey {     // same fields as CatalogKey in apps/facilitator (PR #7)
  network: string;
  payTo: string;                  // from the verified requirements, never from the extension
  method: string;                 // HTTP method, or toolName for mcp
  resourceUrl: string;            // canonical URL; template with parameter names erased
}

export interface NormalizedEntry {
  key: CatalogKey;
  keyVersion: typeof CATALOG_KEY_VERSION;
  /** Upstream shape; `accepts` holds the one paid requirement; the caller stamps lastUpdated. */
  resource: Omit<DiscoveryResource, "lastUpdated">;
}

export function normalize(
  result: Extract<ValidationResult, { ok: true }>,
  requirements: PaymentRequirements,
): NormalizedEntry;

/** Exposed for tests and for 0032 filters. undefined = not catalogable. */
export function canonicalizeUrl(url: string): string | undefined;
export function catalogKey(input: {
  network: string; payTo: string; type: "http" | "mcp";
  method?: string; toolName?: string; resourceUrl: string; routeTemplate?: string;
}): CatalogKey | undefined;

/** For 0031: the header value. */
export function toExtensionResponses(
  result: ValidationResult,
): { bazaar: { status: "processing" } | { status: "rejected"; rejectedReason: BazaarRejectReason } };
```

**Implementation rule:**
1. Call `extractDiscoveryInfo(payload, requirements, false)` inside `try`.
2. Then call `validateDiscoveryExtensionSpec(extension)`.
3. Then run our checks.

The payload schema is walked iteratively for limits only, never compiled.

## Canonical URL and key

| Component | Rule |
|---|---|
| Parse | WHATWG `URL`; reject on throw |
| Scheme | `https` only (an `http` dev flag, off by default) |
| Userinfo | reject |
| Host | WHATWG lowercase and punycode; reject IP literals (after WHATWG IPv4 parsing), `localhost`, `*.localhost`, trailing dot |
| Port | drop the default; keep others |
| Path | resolve dot segments; decode percent-encoded unreserved characters; uppercase the remaining hex; keep case and the trailing slash; reject `//` |
| Query, fragment | drop |
| Length | ≤ 2048 |
| `routeTemplate` (http only) | stricter grammar: segments `[A-Za-z0-9_.~-]+` or `:[A-Za-z_][A-Za-z0-9_]*`, ≤ 256 chars. It must match the canonical path segment by segment and have ≥ 1 static segment. Otherwise it is discarded and the concrete path is used (spec), with `routeTemplateIgnored = true`. In the key, parameter names are erased (`/users/:`). |
| MCP | template ignored; `method = toolName` (non-empty, ≤ 128, no control characters, no surrounding whitespace) |

## Limits

| Item | Limit | Basis |
|---|---|---|
| Serialized `extensions.bazaar` | 32 KiB | body limit 64 KiB (PR #7 config) |
| `description` | 500 chars | CDP parity; over the limit rejects the listing, never the payment |
| Schema | depth ≤ 10, ≤ 1,000 nodes, local non-recursive `$ref`, `pattern` ≤ 256 chars | OpenAI limits, Ajv guidance |
| `routeTemplate` / `toolName` / URL | 256 / 128 / 2048 | policy; upstream iconUrl uses 2048 |
| `mimeType` | ≤ 127, RFC 6838 grammar | RFC 6838 |
| `serviceName`, `tags`, `iconUrl` | upstream soft-drop rules, plus: store the canonical `href`, reject `\`, trailing dot, `*.localhost`, http | spec l.384-391 and gap G7 |

## Needs agreement outside 0030 (day-1 review)

These reach beyond `packages/bazaar`, so they stay open for the review with 0017 / 0031.

1. Rename `ExtensionResponses.bazaar.reason` to `rejectedReason`, typed as `BazaarRejectReason`. Owner: 0017 / PR #7.
2. Catalog only settlements in a configured eligible-asset set above a minimum amount (red team RT1/RT2). Owner: ADR 0008 amendment + 0031.
3. Listing caps per `payTo` and per host (RT4). Owner: 0031 / 0022.
4. Persist `keyVersion` with each entry so a normalization change can be migrated. The field is decided and lives in our `NormalizedEntry`; its storage is 0022's concern.

## Test plan

**Ported from upstream** (TS bazaar suite, 143 cases at `7f2b2f1`). These cover behaviour we rely on:

- [ ] iconUrl: IP literals, decimal/hex encodings, loopback set, `data:` / `file:`, userinfo, control characters, 2048 limit.
- [ ] serviceName and tags soft-drop: 32 / 5×32, printable ASCII, case-insensitive tag dedup.
- [ ] routeTemplate: `..`, `://`, percent-encoded and double-encoded traversal (fixes for #3169).
- [ ] External `$ref` / `$id` rejected (PR #3039).
- [ ] http and mcp extraction happy paths; `toolName` carried through.

**Added by us** (from the spike and red team):

- [ ] G1: an oversized or deeply-nested schema returns `schema_too_complex` quickly; assert nothing is compiled. (Specific adversarial vectors are in the private security note, not here.)
- [ ] G2: `schema: {}` with method TRACE, an object `toolName` or type `ftp` → `invalid_info`.
- [ ] G3: missing or invalid `resource.url` → `invalid_resource_url`; missing `info.input` → `invalid_info`; no throw escapes (`internal_error` path covered).
- [ ] G4: `/users/:id` on `/orders/5`, and `/premium` on `/cheap` → template ignored, concrete path keyed.
- [ ] G5: a template on an mcp payload is ignored.
- [ ] G6: `//evil.com`, `%2F`, `%00`, CRLF, bidi, `/:`, `/:1abc`, 257-char templates rejected by the grammar.
- [ ] G7: `localhost.`, `foo.localhost`, `https://example.com\@127.0.0.1/` and http icons are dropped; a stored icon equals the canonical `href`.
- [ ] G8: `javascript:`, `file:`, `http:`, IP and localhost resource URLs → `invalid_resource_url`.
- [ ] G9: 501-char description, 33 KiB extension → `too_large`.
- [ ] G10: the cross-SDK URL corpus (case, port, userinfo, dot segments, `%7E` vs `~`, `%2f` vs `%2F`) gives one canonical form per case.
- [ ] Key: `/users/42` and `/users/7` with `/users/:userId` → one key; `/users/:id` vs `/users/:userId` → same key (RT3); `/a` vs `/a/` → two keys; query and fragment variants → one key.
- [ ] MCP: two tools on one URL → two keys; `" tool"` → `invalid_info`.
- [ ] v1 payload or missing `x402Version` → `unsupported_version`.
- [ ] RT6: a 32 KiB deeply nested schema → `schema_too_complex` without a stack overflow.
- [ ] Header: `toExtensionResponses` emits `rejectedReason` with a code, never `detail`.
- [ ] Purity: the package imports no `fs`, `net`, `process.env` or `Date` (lint rule or test).
