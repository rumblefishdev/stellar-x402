---
title: "Rust x402 crates on 2026-11-12, and what a Stellar seller needs from one"
type: research
status: mature
spawns: []
tags: [rust, sdk, seller, survey]
links:
  - https://github.com/qntx/r402
  - https://github.com/x402-rs/x402-rs
  - https://github.com/x402-rs/x402-rs/issues/84
  - https://github.com/x402-foundation/x402/pull/3787
  - https://github.com/sorocharge/sorocharge-core
  - https://github.com/bitrouter/x402-kit
  - https://github.com/RyanKung/rust-x402
history:
  - date: "2026-11-12"
    status: developing
    who: akot
    note: >
      Survey from crates.io, GitHub and the sources. Nothing was compiled or run: the r402 check
      against our facilitator is still to do.
  - date: "2026-11-12"
    status: mature
    who: akot
    note: >
      r402 probed against our testnet facilitator: it works. Decided all the same to write our own
      crate (akot).
---

# Rust x402 crates on 2026-11-12, and what a Stellar seller needs from one

## Result

The proposal's claim (architecture §7) no longer holds: one Rust crate supports Stellar for
sellers. `r402` 0.21.0 has a Stellar `exact` scheme for seller, buyer and facilitator, a `bazaar`
declaration and an axum layer. A probe on testnet shows it works with our facilitator and that our
catalog accepts its listing (below).

Decision (akot, 2026-11-12): part 1 is our own crate, standing alone, that does the six steps
below. r402 stays a reference and a second implementation to test against.

## What a Rust seller has to do in our system

1. An unpaid request gets 402 with the `PAYMENT-REQUIRED` header: x402 v2, `resource`, `accepts`,
   and `extensions.bazaar` when the route is to be listed.
2. `accepts` is the route's price plus what the facilitator's `/supported` says. For Stellar that is
   one field, `extra.areFeesSponsored` (ours answers `true`). Upstream's TypeScript seller scheme
   does only this and price parsing: USDC by default, 7 decimals, any SEP-41 asset by address.
3. The buyer signs a Soroban auth entry and retries with `PAYMENT-SIGNATURE`. A seller signs
   nothing and needs no Stellar SDK.
4. The seller calls `/verify`, runs the route, and calls `/settle` only when the route answered
   without an error (`examples/http-api`). The buyer gets `PAYMENT-RESPONSE` with the hash, or the
   facilitator's reason, such as our trustline reasons (0078).
5. Our facilitator catalogs on settle: it asks the seller's URL once without a payment and lists
   what the seller's own 402 says (0063, ADR 0008). So the 402's `bazaar` block must pass
   `packages/bazaar`'s `listingFromSeller`. `routeTemplate` is optional there.
6. On pubnet `/verify` and `/settle` will need `Authorization: Bearer <key>` (0105), so the crate
   must let a seller set headers per facilitator route, as upstream's `createAuthHeaders` does.

## The crates

