---
id: "0110"
title: "Cap a reconcile sweep's time"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011"]
related_tasks: ["0027", "0019"]
tags: [facilitator, settlement, priority-low, effort-small, platform]
links:
  - ../active/0027_FEATURE_alerts-and-metrics/notes/G-alarm-list.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0027's deferred list (Oskar's review of PR #111), first noted in 0019's code review."
---

# Cap a reconcile sweep's time

## Summary

A sweep has no overall time cap. When the RPC fails for every record, N open records take about
N × the RPC timeout ÷ 4, and the next sweep waits for it. 0027 deferred a cap until there are real
backlog sizes, so this task keeps it from being lost when 0027 is archived.

## Context

- From 0019's code review, carried in 0027's Implementation.
- 0027's `sweeps-stopped` alarm fires when no sweep lists the records for 5 minutes, and `pending`
  when the oldest open record passes 900 s, so a slow sweep is seen. This task is about bounding
  it.

## Implementation

- Read the open-record counts and sweep times from the first weeks of 0027's metrics and logs.
- Choose a cap from them, and decide what a capped sweep leaves for the next one.

## Acceptance Criteria

- [ ] Given a backlog of open records and an RPC failing for each, when a sweep runs, then it ends
      within the cap and the next sweep starts on time
