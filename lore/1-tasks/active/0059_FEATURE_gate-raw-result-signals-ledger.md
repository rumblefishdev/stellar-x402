---
id: "0059"
title: "Gate: the suite's raw result apart, cleanup on every signal, ledger instead of the clock"
type: FEATURE
status: active
milestone: 1
related_adr: ["0009"]
related_tasks: ["0028", "0029"]
tags: [conformance, e2e, priority-medium, effort-small, platform]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: "Spawned from 0028 future work (review of PR #47)."
  - date: "2026-10-23"
    status: active
    who: karolkow
    note: "Started."
---

# Gate: the suite's raw result apart, cleanup on every signal, ledger instead of the clock

## Summary

Three follow-ups of the gate harness (0028), all before the first run of record in 0029.

## Context

- The saved run mixes the official suite's JSON with the gate's own verdict in one file; the owner
  wants the suite's raw result kept as its own file. A ready commit (`ecddb83`) is on the local
  branch `lore-0028-raw-suite-result`.
- The upstream checkout (~6 GB) lives in a `mkdtemp` folder removed on `exit`; Node emits no `exit`
  on SIGTERM or SIGHUP, so a stopped run left 5.3 GB behind (2026-10-20).
- "Made in this run" compares the ledger close time with the local clock taken before the suite
  starts; a clock running ahead fails every scenario (devil's-advocate review of PR #47).

## Implementation

- Each run saves `conformance/results/<date>-<host>/suite.json` (the suite's `--output-json`, byte
  for byte) and `gate.json` (the verdict, naming `suite.json` and its SHA-256).
- SIGTERM and SIGHUP get the same handler as SIGINT (exit through `process.exit`, so the folder is
  removed).
- Before the suite starts, read `getLatestLedger().sequence` from the same RPC; a settlement whose
  `ledger` is lower fails.

## Acceptance Criteria

- [x] Given a finished run, when it is saved, then its folder holds `suite.json` identical to the
      suite's file and `gate.json` whose `suiteSha256` matches it
- [x] Given a running gate, when it gets SIGTERM or SIGHUP, then no `x402-gate-*` folder remains in
      `$TMPDIR`
- [x] Given a settlement in a ledger before the one read at the start, when it is checked, then the
      gate fails it; the local clock plays no part
- [x] One gate run on testnet passes 18 of 18

## Design Decisions

### From Plan

- 2026-10-20 — **The suite's raw result is kept apart**: each run saves a folder with the suite's own JSON copied byte for byte (`suite.json`) and the gate's verdict (`gate.json`), which names that file and its SHA-256.

### Emerged

- 2026-10-23 — **The gate runs as one Node process** (`node --import tsx src/gate.ts`), not under the `tsx` command. Measured: with the signal handlers alone, a TERM to the process group still left the folder, because `tsx`'s wrapper SIGKILLs a child that does not acknowledge a signal within ~30 ms, and the gate cannot while `execFileSync`/`spawnSync` blocks its event loop. As one process: 10 of 10 group TERMs and one group HUP left no folder.
- 2026-10-23 — **A signal to the gate's process alone waits for the gate's next network call**: `prepare` and the suite are synchronous calls, so the handler runs only at the next `await` — after the whole build (measured 275 s from a kill during `git clone`), or after the whole suite, its payments made and the run not saved. Making every step asynchronous would stop it at once but rewrites `prepare` and the suite call; not done here. Ctrl+C, a closed terminal and a group kill stop the running step at once.
- 2026-10-23 — **A settlement in the ledger read before the start fails too** (`ledger <= ledgerBeforeRun`, not `<`): that ledger had already closed when it was read, so no transaction of this run can be in it.
- 2026-10-23 — **The signal handlers stay after the first signal** (`process.on`, not `once`), from review: with `once` a second signal during the ~6 GB cleanup (Ctrl+C again, or pnpm passing it on) killed the gate halfway through it; measured with a 1 s cleanup and two SIGINTs 0.3 s apart.
- 2026-10-23 — **The checkout lives in `/tmp`, not `$TMPDIR`** (owner's choice of three: commit only passing runs, `/tmp`, redact `suite.json`): a failed scenario's stack trace prints the checkout path into `suite.json`, which is committed byte for byte, and `$TMPDIR` on macOS names a per-user folder.
