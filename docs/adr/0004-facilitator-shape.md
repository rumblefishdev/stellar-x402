# ADR 0004: One facilitator service; upstream verifies, we settle

- Status: accepted
- Date: 2026-10-07

## Context

Tranche 1 needs a testnet facilitator (`/verify`, `/settle`, `/supported`), the channel-account
pool in the settle path ([ADR 0003](0003-settlement-channel-account-pool.md)), and the Bazaar
foundation (`/discovery/resources` and cataloging). Before this ADR, only
`packages/signer-pool`, `packages/config` and `contracts/upto-proxy` contained code. The
facilitator app was a placeholder.

`@x402/stellar` ships `ExactStellarScheme` for the facilitator role. Its public methods are
`verify()` and `settle()`. `settle()` builds a transaction with the facilitator as source,
submits it itself, and reports `failed` on timeout. All the detailed checks (simulation, auth
entries, events) are private. The RFP asks us to build on `@x402/stellar` rather than
reimplement verify and settle.

## Decision

- **A modular monolith with ports and adapters.**
  - `apps/facilitator` is the only deployable service and the only composition root. It owns
    HTTP, environment and secrets, store adapters, rate limiting and wiring.
  - `packages/*` are libraries that take their dependencies through constructors. They never
    read `process.env` and never open a store or socket themselves.
  - `packages/config` is the leaf of the dependency graph.
- **Upstream verifies.** `/verify` uses `ExactStellarScheme.verify()`. Signature, auth scope,
  `Address`/`AddressV2` credentials, simulation and event checks stay upstream's job. We add only
  the channel-address check ([ADR 0005](0005-channel-accounts-as-facilitator-source.md)) and a
  minimum remaining validity ([ADR 0006](0006-settlement-record.md)).
- **We settle.** `/settle` calls upstream `verify()` again (the spec requires settle to verify
  independently), then submits through `SettlementSubmitter` in `packages/signer-pool`. The
  spec's balance-change check runs in the pool's `checkSimulation` hook. Upstream `settle()` is
  never called, and nothing else in the service calls `sendTransaction`.
- **State only through ports the facilitator owns.** These are `SettlementStore`,
  `CatalogStore`, `RateLimitStore` and `SpendStore`, each with an in-memory fake for tests. The
  backing store is chosen by task 0013.
- **Cataloging never blocks settle.** It starts only after a settlement succeeds, runs
  fire-and-forget, and its errors never reach the caller
  ([ADR 0008](0008-bazaar-catalog-integrity.md)).

## Rationale

- **The pool would otherwise ship unused.** It is a funded Tranche 1 line item, so the gate's
  settled transaction should come from it.
- **Thin wrapper rejected.** Wrapping upstream's `settle()` would bypass the pool, contradict
  ADR 0003, and turn timeouts into failures instead of `settlement_pending`.
- **Verification stays with upstream.** Reusing its `verify()` keeps us in step with
  `scheme_exact_stellar.md` as it changes, and keeps the RFP's "build on existing tooling".
- **One service fits Tranche 1.** The RFP architecture already describes one facilitator
  service, not microservices, and the workspace dependencies already point this way.
- **Ports let 0013 and 0014 decide later.** The store and hosting choices can come after the
  code exists, without rework.

## Alternatives considered

- **Thin wrapper around upstream `ExactStellarScheme`.** Fastest way to the gate, but it
  bypasses the pool (ADR 0003) and has no `pending` path. Rejected.
- **Upstream wrapper now, pool later.** Reopens ADR 0003 and delivers the pool unused in
  Tranche 1. Rejected.
- **Separate services** (for example Bazaar in its own process). No current need; it adds
  deployment and consistency cost. Rejected for now.

## Consequences

- Our settle path must stay in step with the spec's settle rules; upstream updates to `verify()`
  come for free.
- `apps/facilitator` holds all I/O policy, which keeps the libraries easy to test.
- Upstream `ExactStellarScheme` must be constructed with our fee values
  ([ADR 0007](0007-fee-abuse-containment.md)), so verify and settle apply the same ceiling.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-1, AD-3, AD-7, AD-8
- [ADR 0003](0003-settlement-channel-account-pool.md)
- [`scheme_exact_stellar.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md)
- [RFP technical architecture](../rfp/x402-facilitator-bazaar-technical-architecture.md)
