---
title: "Sign again while the old authorization is valid: the x402 spec, upstream facilitators and prior art"
type: research
status: mature
spawns: ["notes/S-sign-again-rule.md"]
tags: [x402, settle, double-payment, soroban-auth, research]
links:
  - https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact.md
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md
  - https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046-11.md
  - https://docs.cdp.coinbase.com/x402/support/faq
  - https://docs.stripe.com/error-low-level
history:
  - date: "2026-10-28"
    status: mature
    who: okarcz
    note: >
      Web research for 0073: the x402 spec, upstream x402-foundation/x402 at ec61ea5a, Coinbase's
      hosted facilitator docs, CAP-0046-11, EIP-3009, Solana confirmation docs and Stripe. The
      OpenZeppelin Relayer x402 plugin was left out (AGPL, clean-room rule).
---

# Sign again while the old authorization is valid: the x402 spec, upstream facilitators and prior art

Question: when may a facilitator tell a payer to sign a new payment, given that the payment they
already signed may still land? All sources accessed 2026-10-28. Upstream code was read at
`x402-foundation/x402` `ec61ea5a` (2026-10-28).

## The x402 spec

- **No "sign a new payment" code.** The core spec's settle failures are `invalid_transaction_state`
  and `unexpected_settle_error`; nothing means expired, interrupted or timed out. Clients match on
  `errorReason`, never on text ([x402-specification-v2.md], commit `51a0664c`, 2026-10-26).
- **`settlement_pending` is the one non-terminal answer**, and it "MUST carry a non-empty
  `transaction` (the broadcast hash) and `network` so the caller can reconcile on chain before
  deciding whether to retry" (same file).
- **The family rule bounds a payload by when it "can no longer land".** `scheme_exact.md` (commit
  `477bdc74`, 2026-10-26): every method declares its replay primitive and validity window;
  "A consumed primitive MUST produce a settlement failure, never a success"; dedup keys are kept
  "until its payment can no longer land". Checked against the file on `main`.
- **The Stellar binding doesn't tie the auth lifetime to the envelope.** The client sets the
  expiration to `currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)` and the
  facilitator checks only that it doesn't exceed that. No `settlement_pending`, no lower bound
  ([scheme_exact_stellar.md], commit `7488a46f`).
- **SVM makes "can no longer land" concrete:** dedup entries are evicted after 120 s, about twice
  the blockhash lifetime, because after that the transaction "cannot land on-chain regardless"
  (scheme_exact_svm.md, commit `72dde233`).
- PR #3083 (merged 2026-08-17) added `settlement_pending` because "preserving the hash is safer
  than reporting a terminal failure that could lead callers to retry a completed payment."
  Open issue #3208 proposes a status vocabulary and argues the receiver "MUST NOT issue a new
  payment challenge" once an authorization was sent (proposal only).

## Upstream facilitators

- **Stellar (`@x402/stellar`):** the envelope is built with
  `.setTimeout(requirements.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)`
  (`typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts:289`, checked), so the
  envelope and the auth entry live about as long. After `maxTimeoutSeconds` of polling it answers
  `settle_exact_stellar_transaction_failed`, the same code as an on-chain failure; it has no
  pending answer. `TRY_AGAIN_LATER` answers `…_submission_retryable` (PR #3293, 2026-10-22).
  **Our 60 s envelope inside a 300 s auth entry is our own design, not inherited.**
- **EVM:** `validBefore = now + maxTimeoutSeconds`. A receipt wait that fails answers
  `settlement_pending` and stores the hash in a `PendingSettlementStore` keyed by the signature;
  a retry of the same payload reconciles instead of broadcasting again.
- **SVM:** three outcomes. A send that failed releases the dedup lock ("blockhash may still be
  valid"); a definite on-chain failure releases it; a confirmation not seen in time keeps it,
  since "a fresh broadcast would double-spend", and answers pending.
- **Core:** `x402ResourceServer` retries settle once with the identical payload, only on
  `settlement_pending` with a hash. The client SDK has no re-sign rule; a hook decides.
- **Coinbase's hosted facilitator** (CDP FAQ, checked): `settlement_pending` is not a failed
  payment; "Reconcile the returned transaction before requesting another payment"; "creating a
  new payment while the first transaction is still pending can charge the buyer twice."

## Cancelling a signed Soroban authorization

- **No revoke.** CAP-0046-11 (Final, Protocol 20) has no cancel or revoke; a signature is valid
  until its `signatureExpirationLedger` (inclusive), and its nonce "can't be reused until the
  signature expires."
- **Anyone holding the entry can land exactly what it signs:** front-running "becomes a no-op,
  unless exactly the same operation is performed". For a payment that is the transfer itself.
- **A nonce is consumed only by a real call**, stored as a temporary entry keyed by (address,
  nonce) and live until the consuming credential's expiration. A second use fails.
- **Burning it early is possible, not built in (inference, medium confidence):** a different call
  authorized by the same address with the same nonce writes the entry first, and the old payload
  then fails. It costs one on-chain transaction, which any account can pay, and the burning
  credential's expiration must be at least the old one's. Not evidenced: the fee, and which
  minimal call a SAC accepts. 0043 measured the same idea on testnet (works both ways).
- **EVM has an explicit cancel:** EIP-3009 `cancelAuthorization` marks the nonce used; Circle's
  USDC implements it and anyone with the signed cancel can submit it. Nothing in upstream x402
  calls it. Permit2 has `invalidateUnorderedNonces`.
- **Solana gives a chain-observable dead signal:** a transaction's blockhash lasts about 60–90 s,
  and it is definitely expired once the confirmed block height passes `lastValidBlockHeight`.

## Prior art in payments

- **Stripe:** treat a `500` "as indeterminate … Don't retry with a new idempotency key until
  you've resolved the original outcome", and "If the original outcome remains unknown, reconcile
  it before starting another operation" ([error-low-level], checked by the researcher).
  "Sign a new payment" is the x402 version of a new idempotency key.

## Not found

- Any spec or upstream code that makes "sign again" wait for the auth expiry.
- Any Stellar wallet or SDK helper that burns an auth entry's nonce.
- The CDP "Settlement Pending and Reconciliation" page (linked from the FAQ, not read).

[x402-specification-v2.md]: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
[scheme_exact_stellar.md]: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md
[error-low-level]: https://docs.stripe.com/error-low-level
