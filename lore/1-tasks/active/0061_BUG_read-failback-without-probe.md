---
id: "0061"
title: "Keep a read answered by RPC_URLS[0] from returning calls there without the probe"
type: BUG
status: active
milestone: 1
related_adr: ["0004"]
related_tasks: ["0045", "0049"]
tags: [signer-pool, payments, priority-medium, effort-small]
links:
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-23"
    status: backlog
    who: okarcz
    note: "Spawned from the re-review of PR #45 (0045 decisions 23 and 26)."
  - date: "2026-10-23"
    status: active
    who: okarcz
    note: "Work starts."
---

# Keep a read answered by RPC_URLS[0] from returning calls there without the probe

## Summary

With `failback` set, only the probe should return calls to `RPC_URLS[0]`, after it finds it at
most `FAILBACK_MAX_LAG_LEDGERS` (2) behind (AD-3). PR #45 closed two
ways back: a verify call never switches (decision 16), and `markFailed` and a failed
`sendTransaction` skip `[0]` through `moveOn()` (decision 26). `FallbackRpc.call()`, which every
pool and ledger read uses (`getFeeStats`, `getLatestLedger`, `getAccount`, `simulateTransaction`,
`getTransaction`), still runs `switchTo(idx)` for any endpoint that answers after the active one
fails, `[0]` included (`packages/signer-pool/src/fallback-rpc.ts`, `call()`).

So one failed read on `[1]` that `[0]` answers makes `[0]` active with no lag check. A `[0]` that
came back 50 ledgers behind then serves `/verify`, `/settle`'s checks and the pool, and can fail
valid payments, the A1 case of Adam's PR #45 reviews.

Reproduced on develop `e59a071`: calls on `b`, `a` 50 ledgers behind, one `getFeeStats` failure on
`b` → `switch b->a by getFeeStats`, no `rpc_failback`.

Decision 23 kept this switch on purpose ("a real RPC answer, not a payload"). That holds for a
dead `[0]`, not a lagging one, so this task replaces that part of decision 23.

## Implementation

- In `call()`, with `failback` set and `idx === 0`: return the answer, don't switch, and make a
  probe due at once (as `moveOn()` does). Without `failback`, keep the wrap-around switch.
- Correct the `failback` and `moveOn()` docs if the wording changes, and record the decision in
  AD-3 (`docs/architecture/m1-spine.md`).

## Acceptance Criteria

- [x] Given `failback`, calls on `RPC_URLS[1]` and a read that fails there, when `RPC_URLS[0]`
      answers, then the read returns that answer, the active URL stays `RPC_URLS[1]`, `onSwitch`
      doesn't fire, and a probe starts
- [x] Given that probe and `RPC_URLS[0]` more than 2 ledgers behind, then calls stay on
      `RPC_URLS[1]`; at most 2 behind, then they return with `rpc_failback`
- [x] Given no `failback`, a read that wraps around to the first endpoint still switches to it
      (the existing "wraps around to the first endpoint" test)

## Implementation Notes

- `packages/signer-pool/src/fallback-rpc.ts`: `call()` no longer runs `switchTo(0)` with
  `failback` set; it returns the answer and counts it as the active URL's failure through
  `moveOn()`: the next fallback with three URLs, a probe at once with two. `moveOn()`'s probe goes
  through `probeNow()`, which keeps probes started at once `MIN_PROBE_GAP_MS` (5 s) apart. The
  `failback` option doc and the class doc say so.
- Code review (2026-10-23): with three URLs the first version kept calls on a failing
  `RPC_URLS[2]` (the read reaches `[0]` before `[1]`), and every failed read re-armed a probe.
  Both are fixed and tested (decisions 3 and 4).
- `packages/signer-pool/test/resilience.test.ts`, in the `failback` describe: a `blip` setup
  where `b` fails one fee-stats read and both endpoints still answer `getLatestLedger`. One test
  has `a` 50 ledgers behind (calls stay on `b`, `rpc_probe_failed` with `lagLedgers: 50`, no
  switch), one has it 1 behind (calls return through the probe, `b->a lag 1`, no
  `b->a by getFeeStats`). Both fail with the old `switchTo(0)`. Two more: a read failing on
  `c` with three URLs moves calls to `b` (`c->b by getFeeStats`), and failing reads start one
  probe per 5 s. Each fails on its mutant.
- AD-3 in `docs/architecture/m1-spine.md`: one sentence beside 0045 decision 26.
- signer-pool 145 tests (+5), facilitator 307 (71 skipped, unchanged); typecheck and lint clean.

## Design Decisions

### From Plan

1. **Return the answer, keep the active URL, probe at once** (okarcz, 2026-10-23, after the PR #45
   re-review): only the probe returns calls to `RPC_URLS[0]`, on every path. This replaces the
   part of 0045 decision 23 that let a read answered by `[0]` move calls there.

### Emerged

2. **The probe reads the active endpoint again.** If the active one still can't read its ledger
   when the probe runs, the probe returns calls to `[0]` without a lag figure (0045 decision 11:
   an active endpoint that can't read its own ledger is no reason to stay on it). So a short blip
   on `[1]` is checked against a lagging `[0]`, while a `[1]` that is down hands calls back to
   `[0]` as before. The tests keep `b`'s ledger reads up to pin the blip case.
3. **A wrapped read counts as the active URL's failure** (code review, applied): `call()` uses
   `moveOn()`, as `markFailed` and `sendTransaction` do, so with three URLs a failing `[2]` moves
   calls to `[1]` and logs `rpc_failover` instead of keeping them on `[2]`. A read that started on
   `[1]` has tried every fallback before `[0]`, so it probes at once instead of moving (Adam's PR
   #62 review: with `[1]` and `[2]` down, `moveOn()` bounced calls between them until the 60 s
   probe). With two URLs that is always the case.
4. **Probes started at once stay 5 s apart** (okarcz, 2026-10-23, code review): without a gap,
   reads that keep failing on the active URL with a trailing `[0]` started a probe after every
   read once the last one ended. `MIN_PROBE_GAP_MS` bounds that at one probe, and one
   `rpc_probe_failed`, per 5 s; it also covers `moveOn()`'s trigger from 0045 decision 26. The
   `intervalMs` probe is unchanged.
5. **Left as is** (code review): a failed read that `[0]` answers logs nothing itself with two
   URLs; the probe it starts logs `rpc_failback` or `rpc_probe_failed` straight away. A hook of
   its own would add public surface for little gain.
