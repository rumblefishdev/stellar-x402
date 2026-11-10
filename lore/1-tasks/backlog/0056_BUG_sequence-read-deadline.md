---
id: "0056"
title: "Stop the channel sequence read at the caller's deadline"
type: BUG
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0051", "0009"]
tags: [signer-pool, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: "Spawned from 0051 future work."
---

# Stop the channel sequence read at the caller's deadline

## Summary

`SettlementSubmitter.readSequence` (`packages/signer-pool/src/submitter.ts`) retries a channel's
sequence read for `timeoutSeconds` (default 60 s; the facilitator does not override it), while
`/settle` answers at `SETTLE_BUDGET_MS` (default 30 s). During an RPC outage each `/settle` holds
a channel about 30 s after its client already got an answer. The late read never signs (`settle.ts`
refuses once the budget is over), so no money moves; channels are held longer than useful and
queued calls time out sooner. Found by the devil's-advocate review of PR #52.

This changes when a settlement gives up, so the options go to the owner before the PR.

## Implementation

- Cap the retry window at the call's own `deadline` when one is given.
- Retire a channel (a real "no entry") only after the full `timeoutSeconds`, never because the
  caller's deadline ended the window first.

## Acceptance Criteria

- [ ] Given an RPC outage and a call with a deadline, when its sequence read fails, then the call
      gives up at the deadline and the channel stays in the pool
- [ ] Given no entry for a channel, then it is still retired after `timeoutSeconds`
