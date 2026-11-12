---
id: "0136"
title: "Rust seller crate, part 1: answer 402 with Stellar terms and settle through a facilitator"
type: FEATURE
status: active
milestone: 2
related_adr: ["0001"]
related_tasks: ["0102", "0041", "0132", "0140"]
tags: [sdk, rust, seller, priority-high, effort-medium, platform]
links:
  - ../../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-11-12"
    status: backlog
    who: claude
    note: >
      Created with okarcz from the Milestone 2 plan. A Tranche #2 line item (1.0 dev-week) with no
      task until now; part 2 is Tranche #3.
  - date: "2026-11-12"
    status: backlog
    who: akot
    note: >
      Added before starting: a survey of the existing Rust x402 crates as the first step, the
      proposal's buyer-side signing named as part 2's, and a criterion that a failed route is not
      settled.
  - date: "2026-11-12"
    status: active
    who: akot
    note: "Work starts: track 3 of the Milestone 2 plan."
---

# Rust seller crate, part 1: answer 402 with Stellar terms and settle through a facilitator

## Summary

As a seller with a Rust service, I want a crate that answers a request with x402 payment terms for
Stellar and checks the payment through a facilitator, so I can charge for an endpoint without
writing the protocol myself.

## Context

- The RFP asks for "SDK helpers for sellers, buyers, and agents". The Panel Review response splits
  the Rust seller crate, which is new, in two: part 1 in Tranche #2, part 2 in Tranche #3. The
  TypeScript helpers are 0102.
- Nothing in the repo is Rust outside `contracts/`. ADR 0001 keeps the SDK in this monorepo.
- Part 1 is the paid request end to end with `exact`. Left for part 2: `upto`, framework
  integrations beyond the first, publishing to crates.io. Part 2 is 0140.
- The proposal's architecture (`docs/rfp/x402-facilitator-bazaar-technical-architecture.md`, §7)
  also promises the buyer side in Rust: building and signing Soroban auth entries, as
  `@x402/stellar` does in TypeScript. A seller signs nothing, so part 1 leaves it out; part 2
  builds it, or the owner drops it in writing.
- The same section says no Rust x402 crate (`rust-x402`, `x402-axum`) supports Stellar, and plans
  to plug into their scheme architecture where possible. No longer true: `r402` does, and works
  with our facilitator ([R-rust-x402-crates](notes/R-rust-x402-crates.md)).

## Implementation Plan

- Survey the Rust x402 crates first (`rust-x402`, `x402-axum`, `x402-rs`): whether any supports
  Stellar now, their licences, and whether a Stellar scheme can plug into one. Record whether part
  1 builds on one of them or stands alone. Done: it stands alone (akot, 2026-11-12), on axum/tower,
  and does the six steps of the note.
- Decide the crate's place in the monorepo, its name, and the one HTTP framework part 1 supports.
  Done: decisions 1 to 3 below.
- Build the 402 answer: `PaymentRequirements` for `exact` on `stellar:testnet` and
  `stellar:pubnet`, with an optional `bazaar` extension block.
- Call the facilitator's `/verify` and `/settle` and map their answers.
- An example server that charges for one route.

## Implementation Notes

`packages/sdk/rust`, crate `stellar-x402`, PR #177:

- `src/terms.rs`, `price.rs`, `network.rs`: the 402 answer and its terms.
- `src/bazaar.rs`: the `bazaar` block, for query and JSON-body routes.
- `src/payment.rs`: the buyer's payment from `PAYMENT-SIGNATURE`, matched to the terms by
  upstream's rule.
- `src/facilitator.rs`: `/supported`, `/verify`, `/settle`, the API key, `EXTENSION-RESPONSES`.
- `src/axum.rs` (feature `axum`, on by default): `PaymentGate` and the layer.
- `examples/weather.rs`: the example server, the twin of `examples/http-api`.
- 62 tests with the feature, 45 with `--no-default-features`; the layer's run a seller and a fake facilitator on local
  ports. CI job `sdk-rust`.

### Testnet run, 2026-11-12

`examples/weather.rs` against `https://x402-facilitator.sorobanscan.com` (commit `5d2e26ba`), paid
by upstream's unmodified `@x402/core`, `@x402/fetch` and `@x402/stellar` 2.28.0. For 0132 (D5):

| Check | Result |
| --- | --- |
| The 402 | equal, field for field, to the 402 of `examples/http-api` for the same route and seller |
| Paid request | 200, `e1ce215ff1d83658dbb64e3e0c46d7cb4aedcb172dfc9f8eda1de810b1cd40e4`, 0.001 USDC moved, our signer paid the fee |
| Route answers 400 | 400, nothing settled, balances unchanged |
| The same payment twice | 200 with `b831d67e60389ad432746fbd46a235dd8c3fe30a5091e14d96290a5246a56afc`, then 402 `invalid_exact_stellar_payload_simulation_failed` |
| The catalog's answer | the seller's log shows `{"rejectedReason":"resource_not_public","status":"rejected"}`: the seller ran on `localhost` |

The buyer script and the two friendbot accounts were one-off and are not in the repo. Not run: a
listing cataloged end to end (it needs a seller on a public address), pubnet, an API key against a
facilitator that asks for one (0105 is not built).

