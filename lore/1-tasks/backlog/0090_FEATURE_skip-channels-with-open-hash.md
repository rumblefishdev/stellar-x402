---
id: "0090"
title: "After a deploy, don't send on a channel the last process left a transaction open on"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011", "0006"]
related_tasks: ["0073", "0026", "0025"]
tags: [facilitator, signer-pool, deploy, before-pubnet, priority-medium, effort-medium]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: okarcz
    note: >
      Spawned from 0073's PR #85 review (Stan's question on the drain): needed before pubnet.
---

# After a deploy, don't send on a channel the last process left a transaction open on

## Summary

The drain stops at 150 s, while since 0073 a sent transaction stays valid until the payer's auth
expires (about 426 s at the default). A deploy during traffic then leaves one open, and the new
process's sends on that channel may fail with `txBadSeq` and rebuild until it lands or expires:
minutes, not about 60 s. ADR 0011 records it; accepted for testnet, not for pubnet. The config
refuses `NETWORK=stellar:pubnet` until this task and 0024 land: whichever lands last lifts the
rule, the other narrows its message (`config.ts`, 0071 decision 14).

## Implementation

- At startup, and until reconciliation ends them, the pool leaves out a channel whose record has
  a hash with a ledger bound not yet passed (the store holds both).
- A test across two processes: the second sends nothing on the held channel until the record
  ends, and uses the other channels meanwhile.

## Acceptance Criteria

- [ ] Given a transaction the previous process left open on a channel, when the new process
      takes the lease, then it sends on that channel only once the record is final
