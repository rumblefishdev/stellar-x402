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
  - ../archive/0027_FEATURE_alerts-and-metrics/README.md
  - ../../../docs/monitoring.md
history:
  - date: "2026-11-09"
    status: backlog
    who: okarcz
    note: "Spawned from 0027's review of #150: four alarms send on-call to pool events in the app log, and the facilitator only counts them."
  - date: "2026-11-09"
    status: backlog
    who: okarcz
    note: "Narrowed to three events after Stan's review of #150: a quarantined channel is already named by settlement_submit_failed (Account not found: <channel>)."
---

# Log the pool events the alarms send people to

## Summary

`pool-health`, `settlement-expired` and `channel-held` tell on-call to look at pool events
(`sequence-resync`, `send-retry`, `fee-raised`) for the channel. The facilitator only counts them
in `pool_events_total` and logs `resolved` alone (`apps/facilitator/src/main.ts`, the submitter's
`onEvent`), so no log line names the channel. This task logs those three events.

`channel-quarantined` is not in it: the read's `Account not found: <channel>` reaches
`settlement_submit_failed` (`apps/facilitator/src/settlement/settle.ts`), which names the channel.

## Context

Found in the review of #150 (0027), which added the runbook sections. Until this task is done,
`docs/monitoring.md` and the alarm texts say the channel isn't logged and point at the counts in
`pool_events_total` instead (a `type` dimension for `sequence-resync`, Logs Insights on the EMF
lines' `type` field for the others). The events and their fields are `SubmitterEvent` in
`packages/signer-pool/src/stats.ts`.

## Implementation

- In the submitter's `onEvent` in `apps/facilitator/src/main.ts`, beside the counter, log with
  `event` set to the type and the `network`:
  - `sequence-resync` (`channel`) at `warn`;
  - `send-retry` (`channel`, `hash`, `reason`) and `fee-raised` (`channel`, `base`, `bid`,
    `queued`) at `info`.
- Keep the per-event volume in mind: `fee-raised` and `send-retry` can repeat under load, and
  `log-volume` caps the app group at 200 MB an hour. Decide whether either needs a sample or a
  per-minute summary instead.
- Point the three sections in `docs/monitoring.md` and the alarm texts in
  `infra/src/lib/alarms/settlement.ts` back at the log lines, with a Logs Insights query by
  `event` and `channel`.

## Acceptance Criteria

- [ ] Given a `sequence-resync`, `send-retry` or `fee-raised`, when it happens, then a log line
      names the channel (sampled or summarised if the volume decision says so).
- [ ] Given the three alarms' texts and runbook sections, when this is done, then each points at a
      log line that exists, and a test pins that the facilitator logs each event.
