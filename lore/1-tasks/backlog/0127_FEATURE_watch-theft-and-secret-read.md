---
id: "0127"
title: "Watch the accounts for theft and the backup secret for reads"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011", "0013"]
related_tasks: ["0027", "0026", "0047"]
tags: [infra, operations, monitoring, security, priority-medium, effort-medium, platform]
links:
  - ../active/0027_FEATURE_alerts-and-metrics/README.md
  - ../active/0027_FEATURE_alerts-and-metrics/notes/G-alarm-list.md
  - ../../../docs/adr/0013-facilitator-key-custody.md
  - ../../../docs/monitoring.md
history:
  - date: "2026-11-09"
    status: backlog
    who: okarcz
    note: "Spawned from 0027 (decision 71): decision 68's theft PR, with 0027's criteria 6, 7 and 9, moved here so 0027 can close on the alarms that are live."
---

# Watch the accounts for theft and the backup secret for reads

## Summary

The off-server check (the Watch Lambda, 0027) reads the fee account's balance and each network's
protocol every 5 minutes. ADR 0013 also asks it to see a theft of the facilitator key and a read of
the backup secret, with the server down too. This task adds those two sections and turns the
`watchSecurity` alarm group on: `account-state`, `account-effects` and `backup-secret-read`.

## Context

- 0027's decision 68 put the theft and secret-read sections in a PR after the balance one, since
  they need more design: the declared channel set, the read points, and the findings sent to SNS.
  Decision 71 moved that PR, with 0027's criteria 6, 7 and 9, to this task.
- The alarms are already defined in `infra/` (#114) and documented in 0027's
  [alarm list](../active/0027_FEATURE_alerts-and-metrics/notes/G-alarm-list.md), Money and
  security; `watchSecurity` is off in `infra/envs/production.json`.
- From ADR 0013: theft (decision 8) and reads of the backup secret (decision 9). The backup secret
  is created by 0026.

## Implementation

- Design first, written as decisions in this task:
  - the declared set: the fee account and each channel, with their signers and thresholds, and
    where the check reads it from;
  - the read points for effects and secret reads, where they are kept, and how a partial read
    leaves them unmoved;
  - each finding posted to the alarm topic by the check itself, one message per finding
    (0027 decision 64), with the alarms as the backstop.
- The theft section: `account_state_mismatches` and `account_effects_unexpected`, as the alarm list
  defines them.
- The secret-read section: `backup_secret_reads`.
- Tests against a faked Horizon and a faked secret-read source, as `watch-balance.test.ts` does.
- `docs/monitoring.md` sections for the three alarms; `make check-series GROUP=watchSecurity`, then
  `watchSecurity` on, the Watch and Alarms deploys, and each alarm fired once and recorded in
  Drills.

## Acceptance Criteria

- [ ] Given a signer or threshold change on the fee account or a channel, or an effect on them other than a credit or a claimable balance naming them, when the off-server check runs, then an alarm fires, with the server down too (ADR 0013)
- [ ] Given the off-server check down or failing for any time, when it next succeeds, then it has read every effect and secret read since its last full read, and a partial read moved neither read point
- [ ] Given a read of the backup secret, when the off-server check runs, then an alarm fires (ADR 0013)
- [ ] Given each of the three alarms, when this task is done, then it has fired once on purpose and `docs/monitoring.md` says how and when
