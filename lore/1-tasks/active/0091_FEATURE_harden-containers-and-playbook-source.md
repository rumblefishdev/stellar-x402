---
id: "0091"
title: "Drop the containers' capabilities and run the playbook from a protected branch before the signer lands"
type: FEATURE
status: active
milestone: 1
related_adr: ["0011"]
related_tasks: ["0026", "0036"]
tags: [deploy, security, priority-medium, effort-small, platform]
links: []
history:
  - date: "2026-10-30"
    status: backlog
    who: stkrolikiewicz
    note: "Spawned from 0026: the two items Karol left for later in his review of #91."
  - date: "2026-11-02"
    status: active
    who: okarcz
    note: "Picked up by okarcz."
---

# Drop the containers' capabilities and run the playbook from a protected branch before the signer lands

## Summary

Two gaps that are acceptable while the facilitator holds no signer, and not once 0036 lets it ask
OpenBao to sign. Its containers keep Docker's default capabilities, and the playbook, which
installs what root runs on the shared server, comes from `develop`, which has no protection.

## Context

- `deploy/production/compose.yaml` sets `read_only` and memory limits, but no `cap_drop` and no
  `no-new-privileges`.
- The runbook runs the playbook from `origin/develop` and calls that commit the boundary around
  production. Anyone with write access can push to `develop` without a review. Protecting it isn't
  free: lore status changes go straight to it.
- `deploy/production` doesn't exist yet. The runbook creates it before the first deploy, protected
  by a pull request with an approving review and no bypass, so CI's way to the server is reviewed
  and the admin's isn't.
