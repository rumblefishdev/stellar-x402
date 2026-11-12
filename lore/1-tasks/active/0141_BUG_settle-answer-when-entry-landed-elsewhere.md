---
id: "0141"
title: "Answer the seller correctly when the payer's auth entry landed in another transaction"
type: BUG
status: active
related_adr: []
related_tasks: ["0024", "0124", "0043"]
tags: [facilitator, settlement, payments, priority-high, effort-small]
links:
  - ../../../docs/threat-model.md
history:
  - date: "2026-11-12"
    status: backlog
    who: karolkow
    note: >
      Found on testnet while stress-testing ways to label settlements: a third party settled the
      payer's signed auth entry first, and our /settle answered "failed, sign a new payment".
  - date: "2026-11-12"
    status: active
    who: karolkow
    note: "Work starts."
---

# Answer the seller correctly when the payer's auth entry landed in another transaction

## Summary

As a seller, I want `/settle` to tell me "paid" when the buyer's payment reached me through someone
else's transaction, so that I serve a buyer who paid and the buyer is not told to pay again.

## Context

- The payer's signed auth entry floods the network inside our pending settlement for 3–6 s. Anyone who
  sees it can submit it first in their own transaction. The money still goes to the seller, because the
  payer's signature pins payee and amount. Our transaction then fails with
  `invokeHostFunctionTrapped` / `sceAuth/scecExistingValue` and we pay its fee.
- Today the submitter returns `failed` (`packages/signer-pool/src/submitter.ts:973-974, 1013-1025`), the
  record is finished as `settle_exact_stellar_transaction_failed` (`apps/facilitator/src/settlement/settle.ts:766-779`),
  and the answer adds "the auth entry may still land … sign a new payment once that ledger has closed"
  (`settle.ts:479-486`). Reconcile does not look for another transaction (`reconcile.ts:94, 259, 266, 298, 378-395`).
  No alarm fires and no breaker opens.
- A consumed nonce alone is not proof of payment: the payer can sign a second entry with the same nonce
  for another transfer. Then our transaction fails with the same error and the seller got nothing.
- `docs/threat-model.md:393-394` ("the payer signed one payment and it settled") assumes otherwise.
- Upstream: the reference settle (`@x402/stellar`, `exact/facilitator/scheme.ts:376-388`) and the exact
  spec (`specs/schemes/exact/scheme_exact_stellar.md:184-190`) answer the same way; related upstream
  issues #3110 and #3438.

### Measured on testnet, 2026-11-12

| Case | Rival transaction | Ours | Our fee |
| --- | --- | --- | --- |
| Rival lands one ledger earlier | `bf6c8d21d467775e5d86cab556678edee25f407b78615b172404b005ebde9001` | `233ea749ea6b80b81724bc99eef0f2621faf443187a93ed9bc5858e992ab5c9d` failed | 8,800 |
| Payer signs a second entry, same nonce, 1 stroop to itself | `cc5538bd98ff116f8928c09a6c45d93fc8e0cc4322c52a923fbee099382bcf7c` | `09bc7098eeb488c90b9094f7009e7224a0d9067b0f630153e782c9610adc78c6` failed | 8,800 |

A detection prototype found the rival's transaction in 535 ms with two RPC calls: the nonce entry's
`lastModifiedLedgerSeq`, then `getTransactions` for that ledger.

## Decisions so far

| # | What is decided | From | Vs the task | Who does the same (checked) | Code | Test |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | The fix lives in this repository as its own task; a proposal for the x402 spec is drafted separately and sent only on the owner's word | owner, 2026-11-12 | the task's premise | spec silent on the case (`scheme_exact_stellar.md:184-190`) | | |

## Not yet decided

- **What `/settle` answers when the payer's entry landed in another transaction.**
  - A — detect it with every proof (the same signed entry byte for byte, the nonce created in that
    transaction's meta, a matching transfer event to the seller, the consuming ledger closed after the
    request, an RPC read at or past our failed ledger) and answer success with that transaction's hash
    and a `settledBy` marker; log and count `settlement_settled_elsewhere`; blame the payer for a
    second entry under the same nonce; correct the threat model. Residual: one payment routed through
    two facilitators at once could be served twice.
  - B — a distinct failure reason ("the nonce was used by another transaction") without the advice to
    sign a new payment; the seller still refuses a buyer who paid.
  - C — leave the answer; correct the threat model only.

## Implementation

- Depends on the decision above. For A: the three writers of a final record (`settle.ts:766-779`,
  `reconcile.ts:298`, `reconcile.ts:378-395`), a `getTransactions` method on the RPC client
  (`packages/signer-pool/src/types.ts:8-16`, FallbackRpc), attribution in `apps/facilitator/src/spend/attribution.ts`,
  `docs/threat-model.md:387-404`, `docs/monitoring.md`.

## Acceptance Criteria

- [ ] The open decision is taken and recorded above
- [ ] A test reproduces both measured cases (rival lands first; second entry under the same nonce) and
      pins the chosen answer
- [ ] `docs/threat-model.md` states what a consumed nonce proves and what it does not
- [ ] The fee lost per incident is visible in logs or metrics
