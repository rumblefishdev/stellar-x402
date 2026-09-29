# ADR 0002: Independent implementation, no OpenZeppelin Relayer code

- Status: accepted
- Date: 2026-09-29

## Context

The free "Built on Stellar" facilitator runs on the OpenZeppelin Relayer x402 plugin. The SCF
handbook marks that code base "Do not use": it is AGPL-3.0-or-later, and AGPL's network clause
applies to a service serving third parties. The RFP requires a permissive license with no AGPL
dependencies.

## Decision

We build the facilitator independently, on the Apache-2.0 `@x402/*` packages, the x402 specs and
the public Stellar documentation. We do not use, read, port or call OpenZeppelin Relayer or
`relayer-plugin-channels` code. The channel-account pool (`packages/signer-pool`) is our own
design.

## Consequences

The signer pool, sequence tracking and retry logic are ours to build and test.
