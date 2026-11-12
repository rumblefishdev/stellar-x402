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
  - date: "2026-11-12"
    status: backlog
    who: okarcz
    note: "From 0123 (P11, the review of #137): how the weekly check and the nightly run share the lock is this task's to decide; the facts and the three decisions are under Implementation, with a criterion."
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

### Sharing the lock with the nightly run

"The same lock" keeps the two from running together, but the one that waits can fail for it. The
facts, from the units as 0123 left them:

- The nightly run starts between 03:15 and 03:30 UTC (`RandomizedDelaySec=15min`), takes up to 30
  minutes (`TimeoutStartSec`), and after a failure is tried twice more, 20 minutes apart: a bad
  night can still be running at about 05:40 UTC.
- Either job waits `X402_LOCK_WAIT` for the lock, 600 s by default, then fails. A nightly run that
  meets the check uses up one of its three tries; a check that meets a slow nightly run gives up,
  and its stamp ages as if the repository were damaged.

To decide in this task (the review of #137 raised them, 0123 left them here):

- **When the check runs.** Away from the nightly run and its retries, not only from 03:15-03:30.
- **How long the check waits for the lock.** Longer than a whole nightly run, or not at all with
  the alarm's age allowing for a skipped week; the default 10 minutes is shorter than a slow run.
- **The alarm's age.** The review suggested 8 days: a week and a day's margin.

## Acceptance Criteria

- [ ] The weekly check runs on the server and touches its stamp only on a pass.
- [ ] A check that fails leaves the stamp alone, and the alarm fires once it is older than the
      chosen age (`make fire-test` seen in Slack).
- [ ] The runbook covers the check, the alarm and the response.
- [ ] The check's time, its wait for the lock and the alarm's age are decided and recorded here,
      and a check that meets the nightly run neither fails that night's snapshot nor raises its
      own alarm.