- 2026-11-03: `deploy/production` now exists (tip `f391494`, 2026-10-30) with rules for a pull
  request, no force push and no deletion. OpenBao's compose file already drops every capability
  and sets `no-new-privileges` (`b303e4a`, #104, task 0026), so the item for it below is done.

## Implementation

- Compose: `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]` on `facilitator`,
  `migrate-testnet` and `cloudflared`. `postgres-testnet` starts as root and drops to `postgres`,
  so it keeps what its entrypoint needs, found by a run on a fresh volume, not guessed.
- ~~0036's OpenBao container gets the same treatment when it arrives.~~ Done by 0026 (#104).
- Playbook: the runbook and the playbook's header run it from `origin/deploy/production`.
- A change under `deploy/` merged to `deploy/production` also starts a deploy, since the workflow's
  `paths-ignore` doesn't cover it. The runbook says which comes first, the playbook or that merge.

## Acceptance Criteria

- [ ] Given the running services, when `docker inspect` reads them, then each shows its dropped
      capabilities and `no-new-privileges` (passed locally on 2026-11-03; on the server after the
      merge, with the runbook's check)
- [ ] Given those settings, when a fresh database starts, a migration runs, a deploy restarts the
      facilitator and the server reboots, then all of them still work (passed locally on
      2026-11-03 with plain Compose: a new database, a migration and a container restart. Not
      yet: secrets at `x402-creds`' owner and mode, the deploy path (`deploy.sh`,
      `x402@.service`) and the reboot, decision 3)
- [x] Given the runbook, when an admin follows it, then the playbook comes from a commit on
      `deploy/production`
- [x] Given a change under `deploy/`, when it ships, then the runbook gives the order of the
      playbook run and the deploy

## Implementation Notes

- `deploy/production/compose.yaml`: both settings on all four services; `postgres-testnet` adds
  back `CHOWN`, `DAC_READ_SEARCH`, `SETUID` and `SETGID`, with a comment on which start step needs
  each.
- `docs/runbook.md`, The playbook: runs from `origin/deploy/production`, the order for a change
  under `deploy/`, and a `docker inspect` check. The deploy key step runs the playbook from
  `deploy/production` too.
- `deploy/ansible/playbook.yaml` header and ADR 0011's playbook line name `deploy/production`.
- Local test, 2026-11-03, compose file as on the server with test secrets and an image built from
  this branch:
  - Postgres with no `cap_add` on a new volume: fails (`chown … Operation not permitted`), so the
    run exercises the root step.
  - With the four: a new volume (`initdb`), a restart, a recreated container on the existing
    volume, and a second new volume all reach `pg_isready`. The running server is uid 999 with
    `CapEff` 0 and `NoNewPrivs` 1.
  - `migrate-testnet` applied every migration; the facilitator, with a throwaway testnet key and
    one channel from `create-channels.ts` in a scratch override file, became healthy with
    `ready` and `listed` true, again after a restart, and `/supported` answered 200.
  - `cloudflared` started and reached Cloudflare, failing only at registration with a fake token.
  - `docker inspect`: `CapDrop=[ALL]` and `no-new-privileges:true` on all four, `CapAdd` empty but
    for Postgres's four.
  - Not tested: systemd units, `x402-creds`, `deploy.sh` and a reboot.

## Issues Encountered

- **A restart, not a new volume, needs the extra capability.** With `CHOWN`, `SETUID` and
  `SETGID` a new volume started, but the next start failed: the data directory now belongs to
  `postgres` with mode 0700, and root's `find … -exec chown` can't read it without its default
  `DAC_READ_SEARCH` (`find: … Permission denied`, exit 1). A test on a fresh volume alone would
  have passed and broken the first reboot.
- **`DAC_READ_SEARCH` is needed at every start, a new volume too** (found in review). The
  entrypoint reads `POSTGRES_PASSWORD_FILE` as root before gosu, and on the server that file is
  0400 and owned by 999 (`x402-creds`). The local run used 0644 test secrets, so a new volume
  started without it there; on the server it wouldn't. The set is unchanged; the compose comment
  gives both reasons. A run with secrets at `x402-creds`' owner and mode is still to do.
- **`chmod … Operation not permitted` stays in Postgres's log.** Root can't chmod directories
  `postgres` owns without `FOWNER`; the entrypoint ignores that failure (`|| :`) and repeats the
  chmod as `postgres` after gosu, so the modes end right (`3775`, `700`).

## Design Decisions

### From Plan

1. **Postgres: drop all and add back what a run shows** (okarcz, 2026-11-03), rather than starting
   it as `postgres` with none, or keeping Docker's defaults with only `no-new-privileges`.
2. **A change under `deploy/`: merge, then the playbook, then restart** (okarcz, 2026-11-03).
   The playbook must come from `deploy/production`, so the merge comes first, and its deploy runs
   with the old files; a change must work with them until the restart.
3. **Test locally only for now** (okarcz, 2026-11-03): no run on the server or a VM. The reboot
   stays in the criteria; okarcz decides how to test it before review.
4. **The out-of-date context is fixed in this task's PR** (okarcz, 2026-11-03).

### Emerged

5. **`DAC_READ_SEARCH` added** after the restart failure (Issues Encountered). Without `FOWNER`,
   left out since its chmod failure is harmless.
6. **ADR 0011's playbook line and the deploy key step** name `deploy/production` too: both said
   "a reviewed commit" or `develop`, and would contradict the runbook.
7. **A `docker inspect` check in the runbook,** for criterion 1 on the server after the merge.
   It covers OpenBao's project too, and reads `migrate-testnet`'s settings from the compose file,
   since that container exists only during a deploy.
8. **A `deploy/` change that can't work with the old files ships as two pull requests**
   (okarcz, 2026-11-03, from the review): the files first, compatible with the running image,
   then the image change.
9. **Step 3 stops the facilitator before restarting the database and tunnel** (review), and the
   runbook adds: wait for the merge's deploy before the playbook, rerun a failed deploy after
   step 3, restart OpenBao only for its own files, a clean checkout before the playbook, and Run
   workflow after a deploy key change.

## Review

2026-11-03, four layers (full mode): 1 decision (decision 8), 11 patches applied, 1 deferred,
6 rejected. Checked during the review: `deploy/production`'s ruleset (`26205855`) is active,
requires 1 approving review and has no bypass actors. Deferred: no CI job starts the production
compose file, so a Postgres image bump that needs another capability would pass CI and fail on
the server; a backlog candidate after 0036.
