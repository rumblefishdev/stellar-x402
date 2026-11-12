---
id: "0136"
title: "Rust seller crate, part 1: answer 402 with Stellar terms and settle through a facilitator"
type: FEATURE
status: active
owner: akot
milestone: 2
related_adr: ["0001"]
related_tasks: ["0102", "0041", "0132", "0140", "0145"]
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
- `src/facilitator.rs`: `/supported`, `/verify`, `/settle` (asked once more on a
  `settlement_pending` with a hash), the API key, `EXTENSION-RESPONSES`.
- `src/axum.rs` (feature `axum`, on by default): `PaymentGate` and the layer.
- `examples/weather.rs`: the example server, the twin of `examples/http-api`.
- 108 tests with the feature, 67 with `--no-default-features`; the layer's run a seller and a fake
  facilitator on local ports. CI job `sdk-rust`.

### Parity run, 2026-11-13

The TypeScript twin (`examples/http-api`, on `@x402/express`, `@x402/core`, `@x402/stellar` and
`@x402/extensions` 2.31.0 in a scratch copy) and `examples/weather.rs`, behind one fake
facilitator, got the same 45 requests: every answer our facilitator gives (`app.ts`,
`rate-limit.ts`, `settle.ts`: verdicts, 400, 401, 413, 429, 500, 503 `rpc_unavailable`,
`no_lease`, `shutting_down`, `settlement_pending` with and without a hash, `already_settled`, a
dropped connection, an answer over 1 MiB) and the buyer's own cases (no payment, other terms, an
unreadable header, a browser, HEAD). Compared: status, `Cache-Control`, `PAYMENT-REQUIRED`,
`PAYMENT-RESPONSE`, body and the calls the facilitator got. 43 are equal; OPTIONS and POST on a
GET route differ, the frameworks' own answers (express 200 and 404, axum 405) with no x402 in
them. Express adds `; charset=utf-8` to `Content-Type`, `ETag` and `X-Powered-By`, not compared.
The script was one-off and is not in the repo (akot, 2026-11-13).

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
| A listing cataloged, on a public address | the seller behind a Cloudflare quick tunnel (`PUBLIC_URL`), at the crate's commit `0ea941a2`: 200, `dd6113e23a83e4ba0d820cd3f5259b87724439bdb61c1c3a030c08a50812579a`, 0.001 USDC moved; the seller's log shows `{"status":"processing"}`, and `/discovery/resources` then lists `https://back-pvc-missions-bench.trycloudflare.com/weather` with the route's terms and `bazaar` block |

The buyer script and the two friendbot accounts were one-off and are not in the repo. The tunnel
is closed, so the listing it left in testnet's catalog names a dead address. Not run: pubnet, an
API key against a facilitator that asks for one (0105 is not built).

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
- A buyer who disconnects: verify, the route and settle run inside the request's future, which
  hyper drops with the connection. Dropped during `/settle`, the money may move with no event;
  dropped after the route ran, its work is not paid for. Settling on a task of its own adds
  `tokio` to the layer. The README says so (review of #177).
- An event that names its route, for a seller with more than one paid route; a muxed `payTo`
  (`M…`), accepted as terms with no run that settles one.
- The facilitator's `Retry-After` on 429 and 503. `/settle` answers 503 `no_lease` or
  `shutting_down` during a deploy, with nothing sent: the buyer gets 402 after the route ran, as
  from `@x402/express`, which asks no more (akot, 2026-11-13). Asking again after `Retry-After`
  would save the sale and answer otherwise than TypeScript.
- Settling after the whole body. The layer settles once the route's answer has its status and
  headers, so a streamed body that breaks halfway is still paid for (a probe: 200,
  `PAYMENT-RESPONSE`, then a body that ends early). Upstream's middleware holds every write until
  the body ends and settles after it. The README and the layer's rustdoc say so (self-review of
  #177).

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
   query string and `error` reads "Payment required", as upstream sends them. 2.31.0 sends the
   same terms (parity run); every other answer follows decision 23.
6. **A USDC price is read as text, never as a float**, and refused when it has more than 7
   decimals, is zero or is not plain digits. Upstream's TypeScript takes a number.
   `Price::token` takes base units and refuses zero and an amount above `i128` the same way.
7. **Rust 1.81 is the oldest supported**, edition 2021, checked in CI next to the 1.97.1 build.
   1.81 is what was at hand to check with; raise it when a dependency needs more.
8. **`publish = false` until 0140** decides the release.
9. **`payTo` and a token's contract are checked when terms are made** (`stellar-strkey`), so a
   mistyped address stops the seller at start. The error leaves the address out: it may be a
   secret key pasted by mistake.
10. **A refusal's message goes to the seller, not the buyer** (akot, 2026-11-13, by decision 23;
    the first version put it in the body as `{"error", "message"}`). The 402's body is
    `{"error": reason}`, as `@x402/core` 2.31.0 writes it; the message reaches `on_event`.
11. **The seller learns the catalog's answer through `PaymentGate::on_event`**, which also carries
    the facilitator's refusals and its failures. The gate's own refusals (an unreadable header,
    a payment for other terms) send no event; a variant for them is part 2's. No logging crate is pulled in; the seller logs as it likes.
