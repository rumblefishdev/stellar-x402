---
id: "0125"
title: "Log the pool events the alarms send people to"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011"]
related_tasks: ["0027"]
tags: [facilitator, signer-pool, operations, priority-medium, effort-small, platform]
links:
  - ../active/0027_FEATURE_alerts-and-metrics/README.md
  - ../../../docs/monitoring.md
history:
  - date: "2026-11-09"
    status: backlog
    who: okarcz
    note: "Spawned from 0027's review of #150: four alarms send on-call to pool events in the app log, and the facilitator only counts them."
---

# Log the pool events the alarms send people to

## Summary

`channel-quarantined`, `pool-health`, `settlement-expired` and `channel-held` tell on-call to read
pool events in the app log for the channel and the reason. The facilitator only counts them as
`pool_events_total{type}` and logs `resolved` alone (`apps/facilitator/src/main.ts`, the
submitter's `onEvent`), so no log line names the channel. This task logs those events.

## Context

Found in the review of #150 (0027), which added the runbook sections. Until this task is done,
`docs/monitoring.md` and the four alarm texts say the channel isn't logged and point at
`pool_events_total` by `type` instead. The events and their fields are `SubmitterEvent` in
`packages/signer-pool/src/stats.ts`.

## Implementation

- In the submitter's `onEvent` in `apps/facilitator/src/main.ts`, beside the counter, log with
  `event` set to the type and the `network`:
  - `channel-quarantined` (`channel`, `reason`) at `warn`;
  - `sequence-resync` (`channel`) at `warn`;
  - `send-retry` (`channel`, `hash`, `reason`) and `fee-raised` (`channel`, `base`, `bid`,
    `queued`) at `info`.
- Keep the per-event volume in mind: `fee-raised` and `send-retry` can repeat under load, and
  `log-volume` caps the app group at 200 MB an hour. Decide whether either needs a sample or a
  per-minute summary instead.
- Point the four sections in `docs/monitoring.md` and the alarm texts in
  `infra/src/lib/alarms/settlement.ts` back at the log lines, with a Logs Insights query by
  `event` and `channel`.

## Acceptance Criteria

- [ ] Given a channel taken out of the pool, when it happens, then one app log line names the
      network, the channel and the reason.
- [ ] Given a `sequence-resync`, `send-retry` or `fee-raised`, when it happens, then a log line
      names the channel (sampled or summarised if the volume decision says so).
- [ ] Given the four alarms' texts and runbook sections, when this is done, then each points at a
      log line that exists, and a test pins that the facilitator logs each event.
