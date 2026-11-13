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

| Case                                                       | Rival transaction                                                  | Ours                                                                      | Our fee |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------- |
| Rival lands one ledger earlier                             | `bf6c8d21d467775e5d86cab556678edee25f407b78615b172404b005ebde9001` | `233ea749ea6b80b81724bc99eef0f2621faf443187a93ed9bc5858e992ab5c9d` failed | 8,800   |
| Payer signs a second entry, same nonce, 1 stroop to itself | `cc5538bd98ff116f8928c09a6c45d93fc8e0cc4322c52a923fbee099382bcf7c` | `09bc7098eeb488c90b9094f7009e7224a0d9067b0f630153e782c9610adc78c6` failed | 8,800   |

A detection prototype found the rival's transaction in 535 ms with two RPC calls: the nonce entry's
`lastModifiedLedgerSeq`, then `getTransactions` for that ledger.

## Premise

Reviewed 2026-11-12 by a fresh reviewer given only the goal and the code paths. The problem is real: both
testnet cases reproduce (rival in ledger 5694924, ours failed in 5694925). What it changed:

- Today's advice is false whatever is decided: after `scecExistingValue` the nonce is spent, so the entry
  can never land, yet `settle.ts:479-486` says it may and tells the client to sign a new payment, and the
  comment at `settle.ts:207-213` assumes a failed transaction spends no nonce.
- Answering success breaks the property that one signed entry gets at most one success across all
  facilitators, and the task's proof set can be satisfied by a transaction that carries our entry unused
  (derived from the Soroban host's auth code, not run). Put to the owner; decision 2.
- The task covers only our transaction failing on chain; the other transaction can also land before ours
  is sent, so settle's own simulation fails (3 of the 7 testnet cases). Put to the owner as scope.
- Acceptance criterion 4 is mostly met: `fee_charged_stroops{state}` counts every fee; only a split by
  cause is missing.

## Decisions so far

| #   | What is decided                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | From                         | Vs the task                                           | Who does the same (checked)                                                                                                                                                           | Code | Test |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| 1   | The fix lives in this repository as its own task; a proposal for the x402 spec is drafted separately and sent only on the owner's word                                                                                                                                                                                                                                                                                                                                                                                                                                                | owner, 2026-11-12            | the task's premise                                    | spec silent on the case (`scheme_exact_stellar.md:184-190`)                                                                                                                           |      |      |
| 2   | When our transaction fails because another transaction consumed the payer's nonce (`sceAuth/scecExistingValue`), `/settle` answers a distinct failure reason that says so, without the advice to sign a new payment; it never answers success for a transaction it did not submit. Why: answering success lets a buyer race one signed entry through two facilitators to the same `payTo` and be served twice, a profitable attack, while the failure leaves only griefing with no gain; 0 such front-runs found in ~4,500 pubnet settlements of four submitters (2026-03 to 2026-11) | owner, 2026-11-13 (option B) | changes it: the task's option A dropped               | upstream EVM exact answers `invalid_exact_evm_nonce_already_used` also after a failed submit (`mechanisms/evm/src/exact/facilitator/eip3009.ts:604-616`@f33e4cf); Stellar spec silent |      |      |
| 3   | The reason is a new code, `settle_exact_stellar_nonce_consumed_elsewhere`, not the existing `settle_exact_stellar_nonce_already_used`: the client may have paid in this case and has not in that one, and the spec tells clients to act on the code, not the message (`x402-specification-v2.md` §9)                                                                                                                                                                                                                                                                                  | owner, 2026-11-13            | beyond it                                             | upstream EVM uses one code for both (`invalid_exact_evm_nonce_already_used`); no checked facilitator has a separate one                                                               |      |      |
| 4   | Every window answers it: our transaction failed on chain, settle's own simulation failed, and `/verify`'s simulation failed (there an `invalid_` code, as `/verify` codes are named), each when the error is `Error(Auth, ExistingValue)`                                                                                                                                                                                                                                                                                                                                             | owner, 2026-11-13            | beyond it: the task covered only the failure on chain | upstream EVM checks the nonce in `/verify` (`eip3009-utils.ts:195-205`@f33e4cf); upstream Stellar answers the generic simulation code                                                 |      |      |
| 5   | After our transaction fails on chain without an error event that names `Error(Auth, ExistingValue)` (an RPC without diagnostic events), `/settle` reads the payer's nonce entry: ours wrote no nonce, so an entry means another transaction used it, and the record ends with the same code. Decision 4's `/verify` window includes `/settle`'s own re-check before the claim, which answers the `invalid_` code like every check refusal does                                                                                                                                        | owner, 2026-11-13            | beyond it                                             | the mainnet RPC provider is not chosen yet (`deploy/mainnet.env.example`); diagnostic events are an RPC setting                                                                       |      |      |
| 6 | Every writer that ends a record reads the nonce the same way when the failure names no `Error(Auth, ExistingValue)`: `/settle`'s own result, its answer when the record write fails, and reconciliation (the sweep and the pool's `resolved` event). Why: a record reconciliation ends would otherwise keep the advice to sign a new payment that decision 2 removes | owner, 2026-11-13 | beyond it | nobody checked does it | | |
| 7 | `settlement_nonce_consumed_elsewhere_total` carries a label `window`: `verify` for a refusal in `/verify` or in `/settle`'s re-check before the claim, `settle` for a record that ends with the settle code. Why: the out-of-scope lookup below waits on this counter, and a refusal before the claim writes no record (3 of the 7 testnet cases) | owner, 2026-11-13 | beyond it | nobody checked does it | | |

## Not yet decided

Nothing.

## Out of scope

- Finding the other transaction that used the nonce, to name its hash in the log or the answer. With 0
  front-runs in ~4,500 pubnet settlements it waits for data: when
  `settlement_nonce_consumed_elsewhere_total` counts cases on mainnet, the lookup is two RPC reads (the
  nonce entry's `lastModifiedLedgerSeq`, then `getTransactions` for that ledger). Owner, 2026-11-13.

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
