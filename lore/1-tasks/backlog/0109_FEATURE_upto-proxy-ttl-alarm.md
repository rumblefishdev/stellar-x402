---
id: "0109"
title: "Alarm on the UptoProxy's TTL before it is archived"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011"]
related_tasks: ["0027", "0035"]
tags: [facilitator, monitoring, upto, priority-low, effort-small, platform]
links:
  - ../active/0027_FEATURE_alerts-and-metrics/notes/G-alarm-list.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0027's deferred list (Oskar's review of PR #111), first added to 0027 from 0035's future work."
---

# Alarm on the UptoProxy's TTL before it is archived

## Summary

An archived UptoProxy instance or code stops `upto` settlement until someone restores it. Nothing
reads its TTL today. 0027 deferred the alarm, since `upto` doesn't reach `/settle` yet, so this
task keeps it from being lost when 0027 is archived.

## Context

- From 0035, carried in 0027: settlements hold a used proxy's TTL at or just under
  `TTL_EXTEND_TO` (518,400 ledgers), so an alarm at that value would stay on.
- 0027's off-server check is where it runs: it already reads the network every 5 minutes, off the
  server.

## Implementation

- Start once `upto` reaches `/settle` and the deployed config names the proxy.
- In the off-server check, read the proxy's instance and code TTL in ledgers, and publish the
  lower one.
- Alarm well below `TTL_EXTEND_TO`, for example under 14 days of ledgers, with the message naming
  `stellar contract extend` as the fix.

## Acceptance Criteria

- [ ] Given a proxy whose instance or code TTL falls below the threshold, when the off-server
      check runs, then an alarm fires with the extend step
- [ ] Given a proxy kept extended by settlements, when the check runs, then it doesn't fire
