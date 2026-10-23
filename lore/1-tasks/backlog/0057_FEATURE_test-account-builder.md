---
id: "0057"
title: "One test account builder, and checkChannel tests for every signer kind"
type: FEATURE
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0051", "0020"]
tags: [tests, signer-pool, priority-low, effort-small]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: "Spawned from 0051 future work."
---

# One test account builder, and checkChannel tests for every signer kind

## Summary

Two builders make a test `xdr.AccountEntry`: `accountEntry` in `packages/signer-pool/src/testing.ts`
(0051) and `accountEntry` in `apps/facilitator/test/rpc-stub.ts` (0020), which also sets the
master key weight. And `checkChannel` has tests only for ed25519 signers: a pre-auth tx, hash-x or
signed-payload signer is reported as `extra-signer` today, but no test would catch a rewrite that
accepts them. Both found by the reviews of PRs #51 and #52. Tests only (`[low risk]`).

## Implementation

- Give signer-pool's `accountEntry` the master weight (or thresholds), and use it from
  `rpc-stub.ts` and the facilitator's channel-check tests.
- Add one `checkChannel` test per non-ed25519 signer kind.

## Acceptance Criteria

- [ ] One account builder in the repo's tests
- [ ] Each non-ed25519 signer kind with weight above 0 is reported `extra-signer` by a test
