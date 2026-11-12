---
id: "0123"
title: "Fix what the review of the third promotion (#137) found"
type: BUG
status: completed
milestone: 1
related_adr: ["0013"]
related_tasks: ["0026", "0027", "0029", "0087", "0118", "0142", "0143"]
tags: [deploy, backups, tests, priority-medium, effort-small, platform]
links:
  - ../../../docs/runbook.md
history:
  - date: "2026-11-06"
    status: active
    who: okarcz
    note: "Created from the code review of #137 (the 55 commits after 5ccde33a): D2 and P1-P12, fixed in one branch and one pull request."
  - date: "2026-11-12"
    status: completed
    who: okarcz
    note: >
      #178 merged (rebase, 6 commits, 7966672a): D2, P1-P10 and P12 done; P11 moved to 0118,
      which got the facts, the three decisions and a criterion. Stan's review added a named list
      of hosted facilitators, the stop time in the start-limit check and a cleanup that removes
      the decrypted files first. pnpm test 20/20 tasks; deploy 113, conformance 50 after the last
      commit. Follow-ups: 0142 (decrypted files' directory and test), 0143 (snapshot AppRole).
---

# Fix what the review of the third promotion (#137) found

## Summary

The code review of #137, the third promotion to `deploy/production`, covered the 55 commits its
description hadn't checked (`5ccde33a..a2fdfb08`). Its first decision was resolved on #137 itself
(the description rewritten for the real head). This task fixes the rest in one branch and one pull
request: the OpenBao snapshot job's retry and lock, its runbook steps, and three missing tests in
signer-pool and the conformance gate.

## Context

- The review: four independent reviewers, checked against #137's description, 2026-11-06. 2 decisions, 12 patches, 3 deferred, 12
  rejected.
- Most findings are on #140 (0026's OpenBao snapshots, merged 2026-11-06), including the retry
  that Stan's review of #140 added. P6 is 0087's rewrap (#128), P7 and P8 0029's gate and proxy
  (#138), P11 the backlog task 0118.
- One pull request for all of them, by choice: they are small, and the deploy and test changes
  are each checked by the existing suites.

## Acceptance Criteria

### The snapshot job (`deploy/`)

- [x] **D2. Its retries stop.** `x402-openbao-snapshot.service` has `StartLimitIntervalSec=3h`
      and `StartLimitBurst=3` in `[Unit]`: the run and two retries, then the unit stays failed
      until the next night's timer, so a lasting failure (wrong passphrase, host key, full box)
      doesn't log in and open an SSH session to the shared box every 20 minutes all day. A units
      test pins both, and fails without them.
- [x] **P1. The retry comment is true.** The service comment says a retry that meets the lock
      waits up to `X402_LOCK_WAIT` (600 s) for it, then fails and tries again later; only an
      admin's `borg` call can hold it. (`deploy/systemd/x402-openbao-snapshot.service`)
- [x] **P5. Cleanup removes the half-made credential too.** `cleanup` removes `$run/.<name>`, the
      file `x402-creds` decrypts into before its `mv`, beside `$run/<name>`.
      (`deploy/libexec/x402-openbao-snapshot`)
- [x] **P12. The header says what retention does.** "keeps 14 daily archives", not "prunes to 14
      days". (`deploy/libexec/x402-openbao-snapshot:5`)
- [x] **P3. The lock test isn't timing-sensitive.** It polls until `flock -n <lock> true` fails
      (the holder has the lock), up to about 5 s, instead of sleeping 200 ms.
      (`deploy/test/openbao-snapshot.test.ts`)
- [x] **P4. The lock test checks what its name says.** "gives up at once when another run holds
      the lock" (`X402_LOCK_WAIT=0`), and a second case: the holder releases after about 300 ms,
      the run waits with `X402_LOCK_WAIT=5`, gets the lock and finishes with the stamp.

### The runbook (`docs/runbook.md`)

- [x] **P2. The passphrase change pauses the job.** Its first line stops
      `x402-openbao-snapshot.timer` and `x402-openbao-snapshot.service`, which also cancels a
      retry waiting to restart; the recovery notes say so.
- [x] **P9. Setup step 3 tells an SSH failure from a stored passphrase.** The guard reads the
      answer (`stored` / `none`) and stops with "ssh failed" when SSH or sudo fails, not with "a
      passphrase is already stored".
- [x] **P10. "What is where" and Credentials name the backup paths.** `/run/x402/backup/` (the
      snapshot job's decrypted credentials and the snapshot during a run, tmpfs) and
      `/srv/x402/backup/creds/` (decrypted by the snapshot script on the host, not for a
      container).

### Tests elsewhere

- [x] **P6. A rewrap leaves the channel's sequence right.** In `settlement-guards.test.ts`'s 0087
      block: a rewrap ends in success, then a second `submit()` on the same channel builds its
      inner transaction at `txSequence + 1` and lands without `txBadSeq`, as
      `resilience.test.ts:177-186` does. Deleting `channel.sequence = txSequence` in
      `packages/signer-pool/src/submitter.ts` fails it.
- [x] **P7. The gate's verdict rules are tested.** The "no facilitator commit" and "dirty gate"
      problems move into `judge()` (or a pure function beside it), and the local/hosted results
      folder into `resultsFolder(url)`, `[::1]` included; `conformance/test/verdict.test.ts` has a
      case for each, and dropping either rule fails one.
- [x] **P8. The proxy is tested against a gzip upstream.** A stand-in facilitator answers with a
      gzip body and `content-encoding: gzip`; the proxied answer has no `content-encoding` and its
      body is the decoded JSON. Removing `content-encoding` from `notForwarded` fails it.

### Backlog

- [ ] **P11. 0118 says how the weekly check and the nightly run share the lock.** The check runs
      away from 03:15-03:30 UTC and waits for the lock longer than 10 minutes (or not at all), so
      it never fails a night's snapshot; the alarm's age is named (suggested: 8 days).
      (2026-11-12, okarcz: the three values are 0118's to decide. 0118 now has the facts, the
      three decisions and a criterion for them; this task names no time, wait or age.)
      Moved to 0118: not ticked here, since the criterion's words aren't met.

### Done

- [x] `pnpm test`, lint, typecheck and format pass; the PR's CI is green.

## Not in this task

The review deferred three findings. They stay out unless this task takes them on:

- The script's `/run/x402/backup` is tied to `x402-creds`' destination only by source text (a
  test would guard a future edit; the two agree today). Now 0142.
- The `x402-snapshot` AppRole has no secret-id expiry or CIDR binding, and the runbook has no
  rotation for the secret-id or the Storage Box key (a design point for the restore drill).
  Now 0143.
- The local round trip (stand-in box, compose override, restore steps) isn't committed.
- A run that systemd kills (SIGKILL) skips the cleanup trap, so its decrypted credentials stay in
  `/run/x402/backup/` until the next run (Stan's review of #178; the cleanup now removes them
  before its calls to OpenBao and Docker, which can hang). The fix at the source is
  `RuntimeDirectory=` on the unit, which systemd removes however the run ended; the admin `borg`
  path runs outside the unit and would need a directory of its own. Now 0142.

## Implementation Notes

PR #178, six commits on `develop` (rebase merge, last `7966672a`):

1. The snapshot job: `StartLimitIntervalSec=3h` and `StartLimitBurst=3` in `[Unit]`, the retry
   comment, the dot file in `cleanup`, the header; a units test of the values and of the window
   against three whole tries; the lock test polls for the holder and has a "freed" case (D2, P1,
   P3, P4, P5, P12).
2. The runbook: the passphrase change stops the service too, step 3's guard reads `stored` /
   `none`, the backup paths in "What is where" and Credentials (P2, P9, P10), and `reset-failed`
   before a start by hand.
3. Tests elsewhere: `judge(run, exitCode, record)` holds the two record rules and
   `resultsFolder()` the folder rule; the proxy's gzip test; a second call on a channel after a
   rewrap (P6, P7, P8).
4. 0118's lock-sharing facts and decisions (P11).
5. The code review's fixes: the "freed" lock test frees the lock only once the script waits in
   its own `flock`; the first-run step and the passphrase change's recovery note; more facts in
   0118; the gzip test sends the compressed length.
6. Stan's review: `HOSTED_FACILITATORS`, the stop time in the window check and the burst before
   03:15 in the comment and runbook, the cleanup's files before its daemon calls.

Each new test was run once without the line it guards and failed (D2, P6, P7, P8).

## Issues Encountered

- **The full test run needs the local PostgreSQL.** The facilitator's tests stop at once without
  `docker compose up -d` at the repo root (`127.0.0.1:15432`); not a regression.
- **A wrong rejection in the code review's triage.** The stop time in the window arithmetic was
  rejected because today's values pass; Stan showed a 39-minute timeout that passes the test and
  breaks the limit, so it went in (`f9a0d418`).

## Design Decisions

### From Plan

1. **D2: three tries in 3 hours,** decided on #137's review (2026-11-06).
2. **One pull request, four commits by group** (snapshot job, runbook, other tests, 0118 note),
   okarcz's choice.

### Emerged

3. **The window check pins the values and their relation** (okarcz): longer than three whole
   tries, shorter than a day, so a later change to the timeout or the wait fails the test.
4. **`reset-failed` in the runbook,** beyond the review's findings: the limit leaves the unit
   failed, so a start by hand is refused without it.
5. **The two record rules are a required argument of `judge()`** (okarcz), so the type check
   makes `gate.ts` pass them.
6. **P11's values stay 0118's to decide** (okarcz); P11 stays unticked as moved there.
7. **Hosted is a named list of hosts** (okarcz, from Stan's review, in this PR rather than a
   follow-up): any other host, the README's x402.org dry run included, goes to `testnet-local/`.
8. **The cleanup removes this host's files before calling OpenBao and Docker** (okarcz, on top of
   Stan's two changes).

**Modified tests:** `conformance/test/verdict.test.ts`: the 12 `judge()` calls take a clean record,
and `resultsFolder`'s cases now pin our host as hosted and every other as local. The lock test
in `deploy/test/openbao-snapshot.test.ts` was replaced by the two P4 cases. All intentional.

## Future Work

- 0142: the snapshot job's decrypted files in a directory systemd removes, and a test that runs
  the half-decrypted cleanup.
- 0143: the snapshot AppRole's secret-id expiry and binding, and rotation steps.
- Not tasks (okarcz): the uncommitted local round trip, and `gate.ts`' trim of the porcelain's
  first status column, left to Karol on #178.

## Notes

- The review report, with every finding's evidence and the 12 rejected ones, is kept outside the
  repo; its findings are copied above.
- P7 and P8 touch 0029's code (Karol's), P6 0087's; say so in the PR so the owners review those
  parts.
