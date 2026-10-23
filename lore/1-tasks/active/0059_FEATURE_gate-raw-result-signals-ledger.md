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

- [ ] Given a finished run, when it is saved, then its folder holds `suite.json` identical to the
      suite's file and `gate.json` whose `suiteSha256` matches it
- [ ] Given a running gate, when it gets SIGTERM or SIGHUP, then no `x402-gate-*` folder remains in
      `$TMPDIR`
- [ ] Given a settlement in a ledger before the one read at the start, when it is checked, then the
      gate fails it; the local clock plays no part
- [ ] One gate run on testnet passes 18 of 18