| Crate | Version, last release | Licence | Stellar | Seller layer | `bazaar` | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `r402` (qntx) | 0.21.0, 2026-09-05 | MIT OR Apache-2.0 | `r402-stellar`: seller, buyer, facilitator | axum/tower (`r402-http`) | `r402-extensions`: declaration and discovery client | below |
| `x402-axum`, `x402-types` (x402-rs) | 2.0.2, 2026-07-13 | Apache-2.0 | none; issue #84 (2026-04-03) has no reply | axum/tower | `extensions` passed through as JSON, no helper | most used (48k and 87k downloads); `main` unchanged since 2026-07-13, at least 20 pull requests open |
| upstream Rust SDK (`x402-foundation/x402` #3787) | not merged; part 1 of 8, opened 2026-10-13 | Apache-2.0 | none (EVM, then SVM) | axum, in part 3 | none | no review yet; CI waits for a maintainer |
| `sorocharge-x402` | not on crates.io; repo from 2026-09-28 | Apache-2.0 | buyer and facilitator functions | none | none | signs auth entries, checked byte for byte against `@stellar/stellar-sdk` |
| `x402-kit` (`x402-core`, `x402-paywall`) | 2.5.0, 2026-03-18 | MIT | none | framework-agnostic paywall | none | |
| `rust-x402` | 0.3.0, 2025-12-04 | GPL-3.0 | none | | | the licence rules it out (RFP: permissive, no copyleft) |

The proposal names `rust-x402` and `x402-axum` as the crates to plug into. The first is GPL-3.0.
The second has no Stellar and its maintainer has not answered the Stellar proposal in seven months.

## r402 against the six steps

Read from the 0.21.0 sources; the probe below ran steps 1 to 5.

- Step 1: `r402-http`'s layer writes the 402; `with_extension(BazaarExtension::http_query(..))`
  adds `extensions.bazaar` with `info` and `schema`. It never writes `routeTemplate`.
- Step 2: `StellarExact::price_tag(pay_to, USDC::stellar_testnet().amount(..))`, 300 s timeout, and
  the scheme copies `areFeesSponsored` from `/supported`.
- Step 4: the default mode is verify, handler, settle; a 4xx or 5xx from the handler cancels the
  settlement (`server/gate.rs`).
- Step 6: `FacilitatorAuthHeaders` holds headers per route, in upstream's `createAuthHeaders` shape.
- A seller needs only `r402-protocol`, `r402-server`, `r402-http` and `stellar-strkey`; the XDR and
  RPC crates come in with the buyer and facilitator features.

Against it:

- One author wrote about 450 of its 480 commits. Releases 0.17 to 0.21 came between 2026-08-20 and
  2026-09-05, several marked breaking; `main` has no commit since 2026-09-13.
- `r402-stellar` has 639 downloads. Its tests use a mock server; none runs against a Stellar
  network or a real facilitator.
- MSRV 1.95, edition 2024.

## Three ways to build part 1

| | A. On r402 | B. Standalone | C. Upstream first |
| --- | --- | --- | --- |
| What we write | A small crate: one call for a Stellar route (facilitator, `payTo`, price, listing, API key), the listing checked against our limits, the example server, a live testnet test | Types, the 402 answer, a facilitator client, an axum/tower layer, the `bazaar` declaration | A Stellar scheme for `x402-rs` or for the upstream Rust SDK |
| Fits 1.0 dev-week | yes | tight | not ours to decide: neither project is merging |
| Risk | a 0.x crate with one maintainer under ours | we repeat what r402 has, and keep it | D5 has no crate in Tranche #2 |
| Grant fit | RFP asks to build on existing tooling; the proposal says "net-new" | what the proposal says | what the proposal says ("via rust-x402's or x402-axum's scheme architecture") |

Every crate with a seller layer chose axum/tower, and so does the upstream SDK. That settles the
framework for part 1.

## Probe: r402 against our testnet facilitator

2026-11-12, facilitator `https://x402-facilitator.sorobanscan.com` at commit `5d2e26ba`. The seller:
an axum server on `r402` and `r402-extensions` 0.21.0, 40 lines, one route at 0.001 testnet USDC
with a `bazaar` block, built with Rust 1.97.1. The buyer: upstream's unmodified `@x402/core`,
`@x402/fetch` and `@x402/stellar` 2.28.0. Both accounts were new, from friendbot; the buyer's USDC
came from a path payment on testnet's exchange, without Circle's faucet.

| Check | Result |
| --- | --- |
| 402 for an unpaid request | x402 v2 in `PAYMENT-REQUIRED` and in the body; `areFeesSponsored: true` copied from our `/supported` |
| `listingFromSeller` on that 402 | accepted, under a public URL; the query string dropped from the key. `localhost` is refused as `resource_not_public`, by design |
| Paid request through `wrapFetchWithPayment` | 200, `PAYMENT-RESPONSE` with hash `6bd72a6ef6a77a7dc08e501bd4849b6c28ad88cceabb51a4fd105673949412a2`; 0.001 USDC moved; our signer `GAVE5V5I…` paid the fee |
| Paid request the route answers with 400 | 400 passed on, no `PAYMENT-RESPONSE`, balances unchanged |
| The same signed payment sent twice | first 200 (hash `e7beb4bfffa294e80994cea885cb7b1c0bcd05c86a9b3bc1fba71ac8cd5beaea`); second 402 with `error: "Verification failed: invalid_exact_stellar_payload_simulation_failed"` |

Not covered: cataloging end to end (the public facilitator can't reach a seller on `localhost`),
pubnet, the API key header, any asset but USDC.

For our crate, from the probe:

- The refusal reaches the buyer as the reason code only. Our facilitator also sends a message that
  says what to do (0078's trustline reasons); our crate should pass both on.
- r402 doesn't hand the seller the facilitator's `EXTENSION-RESPONSES`, so a seller can't see
  whether its listing was cataloged. Ours can.
- `resource.url` in r402's 402 carries the request's query string. The catalog drops it, so it
  does no harm, but upstream's TypeScript middleware is the one to copy here.

## Open

- Check what upstream's TypeScript middleware puts in `resource.url` and in the 402's body, before
  ours copies r402's.
- For 0140: buyer-side signing for Stellar exists twice (`r402-stellar`'s client,
  `sorocharge-signer`), so part 2's buyer side may be a check and a guide, not new code.
