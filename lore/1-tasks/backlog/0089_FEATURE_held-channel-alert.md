---
id: "0089"
title: "Show and alert on a channel held past a threshold"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011"]
related_tasks: ["0073", "0027"]
tags: [facilitator, signer-pool, observability, before-pubnet, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-29"
    status: backlog
    who: okarcz
    note: "Spawned from 0073's PR #85 review (Stan's question on channel hold time)."
---

# Show and alert on a channel held past a threshold

## Summary

Since 0073 a sent transaction that never shows up holds its channel until its ledger bound's
estimated time plus 30 s: about 426 s at the default 66 ledgers, 750 s at 120 (it was about
90 s). With two channels, two such payments during an RPC hiccup make every new `/settle` wait
for a channel until its budget ends. Nothing shows a held channel today.

## Implementation

- A metric of channels busy and of the longest hold, from the pool's stats or events.
- The CloudWatch alarm is 0027's `channel-held`, above 300 s on `channel_longest_hold_seconds`;
  this task builds that gauge (0027's alarm list, from Oskar's review of PR #111).
- The README's `CHANNELS` note names the metric.

## Acceptance Criteria

- [ ] Given a channel held past 300 s, when 0027's `channel-held` alarm checks, then it fires
