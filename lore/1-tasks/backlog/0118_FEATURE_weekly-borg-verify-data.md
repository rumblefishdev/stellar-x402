---
id: "0118"
title: "Check the Borg repository of OpenBao's snapshots weekly, with its own stamp and alarm"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0013"]
related_tasks: ["0026", "0027"]
tags: [deploy, operations, backups, priority-medium, effort-small, platform]
links:
  - ../../../docs/runbook.md
history:
  - date: "2026-11-06"
    status: backlog
    who: okarcz
    note: "Spawned from 0026: the team's decision on checking the snapshot repository (Slack, 2026-11-06), raised in #140's review."
---

# Check the Borg repository of OpenBao's snapshots weekly, with its own stamp and alarm

## Summary

As the admin of the facilitator, I want the Borg repository of OpenBao's snapshots read back in
full once a week, so that a damaged chunk shows within a week instead of at the quarterly restore
drill.

## Context

- 0026's daily job (`x402-openbao-snapshot`, #140) never reads old chunks back, and deduplication
  makes every later archive reuse them: a damaged chunk breaks each archive after it while the
  daily stamp stays fresh.
- The team chose option 1 on Slack on 2026-11-06 (0026, decision on the repository check): a weekly
  timer with `borg check --verify-data`, its own stamp and a 0027 alarm, done after the CloudWatch
  change.

## Implementation

- A weekly timer and oneshot service running `borg check --verify-data` through the snapshot
  script's credentials (the same lock, so it never overlaps the daily run).
- Its own stamp under `/var/lib/x402/last-ok/`, touched only when the check passes, read by the
  host probe.
- A 0027 alarm on the stamp's age, in its own group, turned on as `infra/README.md` describes.
- Runbook: what a failed check means and what to do.

## Acceptance Criteria

- [ ] The weekly check runs on the server and touches its stamp only on a pass.
- [ ] A check that fails leaves the stamp alone, and the alarm fires once it is older than the
      chosen age (`make fire-test` seen in Slack).
- [ ] The runbook covers the check, the alarm and the response.
