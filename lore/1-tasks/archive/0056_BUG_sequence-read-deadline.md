---
id: "0056"
title: "Stop the channel sequence read at the caller's deadline"
type: BUG
status: completed
owner: okarcz
milestone: 2
related_adr: []
related_tasks: ["0051", "0009", "0160"]
tags: [signer-pool, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: karolkow
    note: "Spawned from 0051 future work."
  - date: "2026-11-16"
    status: backlog
    who: okarcz
    note: >
      Moved to M2 by okarcz in the M1 Payments cleanup: not started, and M1 is closing.
  - date: "2026-11-20"
    status: active
    who: okarcz
    note: "Started by okarcz: Payments lane, M2."
  - date: "2026-11-24"
    status: completed
    who: okarcz
    note: >
      PR #218 merged: failed sequence reads stop at the caller's deadline, a "no entry" channel is
      still retired after timeoutSeconds. stkrolikiewicz's review fixed in the same PR (decisions
      2-5). signer-pool 199 tests (+3). The unbounded ledger poll in the wait goes to 0160.
---

# Stop the channel sequence read at the caller's deadline

## Summary

`SettlementSubmitter.readSequence` (`packages/signer-pool/src/submitter.ts`) retries a channel's
sequence read for `timeoutSeconds` (default 60 s; the facilitator does not override it), while
`/settle` answers at `SETTLE_BUDGET_MS` (default 30 s). During an RPC outage each `/settle` holds
a channel about 30 s after its client already got an answer. The late read never signs (`settle.ts`
refuses once the budget is over), so no money moves; channels are held longer than useful and
queued calls time out sooner. Found by the devil's-advocate review of PR #52.

This changes when a settlement gives up, so the options go to the owner before the PR.

## Implementation

- Cap the retry window at the call's own `deadline` when one is given.
- Retire a channel (a real "no entry") only after the full `timeoutSeconds`, never because the
  caller's deadline ended the window first.
- The facilitator's deadline is at most its 30 s budget and `timeoutSeconds` is 60 s, so if every
  read stopped at the deadline, no call would read for 60 s and a missing channel would never be
  retired: each call would draw it, read "no entry" until its deadline and put it back.

## Acceptance Criteria

- [x] Given an RPC outage and a call with a deadline, when its sequence read fails, then the call
      gives up at the deadline and the channel stays in the pool (within one ledger poll of it;
      the poll's own overrun is 0160)
- [x] Given no entry for a channel, then it is still retired after `timeoutSeconds`

## Implementation Notes

- `readSequence` (`packages/signer-pool/src/submitter.ts`) stops at the earlier of `deadline` and
  `timeoutSeconds` while no read has answered "no entry", and checks the window again right after
  each wait. A non-finite deadline is ignored.
- Tests in `packages/signer-pool/test/resilience.test.ts`: outage with failing reads and ledger
  polls stops within a ledger of the deadline and keeps the channel; "no entry" past the deadline
  is still quarantined at 60 s; one "no entry" then failures still reads to 60 s.
- No existing test changed.

## Design Decisions

### From Plan

1. **The deadline stops failed reads only** (okarcz, 2026-11-20, of four options: this; every read
   stops at the deadline with a per-channel "no entry" timer across calls; `timeoutSeconds` at
   most 30 s in the facilitator; won't fix): a read that fails (502, timeout, RPC error) past the
   caller's deadline ends the call with the last read's error, as the `timeoutSeconds` give-up
   does (an outage answers `settle_exact_stellar_rpc_unavailable`), and the channel goes back to
   the pool. Not `QueueTimeoutError` (okarcz): its `…_no_channel_in_time` would say no channel was
   free, when the channel was there and the RPC failed; both reasons are unsent. Once the RPC has answered "no entry", the read keeps its
   `timeoutSeconds` window and retires the channel as before: nobody can use a missing channel, so
   holding it costs nothing. A call without a deadline reads as before. Rejected: the timer across
   calls adds per-channel state and repeats a deadline's wait on a missing channel until retired;
   a lower `timeoutSeconds` also moves the transaction's time bound and the prepared-ahead expiry
   check.

### Emerged

From stkrolikiewicz's review of PR #218 (okarcz, 2026-11-24):

2. **The read checks its window again after each wait**: before, a wait that ended on its
   deadline was always followed by one more read, so with a slow RPC (each read up to N URLs ×
   10 s through FallbackRpc) a +30 s deadline ended at +60 s. Now it gives up with the last read's
   error right after the wait, and still retires the channel if that read answered "no entry".
   **Limit kept:** the wait's own ledger poll (`LedgerClock.following`) has no time limit, so the
   read can still end one RPC call past the deadline; bounding it means changing `LedgerClock`.
   With the extra read gone, the read can now answer `…_rpc_unavailable` before the facilitator's
   budget answers `…_timeout`, which before happened only when the auth expiry cut the deadline
   (adamkoot's review note).
3. **signer-pool doesn't refuse a send after the deadline**: a read that succeeds at or after the
   deadline still prepares, signs and sends; in the facilitator the `budgetOver` guard in
   `onSigned` refuses it. The doc comment now says the caller refuses the send, instead of
   claiming the call won't send. Rejected for this PR: a deadline check before `prepare`, a
   behavior change that needs its own refusal reason.
4. **A non-finite `deadline` is ignored**: a `NaN` deadline never passed, so failed reads retried
   forever; now it falls back to `timeoutSeconds`. Unreachable from the facilitator.
5. **Two tests made to fail without the change**: the deadline test now fails ledger polls too, as
   in a real outage, so its wait ends on the deadline (it passed with `following(giveUpAt)`
   before); a new test pins the sticky "no entry" flag (one "no entry", then failures past the
   deadline still read to `timeoutSeconds`; `noEntry = missing` used to pass the suite).

## Future Work

- Bound the ledger poll inside the wait between reads (0160).
