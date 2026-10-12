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
       ├─ undefined         raw payload has no extensions.bazaar → no header, nothing cataloged
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
  | {
      ok: true;
      /** Upstream extraction minus its URL fields: upstream builds `resourceUrl` as
       *  `origin + routeTemplate` even for a template we discard, so it is never passed on. */
      discovered: Omit<DiscoveredResource, "resourceUrl" | "routeTemplate">;
      resourceUrl: string;           // canonicalizeUrl(payload.resource.url): the concrete URL
      routeTemplate?: string;        // set only when the template passed our grammar and matched
      routeTemplateIgnored: boolean; // a template was sent and discarded (metrics)
    }
  | { ok: false; reason: BazaarRejectReason; detail?: string }; // detail: logs only, never the header

/** Pure: no I/O, no env, no clock. Returns undefined only when the raw payload has no
 *  `extensions.bazaar` key; never derived from upstream's `null`. */
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

**Implementation rule.** Our checks run on the **raw payload first**; upstream extraction runs
last. In 2.27/2.28 `extractDiscoveryInfo` calls `new URL(resource.url ?? "")` outside its own
`try` and reads `info.input.type` unguarded, so a bad URL or a missing `info.input` would throw and
surface as `internal_error`. It also returns `null` both for "no `info`" and for any
`x402Version` other than 1 or 2, so its return value cannot drive the reason codes. The first
failing step decides the reason:

1. **Presence.** No `payload.extensions?.bazaar` key → `undefined`. Present but not a plain
   object → `invalid_extension`.
2. **Version.** `payload.x402Version !== 2` (v1, missing, anything else) → `unsupported_version`.
3. **Size.** Serialized block > 32 KiB → `too_large`. Measured without recursion; a `RangeError`
   from serializing an over-deep block also maps to `too_large`.
4. **Shape.** `validateDiscoveryExtensionSpec(raw)` fails (missing `info` or `info.input`, bad
   `type`, `method` or mcp fields) → `invalid_info`. Then our rules, also `invalid_info`: `http`
   **requires** `method` (upstream allows it to be absent; we never default it), and the
   `toolName` rules in the key table.
5. **Resource URL.** `canonicalizeUrl(payload.resource?.url)` returns undefined →
   `invalid_resource_url`.
6. **Limits.** Description over 500 → `too_large`; the schema walk (iterative, never compiled)
   over its caps → `schema_too_complex`.
7. **Extract.** Only now call `extractDiscoveryInfo(payload, requirements, false)` inside `try`.
   Steps 1–5 remove every input it is known to throw on, so a throw or a `null` here is a real
   `internal_error`. Keep its `discoveryInfo` and sanitized metadata; drop its `resourceUrl` and
   `routeTemplate`. `validate` stays `false`: `true` compiles the seller's schema in-process.
8. **Template** (http only). Our grammar plus the segment match against the canonical path from
   step 5. Pass → `routeTemplate` is set; fail → it is discarded and `routeTemplateIgnored = true`.

`normalize()` builds the key only from `resourceUrl` and `routeTemplate` in the ok result, never
from anything upstream computed.

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
| `routeTemplate` (http only) | stricter grammar: segments `[A-Za-z0-9_.~-]+` or `:[A-Za-z_][A-Za-z0-9_]*`, ≤ 256 chars. It must match the canonical path segment by segment and have ≥ 1 static segment. Any failure, including length, discards it and the concrete path is used (spec), with `routeTemplateIgnored = true`; it never rejects the listing. In the key, parameter names are erased (`/users/:`). |
| MCP | template ignored; `method = toolName` (non-empty, ≤ 128, no control characters, no surrounding whitespace; otherwise `invalid_info`) |
| HTTP method | required; missing → `invalid_info` |

**Accepted limit: one resource can have two keys.** Parameter names are erased only when a
template is present and accepted, so `/users/42` keys as `/users/:` with `/users/:id` but as
`/users/42` without a template or with a discarded one. The two listings coexist. We accept this
for M1: a seller's middleware sends the same template for a route on every call, so a mixed pair
needs a stripped template or a seller config change. Inflation from it is bounded by the per-`payTo`
and per-host caps (RT4); auto-templating identifiers (RT5, Future Work) removes most of it.

