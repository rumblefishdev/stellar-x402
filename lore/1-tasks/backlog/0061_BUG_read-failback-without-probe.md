---
id: "0061"
title: "Keep a read answered by RPC_URLS[0] from returning calls there without the probe"
type: BUG
status: backlog
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
---

# Keep a read answered by RPC_URLS[0] from returning calls there without the probe

## Summary

With `failback` set, only the probe should return calls to `RPC_URLS[0]`, after it finds it at
most `FAILBACK_MAX_LAG_LEDGERS` (2) behind (AD-3, GLOSSARY "Failback / probe"). PR #45 closed two
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

- [ ] Given `failback`, calls on `RPC_URLS[1]` and a read that fails there, when `RPC_URLS[0]`
      answers, then the read returns that answer, the active URL stays `RPC_URLS[1]`, `onSwitch`
      doesn't fire, and a probe starts
- [ ] Given that probe and `RPC_URLS[0]` more than 2 ledgers behind, then calls stay on
      `RPC_URLS[1]`; at most 2 behind, then they return with `rpc_failback`
- [ ] Given no `failback`, a read that wraps around to the first endpoint still switches to it
      (the existing "wraps around to the first endpoint" test)
