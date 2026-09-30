---
title: "exact-on-Stellar facilitator rules: which carry over to upto"
type: research
status: mature
tags: [x402, exact, facilitator, spec]
links:
  - ../sources/scheme_exact_stellar.md
history:
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "Mapped each exact rule to upto: keep, adapt or drop"
    spawned_from: ["notes/I-section-6-2-review-findings.md"]
---

# exact-on-Stellar facilitator rules: which carry over to upto

Source: [`scheme_exact_stellar.md`](../sources/scheme_exact_stellar.md). This note is input for
`scheme_upto_stellar.md` and for the facilitator's upto verifier. It is not part of the contract.

| `exact` rule | For `upto` | Why |
|---|---|---|
| 1 `invokeHostFunction` op, contract = `requirements.asset`, fn `transfer`, 3 args | **Adapt**: contract = the canonical UptoProxy, fn `settle_upto`, 10 args; `token` arg = `requirements.asset`, `to` = `payTo`, `facilitator` = our address | The payment goes through the proxy |
| amount arg = `requirements.amount` | **Adapt**: at verify, `max_amount` = `requirements.amount`; at settle, `actual_amount` = `requirements.amount` and `<= max_amount` | Phase-dependent amount (R-x402-upto-specs) |
| Address credentials only (V1 or V2); no source-account or delegate credentials | **Keep for the client's entry.** The facilitator's own entry is source-account or V2 | The client must sign |
| `rootInvocation` MUST NOT have sub-invocations | **Adapt**: exactly **one** sub-invocation, `token.approve(from, proxy, max_amount, allowance_expiration_ledger)`, with no further children | The design needs approve inside the tree |
| Expiry `<= currentLedger + ceil(maxTimeoutSeconds / 5)` | **Keep**, and also require `allowance_expiration_ledger == signatureExpirationLedger` and `deadline` consistent with it | One consistent window |
| Facilitator is never the tx or op source provided by the client | **Keep** | |
| Facilitator is never `from` | **Keep** | |
| Facilitator address "MUST NOT appear in any authorization entries" | **Narrow**: it may not appear in a **client-signed** entry except as the signed `facilitator` value; its own separate entry is required | F2: `facilitator.require_auth()` |
| Simulation shows only the expected balance changes | **Keep**: `from -actual`, `to +actual`, plus an allowance write for `(from, proxy)`; nothing else | |
| Fee from fresh simulation plus a buffer of at least 100 stroops; ignore the client's fee | **Keep** | |
| `maxTransactionFeeStroops` default 50,000 | **Adapt**: the spike measured 38.6k (facilitator as source) and **47.3k (channel account plus a signed facilitator entry)**. `upto` needs its own, higher default | Evidence in R-testnet-spike |

## New rules that `upto` needs

- **Verify.** The auth entry's root args must equal the recomputed custom args. `nonce` must be
  unused: `is_nonce_used` is false **and** `(from, nonce)` is not in the facilitator's own
  settled-nonce record (the on-chain entry expires; G- spec §8.1). The time window must be valid. Simulate with
  `actual = max_amount` (the worst case), which needs the payer's balance to be at least `max`.
- **Settle.** Re-verify against the **signed** `max_amount`, not `requirements.amount`. Then
  rebuild the transaction with the actual amount. A zero amount means no transaction:
  `transaction: ""`, `amount: "0"`.
- **Client draft source.** The client must not use its own account as the draft transaction's
  source. It uses the facilitator address from `/supported`. See R-soroban-auth-model.
- **Wire format.** One option is to reuse `exact`'s `payload.transaction` (XDR) as is. At settle
  the facilitator swaps the `actual_amount` arg (index 5) and its own auth. Deciding this belongs
  to the spec task.
