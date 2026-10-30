---
id: "0066"
title: "Decide what /verify does when a payment must restore archived state"
type: BUG
status: active
milestone: 1
related_adr: ["0007"]
related_tasks: ["0021", "0007"]
tags: [facilitator, exact, fees, payments, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-23"
    status: backlog
    who: okarcz
    note: "Spawned from 0021's testnet run."
  - date: "2026-10-27"
    status: active
    who: akot
    note: >
      Work starts.
  - date: "2026-10-28"
    status: active
    who: akot
    note: >
      Option B built: the fee refusal names the archived entries; threat model and README
      updated. 10 new facilitator tests. The max code review's fixes: indexes and keys
      deduplicated, only archivable keys of bounded length named, the message says the list is
      the transaction's, and the README checks the restore's result.
---

# Decide what /verify does when a payment must restore archived state

## Summary

Since Protocol 23 a transaction restores the archived entries it touches and pays their rent in
its resource fee. The facilitator pays that fee (AD-10): the settlement is rebuilt on a channel
account and fee-bumped by the facilitator, so the buyer's own fee is never used. A payment that
touches archived state therefore costs the facilitator far more. In 0021's testnet run the
resource fee was 551,787 stroops for a SAC whose instance was archived and 342,189 for a non-SAC
token whose payer balance was archived, against 14,278 for live USDC. (A G-account's SAC balance is
a trustline and never archives; a non-SAC balance, a C-account's SAC balance, an instance or a
contract's code can.)

Both are above `MAX_FEE_STROOPS` (250,000), so `/verify` answers
`invalid_exact_stellar_payload_fee_exceeds_maximum`, and nobody can tell from the answer that
archived state adds the cost, or that anyone, buyer or seller, can restore the entries from their
own account (`RestoreFootprint`, `stellar contract restore`). Upstream checks the fee before the
transfer events and auth, so the payment is not known to be valid either.

## Decision

Option B: keep refusing, and say why. The facilitator does not pay restore rent above its
ceiling, and the reason code stays the one the x402 Stellar spec requires. Upstream and r402
refuse too; the OpenZeppelin plugin refuses only with a ceiling configured, and then on the
client's bid. The x402 SVM spec forbids the fee payer from paying rent
([R-facilitator-survey](notes/R-facilitator-survey.md)). Rejected: paying the restore rent (a new
way to drain the facilitator) and raising or splitting the cap (every payment's worst case grows).

The design is [S-option-b-design](notes/S-option-b-design.md). In short: the verdict and the
code stay upstream's; when the payment's own transaction lists archived entries
(`archivedSorobanEntries`), the message adds them after upstream's
`simulation-derived fee N stroops exceeds ceiling M stroops`. No extra RPC call.

## Acceptance Criteria

- [x] Given a payment over the fee ceiling whose transaction lists archived entries, when
      `/verify` or `/settle` runs, then the answer keeps
      `invalid_exact_stellar_payload_fee_exceeds_maximum` and its message names the entries, and a
      test pins it
- [x] Given a payment over the ceiling with no archived entries, or another refusal, then the
      answer is upstream's unchanged
- [x] Given the choice, then the threat model's "Fee inflation by rent" records it and the
      facilitator README says how to restore the entries

## Implementation Notes

- `apps/facilitator/src/settlement/verify.ts`: `withArchivedEntries` on `createChecker`'s refusal
  branch, so `/verify` and `/settle` (`settleCheck`) share it. It reads `archivedSorobanEntries`
  from the payment's transaction and names their read-write footprint keys: each once, only
  persistent contract data and code, a key over 512 base64 characters shown by its length, at most
  4.
- `apps/facilitator/test/fee-agreement.test.ts`: against the real `ExactStellarScheme`, a check
  that `assembleTransaction` keeps the archived entries, the named entries on both routes, the cap
  of 4, a realistic footprint with read-only keys, repeated and out-of-range indexes, entries that
  don't archive and an over-long key, and upstream's answer for another refusal and for a fee
  refusal without archived entries.
- `apps/facilitator/src/http/app.ts`: the `verified` and `settled` logs carry the message of a
  `…_fee_exceeds_maximum` refusal as `message`; `verify-route.test.ts` and `settle-route.test.ts`
  pin it, and that no other refusal's message is logged.
- `docs/threat-model.md`, "Fee inflation by rent"; `docs/adr/0007-fee-abuse-containment.md`, one
  line on restore rent; `apps/facilitator/README.md`, "Restoring archived entries".
- Not covered: `/settle` can still refuse after the check with
  `settle_exact_stellar_fee_exceeds_maximum` when the pool's rebuild re-simulates and finds an
  entry archived since `/verify`; that message doesn't name the entries. The window is narrow.
- Facilitator suite after the PR review: 553 tests, all passing but 0025's "gives the lease up
  at once past a stalled client", which fails on local Node 26 on develop too (CI runs Node 22);
  tsc and eslint clean.

**Modified tests:** `settle.test.ts`'s "answers a failed check with its reason, without claiming"
now also expects the check's `invalidMessage` as `errorMessage`; it held nothing on the message
before.

## Design Decisions

### From Plan

1. **Description only**: the verdict and the code stay upstream's; the entries come from the
   client, so they change only the text.
2. **No extra RPC call**: the entries are read from the payment's own transaction.

### Emerged

3. **Under the ceiling the facilitator pays restore rent**, as it pays any rent; the threat model
   says so.
4. **The README restores with the SDK, not stellar-cli**: stellar-cli 28.1.0's `contract restore`
   takes a data entry's key as an `ScVal` with `--id` and `--key-xdr`, not the message's
   `LedgerKey`, one entry per call. One `RestoreFootprint` over the message's keys restores them
   all, as 0021's `token-matrix.ts` did; the README shows how to get stellar-cli's arguments from
   a key.
5. **After a restore, a new payment, not the same one**: the message lists the entries the payment
   was built with, so a resent payment names them again while any is still archived.
6. **The list is named as the transaction's, not checked** (code review): the buyer's client
   writes it, so the message says "the payment's transaction lists", the facilitator names only
   persistent contract data and code, each once, a key over 512 base64 characters by its length
   (counted, so the count stays true), and the README says how to check the entries before paying
   their rent: whose they are from the key, archived from `getLedgerEntries`. Each footprint key
   is encoded at most once, so a repeated index costs nothing.
7. **The message is logged on a fee refusal** (PR review): `@x402/core` puts only the reason into
   the buyer's 402, so the `verified` and `settled` logs carry it for the operator, only for
   `…_fee_exceeds_maximum`; it is bounded (four keys of at most 512 characters).
