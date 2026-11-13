---
id: "0140"
title: "Rust crate, part 2: upto, the buyer side, more frameworks and crates.io"
type: FEATURE
status: backlog
milestone: 3
related_adr: ["0001"]
related_tasks: ["0136", "0015", "0034", "0041", "0102"]
tags: [sdk, rust, seller, priority-medium, effort-medium, platform]
links:
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
  - ../../../docs/rfp/x402-facilitator-bazaar-technical-architecture.md
history:
  - date: "2026-11-12"
    status: backlog
    who: akot
    note: >
      Spawned from 0136 when it started: the Milestone 2 plan carries the crate's second half to
      Tranche #3, and no task held it.
---

# Rust crate, part 2: upto, the buyer side, more frameworks and crates.io

## Summary

As a Rust developer, I want the crate from 0136 to cover `upto`, to pay as well as charge, to fit
my web framework and to install from crates.io, so that the Rust SDK the proposal describes is
complete.

## Context

- The Panel Review response splits the Rust crate in two: part 1 in Tranche #2 (0136), part 2 in
  Tranche #3. 0136 is a seller's paid request with `exact` on one framework.
- The proposal's architecture (§7) describes the Rust SDK as a Stellar scheme plugin that builds
  and signs Soroban auth entries, as `@x402/stellar` does in TypeScript. That is the buyer side,
  and 0136 leaves it out.
- `upto` in Rust needs what TypeScript needs first: the facilitator settling `upto` (0015) and
  the accepted scheme spec (0034). If either is late, the `upto` part waits and the rest ships.
- 0136 closes with a list of what it left for part 2 and a record of whether the crate builds on
  an existing Rust x402 crate. Read both before planning: they may add to or cut this scope.

## Implementation Plan

- Read 0136's leftovers and its crate survey; correct this task's scope and effort.
- Seller side: answer 402 with `upto` terms and settle the actual amount after the route answers.
- Seller side: settle after the route's whole body, not once its status and headers are ready.
  Part 1 settles before the body is sent, so a streamed body that breaks halfway is still paid
  for; upstream's middleware holds every write until the body ends. Hold the body (with a size
  limit, and a way out for a route that must stream), or say in writing why part 1's order
  stays. From 0136's self-review of #177.
- Seller side: whether to ask `/settle` again after the facilitator's `Retry-After` on 503
  `no_lease` or `shutting_down` (a deploy, nothing sent). Part 1 answers as `@x402/express` does,
  402 after the route ran (akot, 2026-11-13); asking again saves the sale and answers otherwise
  than TypeScript.
- Keep the crate's answers equal to the newest `@x402/express` (0136 decision 23), with upstream's
  check of a payment's echoed extensions (`extension_echo_mismatch`), the one check part 1 lacks.
- Buyer side: build and sign the Soroban auth entry for `exact`, and for `upto` if 0015 and 0034
  allow; pay a 402 from a Rust client. Or the owner drops the buyer side in writing.
- Integrations for the frameworks beyond part 1's, chosen from what Rust sellers use.
- Publish to crates.io: name, owner account, version policy, docs.rs page, a release step in CI.
- A guide page for Rust sellers next to the TypeScript one.

## Acceptance Criteria

- [ ] Given a route priced with `upto`, when an unmodified x402 client pays it, then the server
      settles the actual amount through our facilitator, and the run's transaction hash is
      recorded for the Tranche #3 evidence
- [ ] Given a 402 from a Stellar seller, when the Rust client pays it with `exact`, then our
      facilitator settles the payment on testnet, and a test covers the signed entry against one
      `@x402/stellar` builds from the same input; or the buyer side is dropped in writing
- [ ] Given each framework the task names, when its example server runs, then it charges for a
      route as part 1's example does
- [ ] Given a paid route whose streamed body breaks before it ends, when the server answers, then
      nothing is settled, as with upstream's middleware; or the README says why it still is
- [ ] The crate is on crates.io under Apache-2.0, its docs build on docs.rs, and a release is one
      documented step
- [ ] The dependencies pass the licence audit, and CI builds and tests every feature
- [ ] The seller guide has a Rust page that a new seller can follow to a paid request on testnet