## Left for part 2 (0140)

- `upto`, and the buyer's side.
- Frameworks beyond axum; the core is already free of it.
- Publishing to crates.io, and the release's Rust version.
- Path parameters and `routeTemplate` in a listing; `form-data` and `text` bodies; MCP tools.
- Upstream's check that a payment's echoed extensions match the advertised ones
  (`extension_echo_mismatch`). Our catalog reads the seller's own 402 (0063), so it does not
  depend on it.
- More than one way to pay for a route (`accepts` holds one).
- Settling before the route runs (upstream's `upfront` flow), and a retry of `/supported` on 429.
- A live test in the repo: a buyer script next to the crate, with accounts as the MCP e2e run
  takes them.

## Design Decisions

### From Plan

1. **Place: `packages/sdk/rust`** (akot, 2026-11-12), since ADR 0001 keeps the SDK helpers in
   `packages/sdk`. A crate of its own, outside `contracts/`, which builds WASM with its own
   release profile and a toolchain pinned for the WASM hash. The folder has no `package.json`, so
   pnpm passes it by; the TypeScript helpers (0102) take `packages/sdk` itself or a folder next
   to `rust`.
2. **Name: `stellar-x402`** (akot, 2026-11-12), the repo's and the npm scope's name. Without
   `seller` in it, so part 2's buyer side needs no second crate. Free on crates.io on 2026-11-12.
3. **Shape: one crate, the core free of any framework, the axum/tower layer behind the feature
   `axum`** (akot, 2026-11-12). The feature is on by default (akot, 2026-11-12): while axum is the
   only framework nearly every seller wants it, and `default-features = false` still leaves it out.
4. **Stands alone, not on `r402`** (akot, 2026-11-12), though the probe shows `r402` works with our
   facilitator ([R-rust-x402-crates](notes/R-rust-x402-crates.md)).

### Emerged

5. **The 402 answer is held equal to upstream's.** A fixture captured from `examples/http-api`
   (`@x402/express` 2.28.0) is what the answer's test compares with, so `resource.url` keeps the
   query string and `error` reads "Payment required", as upstream sends them.
6. **A USDC price is read as text, never as a float**, and refused when it has more than 7
   decimals, is zero or is not plain digits. Upstream's TypeScript takes a number.
7. **Rust 1.81 is the oldest supported**, edition 2021, checked in CI next to the 1.97.1 build.
   1.81 is what was at hand to check with; raise it when a dependency needs more.
8. **`publish = false` until 0140** decides the release.
9. **`payTo` and a token's contract are checked when terms are made** (`stellar-strkey`), so a
   mistyped address stops the seller at start. The error leaves the address out: it may be a
   secret key pasted by mistake.
10. **A refusal's message goes in the 402's body, not in `PAYMENT-REQUIRED`.** The header's
    `error` stays the reason code, as upstream sends it; the body is
    `{"error": reason, "message": message}`. Upstream's middleware and `r402` drop the message.
11. **The seller learns the catalog's answer through `PaymentGate::on_event`**, which also carries
    refusals and facilitator failures. No logging crate is pulled in; the seller logs as it likes.
12. **A facilitator that gives no answer to act on is 502 `facilitator_unavailable` to the buyer**,
    at verify and at settle, without the cause: it may be the seller's own, such as its API key.
    Upstream answers 402 for most of these.
13. **`/supported` is read once, when the gate is made**, and a route on a network the
    facilitator does not settle on is refused then. Upstream's client retries a 429 there three
    times; ours does not.
14. **The API key goes to `/verify` and `/settle` only**, as `Authorization: Bearer` (0105);
    `/supported` is open.
15. **The oldest Rust holds with `Cargo.lock`'s versions.** The newest `idna_adapter`,
    `stellar-strkey` 1.0 and others need 1.82 to 1.87, so `.cargo/config.toml` keeps `cargo update`
    on versions that fit, and CI checks 1.81 with `--locked`. A seller on 1.81 needs the same
    setting.
16. **`webpki-roots` is under CDLA-Permissive-2.0**, a permissive data licence the M1 audit's list
    does not have (it comes with `reqwest`'s rustls). The other 158 crates in the lockfile are
    MIT, Apache-2.0, BSD, ISC, Zlib, Unicode or a choice that includes one. For 0132's licence
    review.

## Acceptance Criteria

- [x] Given a request without a payment, when the example server answers, then it returns 402 with
      valid x402 v2 payment terms for Stellar, and a `bazaar` block when configured
- [x] Given a paid request from an unmodified x402 client, when the server handles it, then it
      verifies and settles through our testnet facilitator and serves the resource
- [x] Given a paid request the route answers with an error status, when the server handles it,
      then the payment is verified but not settled, as in `examples/http-api`
- [x] Given a payment the facilitator refuses, when the server answers, then the buyer gets the
      facilitator's reason
- [x] The testnet run's transaction hash is recorded for 0132
- [x] The crate is Apache-2.0, its dependencies pass the licence audit, and CI builds and tests it
      (licences: decision 16, with `webpki-roots` to confirm in 0132; CI: job `sdk-rust` passed on
      PR #177)
- [x] The task lists what is left for part 2, the buyer-side signing among it or dropped in
      writing
