---
id: "0156"
title: "Bound how long a refused settlement record stays, before 0086 reaches production"
type: BUG
status: active
owner: okarcz
milestone: 2
related_adr: []
related_tasks: ["0086", "0026", "0073"]
tags: [facilitator, payments, priority-high, effort-small]
links: ["https://github.com/rumblefishdev/stellar-x402/pull/210"]
history:
  - date: "2026-11-20"
    status: active
    who: okarcz
    note: >
      Spawned from the review of PR #210 (sixth deploy), which took in 0086. 0086 reaches
      production only with this fix; the fix PR joins #210 through develop.
---

# Bound how long a refused settlement record stays, before 0086 reaches production

## Summary

0086 records a check refusal of a payload with a settlement key as a `refused` record, before
any signature or funding check (0086 decision 13), and keeps it until the payload's own
`signatureExpirationLedger` has closed (decision 15). The sender chooses that ledger, up to about
2^32. So anyone with throwaway keypairs can send junk payments with a far expiration to
`/verify` and `/settle` and add rows, each with its full payload, that the pruner never deletes:
at the default limits (`RATE_LIMIT_VERIFY` and `RATE_LIMIT_SETTLE`, 600 a minute each) about
1.7M a day per client. Before 0086 a refused check wrote nothing.

The same PR fixes `main.test.ts` > "prunes on its timer until it closes", red on about every
other `develop` run since #205: the pruner's tick first waits for `getLatestLedger`, a real
request to the test's RPC, and the test checks `spend.prune` right after
`advanceTimersByTimeAsync(66_000)`, before that request returns.

## Context

- Found by the review of PR #210 (`_bmad-output` report of 2026-11-20, finding D2). okarcz
  decided: fix before 0086 reaches production.
- PR #210's head is `develop`, so the fix PR joins it once merged; Stan rewrites #210's body for
  0086 and waits for this PR's number, the new head and its CI (agreed on #210).
- The bound must keep decision 15's reason: a payload signed far ahead, refused as `…_too_far`
  or for its fee today, passes once the chain catches up, so its record must outlive that, or
  the payment settles after its payer signed again.

## Implementation Plan

### Step 1: The bound

A refusal is recorded only when the auth entry expires at most `REFUSAL_HORIZON_LEDGERS` (720)
after the latest ledger, in `/verify` (`refusals.ts`) and in `/settle` before the claim
(`settle.ts`). Past it: no row, the same refusal with the advice to wait for the expiration
ledger, and the log line `settlement_refusal_unrecorded`. The pruner doesn't change.

### Step 2: The pruner test

`await vi.waitFor(() => expect(prune).toHaveBeenCalled())` after the first
`advanceTimersByTimeAsync`, as the fee-balance test below it does.

## Acceptance Criteria

- [ ] Given junk payloads with a far expiration ledger refused by the checks, then the rows they
      leave are bounded (in time or count) and the pruner deletes them
- [ ] Given a payload refused today that would pass once the chain catches up, then it still
      never settles here after its payer may have signed again (0086's AC holds)
- [ ] `main.test.ts` > "prunes on its timer until it closes" passes without depending on the
      RPC request's timing

## Design Decisions

### From Plan

1. **Fix before 0086 reaches production** (okarcz, 2026-11-20, of: this; ship 0086 with a
   backlog task; accept as decision 13): the hole is new with 0086 and nothing needs 0086 in
   production today.
2. **The test fix rides in the same PR** (okarcz, Stan's suggestion on #210): one PR for #210 to
   wait on.
3. **Record only an auth entry within a horizon of the latest ledger** (okarcz, of: this; a row
   count with 503 past it; slimmer rows and a refusal write limit): a payment signed as a client
   signs is at most `MAX_VALIDITY_LEDGERS` ahead, and past the horizon a record only stops the
   payment landing through us, which its holder can do elsewhere anyway (0086's residual risk).
   A count cap still keeps junk rows until their ledger, so a full cap would turn every refusal
   into a 503 for that long; slimmer rows stay unbounded.
4. **The horizon is 720 ledgers, about an hour** (okarcz, of 720, 120 and 17,280): the hour the
   pruner keeps a refusal anyway (`REFUSED_HORIZON_MS`), so a refused row lives about an hour.
5. **A failed ledger read records the refusal**, as before 0156 (okarcz, proposed addition): a
   missed record risks a double payment, a row only costs disk, and a sender can't make our RPC
   fail on demand.
6. **The log line `settlement_refusal_unrecorded`, no counter** (okarcz, proposed addition), as
   0086 decision 14.

### Emerged

7. **`/verify`'s advice past the horizon says the payment may still settle**: `this payment may
   still settle until ledger N: sign a new payment once that ledger has closed`, not 0086's "will
   not settle here", which would be false without a record. `/settle` returns the key, so
   `withRetry` gives its usual "ended" advice ("the auth entry may still land in ledger N").
8. **`/settle` reads the ledger through `validOnce`**: the read the answer's advice makes anyway,
   so the horizon adds no RPC call there (the 0086 "one ledger read" test holds). `/verify` reads
   it only after the checks refused a payload with an expiration ledger, bounded by
   `LEDGER_READ_MS` (1 s, now exported).
9. **A reopen isn't held to the horizon**: its record already exists, so moving it to `refused`
   adds no row.
10. **The spine's prune sentence names the record without an expiration ledger**, which goes after
   the hour: the review's P4 for the spine, on the same lines.
