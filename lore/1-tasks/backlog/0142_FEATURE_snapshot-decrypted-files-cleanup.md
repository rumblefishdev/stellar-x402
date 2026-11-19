---
id: "0142"
title: "Keep the snapshot job's decrypted files in a directory systemd removes, and test their cleanup"
type: FEATURE
status: backlog
related_adr: ["0013"]
related_tasks: ["0123", "0026"]
tags: [deploy, backups, security, priority-medium, effort-small, platform]
links:
  - ../../../docs/runbook.md
history:
  - date: "2026-11-12"
    status: backlog
    who: okarcz
    note: "Spawned from 0123's future work (the review of #137 and Stan's review of #178)."
---

# Keep the snapshot job's decrypted files in a directory systemd removes, and test their cleanup

## Summary

As the admin of the facilitator, I want the snapshot job's decrypted credentials gone however a
run ends, and a test that shows it, so that a killed run can't leave the Borg passphrase, the
Storage Box key or the AppRole's IDs in `/run/x402/backup/`.

## Context

- The job's `cleanup` trap removes the files on any exit but SIGKILL. A run that hangs on a wedged
  OpenBao or Docker is stopped at `TimeoutStartSec` and killed after `TimeoutStopSec`; 0123 made
  the trap remove the files before its daemon calls, but a kill before the trap runs at all still
  leaves them until the next run (Stan, #178).
- The script's `/run/x402/backup` matches `x402-creds`' destination only by source text, and the
  only check on the dot file `x402-creds` leaves is a text match: the script's test runs on plain
  files (`X402_CREDS_DIR`) and never reaches that branch (0123's review).

## Implementation

- `RuntimeDirectory=x402/backup` (mode 0700) on `x402-openbao-snapshot.service`, so systemd
  removes the directory when the unit stops, however it stopped.
- The admin `borg` path runs outside the unit: it needs its own directory, or a run through
  `systemd-run` with the same setting.
- A seam for the decrypt (the `x402-creds` path or the run directory), so the script's test can
  run a stand-in that leaves `.<name>` and fails, and check that nothing is left.

## Acceptance Criteria

- [ ] A snapshot run that is killed leaves no file in its run directory (a check on the server or
      a unit test of the unit's settings).
- [ ] A test runs the script with a decrypt that stops after writing `.<name>` and shows that
      neither `<name>` nor `.<name>` is left; it fails without the cleanup's dot-file removal.
- [ ] The admin `borg` path still works, and the runbook's "What is where" names the directory
      each path uses.