12. **A facilitator that fails is answered as `@x402/express` 2.31.0 answers it** (akot,
    2026-11-13, by decision 23; the first version answered 502 `facilitator_unavailable` without
    the cause). An error status, or no answer at all (`fetch failed`), is 402 with upstream's
    message in `error`, the cause included: a key problem reads
    `Facilitator verify failed (401): {"error":"invalid_api_key"}`. At settle it is 402 with a
    failed `PAYMENT-RESPONSE` and an empty body. An answer that is not JSON, fails upstream's
    schema or comes too late is its `FacilitatorResponseError`: 502 `{"error": message}`. For the
    seller's events a 400 or a 413 from `/verify` stays a refusal, `VerifyRefused`: the seller's
    terms passed its own checks and are small, so what the facilitator could not read, or would
    not take for its size, is the buyer's payment, and a buyer must not be able to raise the
    seller's count of facilitator failures (review of #177). The 413 is our facilitator's body
    limit (`BODY_LIMIT_BYTES`, 64 KiB) on a buyer's copy of the terms with a 70 KB payload, which
    hyper takes as a header (self-review of #177).
13. **`/supported` is read once, when the gate is made**, and a route on a network the
    facilitator does not settle on is refused then. Upstream's client retries a 429 there three
    times; ours does not.
14. **The API key goes to `/verify` and `/settle` only**, as `Authorization: Bearer` (0105);
    `/supported` is open. The client's debug output says that a key is set, never the key.
15. **The oldest Rust holds with `Cargo.lock`'s versions.** The newest `idna_adapter`,
    `stellar-strkey` 1.0 and others need 1.82 to 1.87, so `.cargo/config.toml` keeps `cargo update`
    on versions that fit, and CI checks 1.81 with `--locked`, with the layer and without it.
    Cargo reads that setting from 1.84 on: cargo 1.81 resolving alone picks `idna_adapter` 1.2.2,
    cargo 1.97 with the setting 1.2.0 (checked 2026-11-13). A seller on 1.81 sets
    `rust-version = "1.81"`, resolves with cargo 1.84 or newer and
    `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`, and builds with 1.81; without
    `rust-version` the resolver aims at the cargo it runs on. The README says so. CI's other
    cargo steps are `--locked` too, so a stale lockfile fails there.
16. **`webpki-roots` is under CDLA-Permissive-2.0**, a permissive data licence the M1 audit's list
    does not have (it comes with `reqwest`'s rustls). The other 158 crates in the lockfile are
    MIT, Apache-2.0, BSD, ISC, Zlib, Unicode or a choice that includes one. For 0132's licence
    review.
17. **`route_layer`, not `layer`, in every example** (review of #177). axum's
    `MethodRouter::layer` also wraps its fallback for a method the route does not have, so an
    `OPTIONS` preflight or a `POST` got 402, and a paid `POST` cost a `/verify` call before its
    405. A test holds the 405.
18. **The facilitator client follows no redirect.** A 307 or 308 would send the buyer's signed
    payment to another address, and a 301 turns the POST into a GET; a 3xx is a `Status` error,
    answered as decision 25 says. `packages/seller-fetch` refuses redirects for the same reason.
19. **A paid answer's `Cache-Control` gets `private` added to the route's own**, as upstream's
    `withPrivateCacheControl` does, in place of being set only when the route set none.
20. **The public error and event enums are `#[non_exhaustive]`** (`GateError`, `PaymentEvent`,
    `FacilitatorError`, `PaymentHeaderError`, `AddressError`, `PriceError`), free while the crate
    is unpublished, so part 2's variants break no seller's `match`.
21. **The README installs the crate from git, `branch = "develop"`**, since `publish = false` and
    `main` has it only after the release; a git dependency on the monorepo resolves (checked
    with cargo 1.97). The layer is for axum 0.8.
22. **A `settlement_pending` with a transaction hash is asked for once more**
    (self-review of #177), as `@x402/core`'s `settleWithPendingRetry` does. Our facilitator
    answers it when its settle budget runs out after the transaction was sent, and answers the
    repeat with how the transaction ended (`settle.ts`, `SETTLE_TIMEOUT_MS`). Without the repeat
    the buyer got 402 while the transaction landed. In `Facilitator::settle`, so a seller without
    the layer gets it too. One repeat only, and none without a hash, as upstream; a second
    `settlement_pending` is `SettleRefused` and 402.
23. **Every answer to the buyer is `@x402/express` 2.31.0's, the newest upstream** (akot,
    2026-11-13): "the Rust SDK answers as the TypeScript one, and handles everything our
    facilitator answers". 2.31.0 came out on 2026-11-12; the repo's TypeScript is on 2.28.0 and
    0145 raises it. From 2.31 the crate also takes: a 402 with an `error` repeats it in the body,
    HEAD on a GET route is paid for, the `bazaar` block names a method its input can take (GET
    for a query, POST for a body), and a browser without a payment gets upstream's fallback HTML
    page. The parity run holds it. Not a permanent test (akot, 2026-11-13). Two differences stay,
    both under "Left for part 2": upstream's check of a payment's echoed extensions, and settling
    after the whole body.
24. **The facilitator's answers are read as `HTTPFacilitatorClient` 2.31.0 reads them**: at most
    1 MiB; a 2xx answer checked against `verifyResponseSchema` and `settleResponseSchema` (a
    settlement needs `transaction` and `network`); error text cut by `responseExcerpt`; a verdict
    sent with an error status never valid (`VerifyError`, `SettleError`, the latter's
    `PAYMENT-RESPONSE` without the fields the answer lacked); a `PAYMENT-RESPONSE` with only the
    schema's fields, the rest kept for the seller in `SettleResponse::other`; `description` and
    `mimeType` always sent, empty when unset. Inside a verdict with an error status, a value of
    the wrong type (a number as the reason) may be worded otherwise than JavaScript writes it.
25. **Redirects stay unfollowed** (decision 18), the one place the crate is stricter than
    upstream, which follows them: a 3xx is answered as an error status, 402
    `Facilitator verify failed (307): …`.
26. **Our facilitator's own code reaches the seller**: `VerifyResponse::extra`, such as
    `reason: channel_account` next to upstream's `invalid_exact_stellar_payload_channel_account`.
    Upstream's middleware passes nothing of it on.

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
