# ADR 0006: The settlement record: claim, replay, lifecycle and channel lease

- Status: accepted
- Date: 2026-10-07

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
  - A repeat with the same fingerprint returns the record's outcome. If the record is still
    pending, it first waits, bounded by the settle timeout, for the final outcome.
  - A repeat with a different fingerprint is rejected, and nothing is submitted.
- **Wire mapping.**
  - `success` → `{success: true, transaction, network, payer}`
  - `pending` → `{success: false, errorReason: "settlement_pending", transaction, network}`
  - other outcomes and each thrown submitter error → a fixed `errorReason`
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
