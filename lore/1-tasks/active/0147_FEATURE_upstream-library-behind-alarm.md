---
id: "0147"
title: "Alarm when production runs an older @x402/stellar than npm"
type: FEATURE
status: active
owner: karolkow
milestone: 1
related_adr: []
related_tasks: ["0029", "0026", "0027", "0145"]
tags: [alarms, upstream, priority-medium, effort-small, platform]
links:
  - ../../../docs/monitoring.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-11-16"
    status: active
    who: karolkow
    note: >
      Created after the #149 review: its upstream section reads four spec files, so a new
      @x402/stellar release with no spec change stays silent. On 2026-11-16 production ran 2.28.0
      while npm and develop had 2.31.0.
---

# Alarm when production runs an older @x402/stellar than npm

## Summary

The facilitator verifies and settles through upstream's `@x402/stellar`. Nothing tells the team when
upstream releases a newer one, or when a bump is merged but not deployed. A daily read in the
off-server check compares the version production runs with npm's latest and pages the team's alarm
channel while production is behind.

## Context

- `upstream-changed` (#149, task 0029) compares four upstream spec files at the gate's pin with
  upstream main. A library release with no spec change leaves it at 0: 2.31.0 came out on
  2026-11-12 with the four files unchanged (measured 2026-11-16).
- AD-14 (`docs/architecture/m1-spine.md`) keeps every `@x402/*` package on one pinned minor,
  bumped on purpose (0145 moved them from `~2.28.0` to `~2.31.0`). It says how to bump, not how the
  team learns a bump is due.
- `@x402/stellar` had 19 releases from 2026-05-01 to 2026-11-16 (2.12.0 … 2.31.0, npm `time`);
  `@x402/core` and `@x402/extensions` were released with it, at 2.31.0 on 2026-11-16.
- A protocol upgrade the SDK can't read has its own early alarm, `protocol-upgrade-coming` (0027).
- Production's `/health` names its commit (`5d2e26ba` on 2026-11-16); `uptime.url` in
  `infra/envs/production.json` already holds that URL.

## Decisions so far

| # | What is done | From | vs the task | Who does the same (checked) | Code | Test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | The version compared is the one production runs: the commit from `/health`, then `apps/facilitator/package.json` at that commit, so a bump merged but not deployed still pages | the owner's decision, 2026-11-16 | as the task says | no standard | | |
| 2 | Its own alarm and metric, not a fifth entry in `upstream_files_changed`: production is behind for most of the time, which would hide spec changes behind one ALARM state | the owner's decision, 2026-11-16 | as the task says | no standard | | |
| 3 | The alarm is named `upstream-library-behind`, in the `upstream` group beside `upstream-changed` and `upstream-silent` | the owner's decision, 2026-11-16 | as the task says | no standard | | |
| 4 | One plain question: is the `@x402/stellar` version production asks for (its `package.json` range, without the `~`) the one npm calls `latest`? 1 when they differ, 0 when equal; no minor count, no major rule | the owner's decision, 2026-11-16 | changes it: the task said minors behind | no standard | | |
| 5 | A `/health` with no `commit` fails the read loudly (`watch_section_failed`), never falls back to develop | the owner's decision, 2026-11-16 | beyond it | no standard | | |
| 6 | The version is read with a plain match on `~X.Y.Z`, the shape AD-14 sets; any other shape fails the read | the owner's decision, 2026-11-16 | beyond it | no standard | | |
| 7 | Once a day, in the 08:00 UTC run with the upstream section, on a one-day alarm period | the owner's decision, 2026-11-16 | beyond it | no standard | | |
| 8 | No point that day reads as behind: `upstream-library-behind` means "production not confirmed on npm's latest", so a read that breaks (a range shape, a moved file, a source down) pages within a day; no separate silence alarm for it. Built as `FILL(m, 1) >= 1` over the day, the factory's silence shape, not `treatMissingData` alone (the Prices API's 0222: a breaching-only alarm missed a 3-hour halt, `infra/src/lib/alarms/factory.ts:195`) | the owner's decision, 2026-11-16; the alarm's shape agent, from the factory's note | beyond it | the `uptime` alarm reads a missing point as down (`infra/lambdas/uptime-probe/probe.mjs`) | | |
| 9 | `upstream-changed` takes the same rule: no point that day reads as changed, and `upstream-silent` is removed, so the `upstream` group has one rule for a missing read and two alarms | the owner's decision, 2026-11-16 | changes 0029's decision 17 | no standard | | |

## Not yet decided

- None.

## Out of scope

- Opening PRs for new versions (a dependency bot); other dependencies than `@x402/*`.
- Turning the alarm on: 0026's criterion for the `upstream` group, with the next production deploy.

## Acceptance Criteria

- [ ] Given production on another `@x402/stellar` version than npm's `latest`, when the 08:00 UTC run reads both, then it publishes 1, and `upstream-library-behind` goes to ALARM
- [ ] Given production on npm's `latest`, when the run reads both, then it publishes 0 and the alarm is OK
- [ ] Given `/health`, GitHub or npm failing, when the run reads them, then it publishes nothing for this read, logs `watch_section_failed` with the read that failed, and `upstream-library-behind` goes to ALARM within the day
- [ ] Given no `upstream_files_changed` point in a day, when the alarm reads it, then `upstream-changed` goes to ALARM, and `upstream-silent` no longer exists
- [ ] Given the alarm list, when this task is done, then `docs/monitoring.md` lists `upstream-library-behind` among the alarms that are off, turned on by 0026
