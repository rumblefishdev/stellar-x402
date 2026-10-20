# ADR 0006: The settlement record: claim, replay, lifecycle and channel lease

- Status: accepted
- Date: 2026-10-07, amended 2026-10-15 (task 0009: a success is answered once; a repeat of an
  unsigned record ends it at the first call's budget), 2026-10-16 (task 0009: the store-outage
  rule; a success answered while the store can't mark it) and 2026-10-20 (task 0009: a repeat's
  settle timeout counts from the hash it sees; a refusal the store can't record)

## Context

With every payment settled through the pool ([ADR 0003](0003-settlement-channel-account-pool.md),
[ADR 0004](0004-facilitator-shape.md)), the facilitator has to:

- answer `settlement_pending` when a transaction isn't final in time, and give a consistent answer
  when `/settle` is called again;
- never settle one authorization twice;
- not lose a payment that may still land when the process restarts.

The M1 architecture review found these holes in a simple "look up, then submit" design:

- **Parallel calls.** Two `/settle` calls for one payload both submit, and we pay the losing
  transaction's fee.
- **Replay.** Returning a stored `success` to any caller lets a client pay once and present the
  same payload to a second merchant.
- **Lost hash.** `onSigned` in `signer-pool` is synchronous and not awaited, so the hash may not
  be stored before the transaction is sent.
- **Overwrites.** A late `resolved` event can be overwritten by an earlier `pending` write.
- **Shared channels.** Two processes sharing a channel set, for example during a rolling deploy,
  break each other's sequence numbers.
- **Expired authorization.** The transaction's time bound (60 s) can outlive the client's auth
  expiry, so we pay a fee for a transaction that must fail.

The canonical x402 resource server retries `/settle` exactly once, immediately, after
`settlement_pending`.

## Decision

- **Key.** `network:payer:nonce`, where the nonce is the int64 nonce of the payer's auth entry,
  stored as a decimal string. A payload must carry exactly one payer auth entry.
- **Fingerprint.** Each record stores a hash of the canonical payload plus
  `paymentRequirements`.
- **Claim before submit.** After verification, `/settle` claims the key with an atomic
  insert-if-absent. Only the caller that wins the claim submits.
- **Replay rules.**
  - A repeat with the same fingerprint returns the record's outcome. If the record is signed but
    not final, it first waits, up to `SETTLE_TIMEOUT_MS` from when the repeat first sees a hash,
    for the final outcome. If nothing was signed, it waits until the first call's settle budget
    ends, counted from the first call's start (`createdAt`, taken before its checks), then
    ends the record itself with `…_timeout` (compare-and-set against `addHash`). If the store
    can't end it, the answer is `settlement_pending` with no hash, never `…_timeout`: the record
    may still be signed. Both waits also end with the repeat's own budget. A repeat that lost the
    claim began before the first call, so its budget can end first: then it answers
    `settlement_pending` with no hash and leaves the record to the first call.
  - `success: true` is answered once per record, by compare-and-set on `successAnsweredAt`. Later
    calls get `settle_exact_stellar_already_settled` with the hash. `settlement_pending` doesn't
    count, and a call whose client left before the mark marks nothing.
  - When the store can't mark (it fails or misses its 1 s grace), the payment still landed, so the
    caller gets the success. The process keeps the key in memory and answers every later call
    `…_already_settled`. Known exception until 0019: after the store recovers, or on another
    instance, a repeat can win the mark and get a second success.
  - A repeat with a different fingerprint is rejected with the stored hash, if any, and nothing is
    submitted.
- **Wire mapping.** Every answer carries `network` and `payer`.
  - `success` → `{success: true, transaction}`, once; after that
    `{success: false, errorReason: "settle_exact_stellar_already_settled", transaction}`
  - `pending` → `{success: false, errorReason: "settlement_pending", transaction}`
  - other outcomes and each thrown submitter error → a fixed `errorReason`, with the record's last
    hash as `transaction` when it has one
- **Store outage: refuse before money moves, tell the truth after.** A store that fails or
  doesn't answer:
  - before the claim, or at the claim: a 500, and nothing is sent; the client repeats the same
    request;
  - at the hash write before a send: the pool doesn't send (AD-16);
  - after the pool answered: the answer is the pool's result, with its hash, and the record is left
    as it was, unfinished. One exception: when the pool threw a refusal (e.g.
    `…_simulation_failed`) and the refusal can't be recorded, the answer is
    `unexpected_settle_error` (`…_timeout` past the budget), not the refusal's reason. It takes two
    failures in a row, and the record is still open, so a repeat could answer otherwise;
  - at the success mark: the success, as above.

  0019 finishes unfinished records once the store is back; how available the store must be is
  set by ADR 0012 (task 0013), and its alarms are 0027's.

- **One owner of the lifecycle.** A single settlement module in `apps/facilitator` writes every
  record change.
  - States only move forward: `claimed → signed → pending → success | failed | rejected | expired`.
  - Each write is a compare-and-set.
  - A record keeps every hash it was signed with, and can be found by any of them.
- **Durable hash.** `signer-pool` awaits an async `onSigned` before every send and aborts the
  send if it rejects (task 0016).
- **Startup.** Before serving traffic, the module re-checks every non-final record on chain by its
  hashes.
- **Channel lease.** A process takes an exclusive, renewable lease on its network's channel set,
  and doesn't serve `/settle` without it.
  - Deploys stop the old process before the new one starts.
  - Shutdown drains in-flight submissions to final or recorded-pending, then releases the lease.
- **Minimum validity.** Payloads whose auth expiration ledger is less than `minValidityLedgers`
  ahead are rejected. The transaction's ledger bound never goes past the auth expiry, through a
  new `maxLedger` submit option (task 0016).

## Rationale

- **The claim is the only race-free dedupe.** Lookup-then-write lets parallel calls both submit.
- **The fingerprint stops cross-merchant replay**, while still letting the same resource server
  retry safely.
- **Success once stops one payment unlocking many responses.** A resource server delivers on every
  `success`: with one per call, one payment header sent N times was served N times (seen on
  testnet with a stock `@x402/express` seller). Upstream's own `settle()` gives one success per
  nonce too. The costs:
  - a seller whose network lost our `success` can't get it again;
  - the success goes to whichever call marked first: one whose client dropped the connection
    after the mark, or anyone else holding the payment header (the buyer, a proxy, a log sink).
- **The outage rule keeps money and answers consistent.** Before anything is sent, refusing costs
  only a retry. Once something may have been sent, an answer that hides it (a 500 or
  `…_timeout`) would make the buyer sign and pay again.
- **The bounded wait keeps the e2e gate passing.** The canonical server's single immediate retry
  would otherwise get `pending` again and fail the payment.
- **Forward-only compare-and-set lets one event order win.** Late events can't undo final
  outcomes, and multi-hash lookup covers rebuilt transactions.
- **The lease turns the pool's in-memory sequence tracking into a single-owner rule** that the
  store enforces, not a deployment convention.

## Alternatives considered

- **Look up, then submit, then write the outcome.** Races and replay holes, as found in review.
  Rejected.
- **Synchronous write-ahead log in `onSigned`** without changing `signer-pool`. Ties durability
  to the local disk and complicates hosting (0014). Rejected in favour of an awaited hook.
- **Returning `pending` on the repeat call.** Fails the canonical resource server's single retry.
  Rejected.
- **Rolling deploys with shared channels.** Sequence-number collisions. Rejected; the lease
  forbids them.

## Consequences

- Each settlement pays one durable store write before its first send.
- While the store is down, `/settle` takes no new payments: every one is a 500 before its claim.
- The store (task 0013) must support:
  - the atomic claim;
  - compare-and-set state changes;
  - lookup by any hash;
  - the channel lease.
- Hosting (task 0014) must allow stop-before-start deploys, so a deploy has a short gap with no
  settlement.
- `signer-pool` gains `onSigned` as an async hook and the `maxLedger` option (task 0016).

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-6, AD-16, AD-17, AD-22
- [ADR 0003](0003-settlement-channel-account-pool.md),
  [Scaling x402 settlement on Stellar](../x402-settlement-scaling-en.md) (ADR-R1)
- x402 v2 `settlement_pending` and `PendingSettlementStore` in `@x402/core`; `settleWithPendingRetry`
  in the x402 resource server