## Limits

Every limit names its outcome. A rejection never fails the payment, only the listing.

| Item | Limit | Over the limit | Basis |
|---|---|---|---|
| Serialized `extensions.bazaar` | 32 KiB | `too_large` | body limit 64 KiB (PR #7 config) |
| `description` | 500 chars | `too_large` | CDP parity |
| Schema | depth ≤ 10, ≤ 1,000 nodes, local non-recursive `$ref`, `pattern` ≤ 256 chars | `schema_too_complex` | OpenAI limits, Ajv guidance |
| `toolName` | 128 | `invalid_info` | policy |
| Resource URL | 2048 | `invalid_resource_url` | policy; upstream iconUrl uses 2048 |
| `routeTemplate` | 256 | template discarded, listing kept (grammar failure) | spec fallback rule |
| `mimeType` | ≤ 127, RFC 6838 grammar | `invalid_info` | RFC 6838 |
| `serviceName`, `tags`, `iconUrl` | upstream soft-drop rules, plus: store the canonical `href`, reject `\`, trailing dot, `*.localhost`, http | field dropped, listing kept | spec l.384-391 and gap G7 |

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
- [ ] http and mcp extraction happy paths; `toolName` carried through.

**Added by us** (from the spike and red team):

- [ ] External `$ref` / `$id` → `schema_too_complex`, by our own schema walk. Upstream's
      `hasExternalSchemaReference` (PR #3039) runs only inside `validateDiscoveryExtension`, which
      the `validate = false` path skips; reuse the PR's cases, not its coverage.
- [ ] G1: an oversized or deeply-nested schema returns `schema_too_complex` quickly; assert nothing is compiled. (Specific adversarial vectors are in the private security note, not here.)
- [ ] G2: `schema: {}` with method TRACE, an object `toolName` or type `ftp` → `invalid_info`.
- [ ] G3 (order of checks): missing or invalid `resource.url` → `invalid_resource_url`, not `internal_error`; bazaar block without `info`, or `info` without `input` → `invalid_info`, not `undefined` or `internal_error`; `extensions.bazaar = "x"` → `invalid_extension`; no throw escapes (`internal_error` path covered with a stubbed upstream throw).
- [ ] G3b: `info.input = { type: "http" }` (no method) → `invalid_info`.
- [ ] G4: `/users/:id` on `/orders/5`, and `/premium` on `/cheap` → template ignored, concrete path keyed **and stored** (the entry's URL is `https://x/cheap`, not upstream's `origin + template`).
- [ ] G5: a template on an mcp payload is ignored.
- [ ] G6: `//evil.com`, `%2F`, `%00`, CRLF, bidi, `/:`, `/:1abc`, 257-char templates fail the grammar → discarded, listing kept, `routeTemplateIgnored = true`.
- [ ] G7: `localhost.`, `foo.localhost`, `https://example.com\@127.0.0.1/` and http icons are dropped; a stored icon equals the canonical `href`.
- [ ] G8: `javascript:`, `file:`, `http:`, IP and localhost resource URLs → `invalid_resource_url`.
- [ ] G9: 501-char description, 33 KiB extension → `too_large`.
- [ ] G10: the cross-SDK URL corpus (case, port, userinfo, dot segments, `%7E` vs `~`, `%2f` vs `%2F`) gives one canonical form per case.
- [ ] Key: `/users/42` and `/users/7` with `/users/:userId` → one key; `/users/:id` vs `/users/:userId` → same key (RT3); `/a` vs `/a/` → two keys; query and fragment variants → one key.
- [ ] MCP: two tools on one URL → two keys; `" tool"` → `invalid_info`.
- [ ] v1 payload, `x402Version: 3` or missing `x402Version` → `unsupported_version` (read from the raw payload; upstream returns `null` for 3 and missing).
- [ ] RT6: a 32 KiB deeply nested schema → `schema_too_complex` without a stack overflow.
- [ ] Header: `toExtensionResponses` emits `rejectedReason` with a code, never `detail`.
- [ ] Purity: the package imports no `fs`, `net`, `process.env` or `Date` (lint rule or test).
