---
title: "When a settle answer may say \"sign a new payment\""
type: synthesis
status: mature
spawned_from: notes/R-sign-again-prior-art.md
spawns: []
tags: [settle, double-payment, decision]
links:
  - ../../../../../apps/facilitator/src/settlement/settle.ts
history:
  - date: "2026-10-28"
    status: developing
    who: okarcz
    note: "Options for 0073's rule, from R-sign-again-prior-art. Decision still open."
  - date: "2026-10-28"
    status: mature
    who: okarcz
    note: "Decided: options 5 + 2 for group B, option 1 for group A; 0025's drain fallback kept, with a test (0073 decisions 1-5; the cap is 66 ledgers by decision 6)."
---

# When a settle answer may say "sign a new payment"

## What the research says

Nobody else tells a payer to sign again while the old payment can still land. The spec bounds a
payload by when it "can no longer land" and keeps the one non-terminal answer,
`settlement_pending`, for a sent transaction with its hash. Upstream EVM and SVM, Coinbase's
hosted facilitator and Stripe all say the same thing: reconcile first, never start a second
payment while the first is unresolved. Upstream Stellar avoids most of the gap because its
envelope lives as long as the auth entry (`maxTimeoutSeconds`). Ours lives 60 s inside an auth
entry of up to `maxTimeoutSeconds`.

A Soroban auth entry can't be revoked. Burning its nonce early needs a call **authorized by the
payer**, so the facilitator can't do it alone.

## Our answers fall into two groups

`SETTLE_REASONS` in `apps/facilitator/src/settlement/settle.ts`:

| Group | Answers | What's still alive |
|---|---|---|
| **A. Nothing was sent** | `timeout`, `rpcUnavailable`, `interrupted`, `shuttingDown` ("sign a new payment") and, by the same logic, `noChannelInTime`, `noChannels` | The whole payload. Whoever holds it (the seller, anyone who saw it) can send it, here or elsewhere. |
| **B. Sent, envelope past its bound** | `expired` (reconciliation, once every hash is past its envelope bound) | The auth entry, until its `signatureExpirationLedger`. Anyone can wrap it in a new envelope. |

## Options

1. **"Sign again" only once the auth entry has expired.**
   - **Group A:** say "retry the same payment" while the auth entry is valid. That's safe, because our nonce record settles it once. Say "sign a new payment" only after its expiration ledger.
   - **Group B:** keep the record non-final until the auth expiry, then expire it.

   This matches the spec, upstream and Coinbase. The cost: a payer whose payment can't settle waits up to `maxTimeoutSeconds` for a final answer. Also, group A has no hash, so it can't use `settlement_pending`, which MUST carry one; it needs its own retryable code, like upstream's `…_submission_retryable` with `extra.retryable`.
2. **Align the envelope with the auth entry.** Give the envelope a ledger bound equal to the auth entry's `signatureExpirationLedger`, as upstream does with `maxTimeoutSeconds`. Then group B's `expired` is safe once it fires. The cost: a stuck transaction holds its channel for up to `maxTimeoutSeconds` instead of 60 s, so fewer channels are free during an outage. Group A is not fixed by this alone.
3. **Have the payer burn the nonce.** A client-side "cancel" that consumes the nonce in a call the payer authorizes. The cost: a transaction and its fee per uncertain payment. It needs client support we don't control, and 0043 already rejected it for the MCP payer.
4. **Accept the risk** and record why. The cost: the double payment stays possible within `maxTimeoutSeconds`, and we go against the spec family's "can no longer land" rule and Coinbase's guidance.

5. **Cap the signature's life on our side.** `/verify` refuses an auth entry that expires more than N ledgers ahead, whatever `maxTimeoutSeconds` says. The cap bounds three things at once: the channel hold, the pending wait and the double-payment window. That makes option 2 safe.
   - **The attack it closes** (okarcz, 2026-10-28): someone who calls `/settle` directly writes both the payload and the requirements, so they can sign 50 payments for 7 days. Today the 60 s time bound returns a channel after about 90 s at most. With option 2 and no cap, every transaction the network drops (surge pricing, a lost send) holds its channel until the auth expiry, because the pool lets a channel go only when the transaction is final. 50 such transactions would take the whole pool for days.
   - **What others do:** no facilitator caps this. Upstream EVM checks only `validBefore >= now + 6`; upstream Stellar bounds the auth by the caller's `maxTimeoutSeconds`. The caps that exist are client-side: a wallet clamps to 300 s, x402-dotnet's client skips above 3600 s, and upstream PR #3630 proposes a client cap. Nobody needed one on a facilitator, because only a channel pool holds something for the signature's life.
   - **The cost:** a seller asking for more than N is refused at `/verify`. 0043 found the main Stellar seller on mainnet asks 300 s.

## Decided (okarcz, 2026-10-28)

Group B: options 5 and 2, a cap of about 5 minutes (66 ledgers by default, decision 6) and an envelope that lives as long as the auth entry. Group A: option 1, retry the same payment until the auth entry expires. The deploy keeps its 180 s grace, and a test shows that 0025's fallback ends every transaction. See 0073's decisions 1-7.

## Leaning before the decision

Combine options 1 and 2:
- **Group B:** align the envelope with the auth expiry, so `expired` means "can no longer land".
- **Group A:** answer "retry the same payment" while the auth entry is valid, and "sign a new payment" only after it expires.

## Checked in the code (2026-10-28, develop `fbefe31`)

1. **We never send an old payload a second time.**
   - **The record:** it is keyed by `network:payer:nonce` (`keyOf`, `settle.ts`). States only move forward (`ports/settlement-store.ts`), and nothing deletes a record.
   - **A repeat of a closed payment:** it hits `replay()` and gets the stored answer again (`respond()`: `record.errorReason`). The same `…_timeout` or `…_expired` comes back forever, and nothing is sent.
   - **The same nonce with a different payload:** it gets `…_nonce_already_used`.
   - **So the double payment needs the old payload sent elsewhere:** through another facilitator, or straight to the network by whoever holds it (the seller, or anyone who saw the request). It can't come through ours.
   - **The cost for option 1's group A:** "retry the same payment" doesn't work today, because the closed record answers the same failure again. Group A would have to leave the record open (not final) until the auth expiry, or allow a claim to reopen. Either one changes the record lifecycle from 0019.
2. **Option 2 is a one-line change in the signer pool.**
   - **Today:** the envelope already carries a ledger bound at the auth entry's expiration (`maxLedger: verified.expirationLedger`, `settle.ts:456`, from AD-22). It also carries a time bound `now + timeoutSeconds` (60 s, `submitter.ts:610`), and the time bound is what ends it early.
   - **The change:** drop the time bound, or set it to the auth expiry's time, when `maxLedger` is set. The envelope then lives exactly as long as the authorization, as upstream's does.
   - **The cost:** only a transaction that is sent and never lands holds its channel longer, up to `maxTimeoutSeconds` instead of 60 s, and the confirm wait grows with it. A normal settlement doesn't change (0043: median 12 s, p99 65 s). The 0025 drain bound (60 s + 30 s inside the 180 s stop grace) assumes the 60 s and would need re-checking.
3. **Upstream already has the retryable shape.** `@x402/stellar` answers `TRY_AGAIN_LATER` with `settle_exact_stellar_transaction_submission_retryable` and `extra.retryable: true` (PR #3293). We have no such code; group A's answers all say "sign a new payment" in their doc comments.
