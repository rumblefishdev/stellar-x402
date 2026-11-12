---
id: "0136"
title: "Rust seller crate, part 1: answer 402 with Stellar terms and settle through a facilitator"
type: FEATURE
status: active
milestone: 2
related_adr: ["0001"]
related_tasks: ["0102", "0041", "0132"]
tags: [sdk, rust, seller, priority-high, effort-medium, platform]
links:
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
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
  integrations beyond the first, publishing to crates.io.
- The proposal's architecture (`docs/rfp/x402-facilitator-bazaar-technical-architecture.md`, §7)
  also promises the buyer side in Rust: building and signing Soroban auth entries, as
  `@x402/stellar` does in TypeScript. A seller signs nothing, so part 1 leaves it out; part 2
  builds it, or the owner drops it in writing.
- The same section says no Rust x402 crate (`rust-x402`, `x402-axum`) supports Stellar, and plans
  to plug into their scheme architecture where possible. Not checked since the proposal.

## Implementation Plan

- Survey the Rust x402 crates first (`rust-x402`, `x402-axum`, `x402-rs`): whether any supports
  Stellar now, their licences, and whether a Stellar scheme can plug into one. Record whether part
  1 builds on one of them or stands alone.
- Decide the crate's place in the monorepo, its name, and the one HTTP framework part 1 supports.
- Build the 402 answer: `PaymentRequirements` for `exact` on `stellar:testnet` and
  `stellar:pubnet`, with an optional `bazaar` extension block.
- Call the facilitator's `/verify` and `/settle` and map their answers.
- An example server that charges for one route.

## Acceptance Criteria

- [ ] Given a request without a payment, when the example server answers, then it returns 402 with
      valid x402 v2 payment terms for Stellar, and a `bazaar` block when configured
- [ ] Given a paid request from an unmodified x402 client, when the server handles it, then it
      verifies and settles through our testnet facilitator and serves the resource
- [ ] Given a paid request the route answers with an error status, when the server handles it,
      then the payment is verified but not settled, as in `examples/http-api`
- [ ] Given a payment the facilitator refuses, when the server answers, then the buyer gets the
      facilitator's reason
- [ ] The testnet run's transaction hash is recorded for 0132
- [ ] The crate is Apache-2.0, its dependencies pass the licence audit, and CI builds and tests it
- [ ] The task lists what is left for part 2, the buyer-side signing among it or dropped in
      writing
