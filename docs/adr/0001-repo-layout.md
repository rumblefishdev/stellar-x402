# ADR 0001: One monorepo plus upstream forks

- Status: accepted
- Date: 2026-09-29

## Context

The project ships a facilitator, the Bazaar, an MCP server, SDK helpers, a Soroban contract,
examples, a conformance report and docs. Most of it shares types and config and is released
together. Some work must land in other repos: the `upto` scheme in `x402-foundation/x402` and
the developer guide in `stellar/stellar-docs`.

## Decision

- One pnpm monorepo, `stellar-x402`, in our GitHub org, Apache-2.0.
- SDK helpers live in our own package, `packages/sdk`.
- The `UptoProxy` contract lives in `contracts/upto-proxy`. We offer it to upstream
  `contracts/stellar/` once the x402 Technical Steering Committee agrees.
- Upstream work happens in forks: `x402-foundation/x402` for `scheme_upto_stellar.md` and the
  `upto` scheme classes, and `stellar/stellar-docs` for the developer guide.
- The service depends on the published `@x402/*` npm packages, not on the fork.

## Consequences

One CI setup and one place for reviewers to look. Packages can still be published separately.
Until the upstream `upto` release ships, the monorepo uses a local build of the fork.
