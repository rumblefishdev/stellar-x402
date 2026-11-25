---
title: "Who pays to create the recipient's token balance, elsewhere"
type: research
status: mature
tags: [facilitator, fees, rent, prior-art]
history:
  - date: "2026-11-23"
    status: mature
    who: akot
    note: "Web and source research (agent report) for decision 4: other chains, x402 specs, facilitators, sponsors."
---

# Who pays to create the recipient's token balance, elsewhere

**Question.** Should our Stellar facilitator pay the fee for a first payment to a `C…` `payTo`? That
payment creates the recipient's SAC balance entry: ~443,000 stroops bid, ~382,000 charged, above our
250,000 ceiling. The other option is to keep refusing with a clearer message. Our own figures come
from the brief; everything else was read on 2026-11-23.

**Repos read:** x402-foundation/x402 `b711fa9f`; OpenZeppelin relayer-plugin-x402-facilitator
`310480b`, relayer-plugin-channels `0df95e1`; rs-soroban-env `0b0f88a9`; kora `938b9b2`;
openzeppelin-relayer `e112f5d2`; faremeter `68e024e6`; x402-rs `e75adda8`. **Market data, 13:53
UTC:** SOL $72.38, ETH $1,719.54, XLM $0.1282 (api.coingecko.com); `eth_gasPrice` Base 0.006 gwei
(mainnet.base.org), Ethereum 0.353 gwei (publicnode).

## 1. Other chains

**EVM (Base, Ethereum).** There is no account creation; a holder's balance is a storage slot in the
token contract.
- A first transfer turns the slot from zero to non-zero: `SSTORE_SET_GAS` 20,000 ("If original
  value is 0, SSTORE_SET_GAS is deducted", EIP-2200) plus `COLD_SLOAD_COST` 2,100 (EIP-2929). An
  existing holder costs 2,900 + 2,100. So a new recipient adds **~17,100 gas**.
- EIP-3529 kept "20000 for the zero-to-nonzero set" and only cut refunds, so there is no deposit to
  reclaim.
- EIP-3009 already writes `_authorizationStates[from][nonce] = true` (a random nonce) on every
  call, so each x402 EVM settlement already pays one such write (my inference).
- Today that is ≈ **$0.0002** on Base (0.006 gwei; the L1 data fee is unchanged) and ≈ $0.01 on
  Ethereum L1. The facilitator pays it inside gas; no spec or facilitator mentions it.
- Sources: https://eips.ethereum.org/EIPS/eip-2200 (…/eip-2929, -3529, -3009), https://docs.base.org/chain/fees.

**Solana.**
- **The ATA must exist** before `TransferChecked`; otherwise simulation fails with
  `InvalidAccountData` (x402 #2395).
- **The deposit is now 1,488,440 lamports (0.00149 SOL ≈ $0.108)**, from mainnet
  `getMinimumBalanceForRentExemption(165)`, epoch 1094. 0.00203928 SOL (293 B × 6,960) applied
  before SIMD-0437, which steps `lamports_per_byte` down 6333 → 5080 → 2575 → 1322 → 696.
  Chainstack: steps 1–2 on mainnet 2026-09-03 and 09-11; steps 3–5 "expected with Agave 4.4 in
  November 2026", down to 203,928 lamports
  (https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0437-incremental-rent-reduction.md,
  https://docs.chainstack.com/docs/solana-rent-reduction-reclaim-excess-rent).
- **Anyone can pay.** The funder is "`[writeable,signer]` Funding account (must be a system
  account)" (solana-program/associated-token-account `interface/src/instruction.rs`).
- **The refund goes to the owner.** "Close an account by transferring all its SOL to the
  destination account. Non-native accounts may only be closed if its token amount is zero", signed
  by the owner (solana-program/token `interface/src/instruction.rs:197-211`). Privy: the refund
  "goes to the account owner, not the fee payer".
- That is the farming loop: close, keep the rent, and the next sponsored charge funds a new ATA.

**NEAR, Sui, Aptos** (each has an x402 `exact` spec).
- **NEAR refuses.** `storage_balance_of(payTo)` "MUST return a non-null value"; the facilitator
  "MUST NOT sponsor payloads that would require relayer funds beyond the `Action::Delegate` gas and
  the exact attached deposits" (`scheme_exact_near.md:150,202`). The TS error is
  `invalid_exact_near_recipient_not_registered_for_storage` (`near/src/exact/facilitator/scheme.ts:319`).
- **Sui and Aptos pay it as gas.** Sui creates a coin object per payment, which the receiver can
  merge, "recouping a majority of the storage fee" (`scheme_exact_sui.md:94`). Aptos's
  `primary_fungible_store::transfer` "Auto-creates primary stores" (`scheme_exact_aptos.md:225`);
  the amount is [unverified].

## 2. x402 specs

**SVM today** (`specs/schemes/exact/scheme_exact_svm.md`):
- **Origin.** PR #3221 (lgalabru, merged 2026-10-26, with multi-payee splits) added
  `extra.ataCreationRequired` (set by the resource server per recipient) and `ataCreationSponsored`
  (the facilitator's `/supported` `kinds[].extra`). Both are "Absent ⇒ `false`". With both set, the
  client adds `CreateIdempotent` funded by the `feePayer`; client-funded creation "is not part of
  this extension".
- **Without them,** "A Sponsor MUST reject any transaction in which the fee payer funds ATA creation
  for an unmarked recipient … or when it has not advertised ATA sponsorship
  (`split_ata_creation_not_authorized`)". Create instructions for unmarked recipients "MUST NOT
  appear … regardless of who funds them".
- **Warning:** "**not** bounded over time. An owner can close its ATA, reclaiming the rent … and the
  next charge funds creation again … and can rotate `payTo` addresses to the same effect".
- **Mitigations:** "tracking sponsored creations per owner and mint and refusing or pricing repeats,
  by rate-limiting sponsored creations per Resource Server, or by recovering the cost through a
  split to itself" (§5.4).
- **Chain-agnostic rule** (`scheme_exact.md:40`, same PR): "no operation in the signed payment may
  debit the facilitator beyond that fee. The only exception is a cost the facilitator explicitly
  advertises that it covers".
- **Not implemented in any SDK.** No TS, Python or Go code mentions `ataCreationSponsored`. TS
  Path 1 classifies the ATA program as `"unknown"`, so it is rejected as
  `invalid_exact_svm_payload_unknown_instruction` (`svm/src/exact/facilitator/instructionLayout.ts:28-52,196`).
- **Error for a missing ATA:** since PR #3962 (2026-10-27) it is
  `invalid_exact_svm_recipient_ata_missing`, after the failed simulation (`scheme.ts:1305-1336`).

**SVM history:**

| Date | What changed | Source |
|---|---|---|
| 2025-08-30 | The first client added Create-ATA for a missing `payTo` ATA, with `payer: …extra?.feePayer`, so the facilitator paid | #283, `typescript/packages/x402/src/schemes/exact/svm/client.ts:185-214` @ `26f132bf` |
| 2025-10-30 | Spec: "Optional: Associated Token Account Create"; the destination ATA "MUST exist if and only if the Create ATA instruction is NOT present". Yet the fee payer "MUST NOT appear in the `accounts` of any instruction" | #546 |
| 2025-11-12 / 11-25 | Create-ATA removed from code ("for now it's simplest to just remove it"), then from the spec. The legacy verifier throws `…receiver_ata_not_found` (`legacy/…/verify.ts:361-362`) | https://github.com/x402-foundation/x402/pull/613, #667 |
| 2026-01-23 | Issue #1020 (open). Maintainer: "That's by design … Attacker closes the ATA via `closeAccount` … Repeat … seen in the wild." | https://github.com/x402-foundation/x402/issues/1020 |
| 2026-07-06 | PR #2798 (pinned, facilitator-funded `CreateIdempotent`) closed: "would introduce a facilitator griefing attack vector as discussed in #1020". Pinning stopped rent redirect, not rent reclaim | https://github.com/x402-foundation/x402/pull/2798 |

**EVM** (`scheme_exact_evm.md`): nothing on the recipient's balance; no account creation exists.

**Stellar** (`scheme_exact_stellar.md`):
- Nothing on a C-address `payTo`, a missing balance or a trustline. "Supports both C-accounts and
  G-accounts" (`:219`) is about the payer.
- **Fee ceiling** (`:160-162`): `maxTransactionFeeStroops` "MAY" exist, "(default: **50,000
  stroops**, operator-overridable). If the simulation-derived settlement fee exceeds this ceiling,
  the facilitator MUST reject verification with `invalid_exact_stellar_payload_fee_exceeds_maximum`
  … normal transfers should fall well below the default ceiling". Added by PR #2852 (2026-07-17).
- **The client can't pay the rent in x402:** the facilitator "MUST NOT use the client's fee bid",
  and a non-sponsored flow "will be added later" (`:62`).

**Stellar mechanics:**
- **Where balances live.** A C-address balance is a persistent entry created "when an
  `Address::Contract` is on the receiving end of a successful transfer". A G-address needs a
  trustline: "If the trustline or account is missing, any function that tries to interact with that
  balance will fail" (https://developers.stellar.org/docs/tokens/stellar-asset-contract).
- **TTL.** The minimum for a new persistent entry is "2,073,600 ledgers (about 120 days) on Mainnet"
  (https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival).
  The SAC extends a balance to 30 days on each write (`storage_types.rs:8`, `balance.rs:74-97`).
  Restoring an archived entry: "normal rent and fees still apply".
- **No delete, no existence check.** `balance.rs` never deletes a balance entry, so there is no
  close-and-reclaim path. `receive_balance` (`:100-145`) writes for any `ScAddress::Contract`
  without checking that the contract exists (code reading, untested).

## 3. Real facilitators

- **Coinbase CDP.** `/supported` needs auth (401). The documented Solana `extra` is only `feePayer`
  and `transactionVersions`. The docs mention only the sender's ATA (`…sender_ata_not_found`). The
  error enum lists `…receiver_ata_not_found`; whether it is returned is [unverified]. No gas cap is
  documented for Base (https://docs.cdp.coinbase.com/x402/support/troubleshooting).
- **PayAI.** "That wallet's associated token account for this mint must exist before settlement …
  that sponsorship does not fund merchant account setup"
  (https://docs.payai.network/x402/solana-network-identifiers). Its client: "The receiver must
  create their token account before receiving payments" (x402-solana
  `src/client/transaction-builder.ts:125-128`). Live `/supported` advertises neither flag. Its
  portal, outside x402, "may sponsor the first linked Solana wallet's USDC ATA … within its daily
  allowance".
- **x402-rs.** `CreateATANotSupported` ("destination ATA must exist"). A missing ATA is reported as
  `RecipientMismatch` (`crates/chains/x402-chain-solana/src/v1_solana_exact/facilitator.rs:240-243,498-502`).
- **Faremeter.** The x402 client never creates `payTo`'s ATA, and the verifier allows only
  Lighthouse and Memo (`packages/payment-solana/src/exact/verify.ts:29-30`). Its MPP `charge`, which
  is not x402, has a fee-payer-funded `ataCreationRequired`.
- **thirdweb, Heurist.** thirdweb doesn't document the case. Heurist has no Solana
  (https://docs.heurist.ai/x402-products/facilitator).
- **`@x402/stellar` refuses.** `DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 50_000`
  (`mechanisms/stellar/src/exact/facilitator/scheme.ts:36`), checked against `minResourceFee +
  inclusionFee` (`:539-549`). `payTo` may be G, C or M (`constants.ts:22`). So it would **refuse
  this payment**, at a ceiling five times lower than ours.
- **OpenZeppelin x402 plugin (Stellar) pays by default.** "When unset, no fee ceiling is applied"
  (`README.md:141`, `src/stellar/verify.ts:428-449`). Channels caps spend per API key instead:
  `FEE_LIMIT`, "Default max fee per API key in stroops (disabled if not set)", over a reset period
  (relayer-plugin-channels `README.md:235-236`). Neither mentions C-address rent.

## 4. Gas-sponsorship services

- **Kora: opt-in, off by default.** `allow_create_account` defaults to false (`config.rs:318-330`).
  When off: "Fee payer cannot fund ATA creation (Create or CreateIdempotent)"
  (`transaction_validator.rs:274-292`). Its own x402 demo sets `false` (`examples/x402/demo/kora/kora.toml:78`).
  Rent is fee-payer outflow, billed to the user under `margin` and capped by `max_allowed_lamports`.
- **OpenZeppelin Relayer (Solana): pays, then charges.** `transferTransaction` creates the
  destination ATA with the relayer as payer and adds the rent to the fee, which the user pays in SPL
  by default. Capped by `max_allowed_fee_lamports` (`rpc/methods/utils.rs:195-215,488-503`).
- **Octane: a separate endpoint.** `/api/createAssociatedTokenAccount` charges a token fee "higher
  than usual". Otherwise: "Transaction can't create new accounts" (mirror huggingbot/octane
  `docs/endpoints.md:59-81`; the original repo is gone).
- **Circle Gas Station: off by default.** "does not pay for ATA creation unless you use Solana ATA
  sponsorship", "a permissioned feature". On abuse, Circle "will suspend your account and charge you"
  (https://developers.circle.com/wallets/gas-station/solana-ata-sponsorship).
- **Alchemy: on by default.** "You do not need to opt in", and rent is "added to your monthly
  bill". Rent through CPI needs `prefundRent` and a `maxSpendPerTxnUsd` cap
  (https://www.alchemy.com/docs/wallets/transactions/solana/sponsor-gas).
- **Privy.** The app pays. It advises stripping `CloseAccount` and setting caps
  (https://docs.privy.io/wallets/gas-and-asset-management/gas/security). Billing is [unverified].

## Summary table

| Chain / service | Extra cost for a new recipient? | How much | Who pays | Refused or paid | Source |
|---|---|---|---|---|---|
| EVM: Base / L1 (EIP-3009) | Yes, gas only | ~17,100 gas ≈ $0.0002 / $0.01 | Facilitator (gas) | Paid, unmentioned | eips.ethereum.org/EIPS/eip-2200 |
| Solana ATA | Yes, rent deposit | 1,488,440 lamports ≈ $0.108 | Any signer; refund to owner | Refused by default | solana-program/token; SIMD-0437 |
| x402 SVM spec (2026-10-26) | as Solana | ≈0.002 SOL / ATA | Fee payer if both flags | Opt-in, else reject | x402 PR #3221 |
| `@x402/svm`, x402-rs, Faremeter | as Solana | — | — | Refused | `instructionLayout.ts:196`; x402-rs `facilitator.rs:240` |
| Coinbase CDP (Solana) | as Solana | — | — | Not advertised; undocumented | docs.cdp.coinbase.com |
| PayAI | as Solana | — | Seller | Refused | docs.payai.network |
| NEAR (x402) | Yes, NEP-145 storage | [unverified] | Recipient | Refused | `scheme_exact_near.md:150,202` |
| Stellar G `payTo` | Trustline needed | — | Recipient | Payment fails | developers.stellar.org (SAC) |
| Stellar C `payTo` (ours) | Yes, new persistent entry | ~382,000 stroops ≈ $0.005 (~31×) | Facilitator (fee) | — | brief; `balance.rs:74-145` |
| `@x402/stellar` | as above | ceiling 50,000 | — | Refused | x402 `stellar/…/scheme.ts:36,539` |
| OZ x402 plugin (Stellar) | as above | no ceiling by default | Relayer | Paid; Channels caps per key | relayer-plugin-x402-facilitator |
| Kora | Solana ATA | rent | User (`margin`) | Opt-in, off by default | kora `config.rs:318` |
| OZ Relayer (Solana) | Solana ATA | rent in fee | User (SPL) | Paid and charged | openzeppelin-relayer `utils.rs:488` |
| Octane | Solana ATA | higher token fee | User | Separate endpoint | huggingbot/octane |
| Circle Gas Station | Solana ATA | rent | Developer | Off; permissioned | developers.circle.com |
| Alchemy | Solana ATA | rent | Developer | On by default; capped | alchemy.com/docs |

## What this suggests for us

- **Refusing is the norm.** In x402, refusing and having the seller set up the receiving account
  once is the norm: the reference SDKs, x402-rs, Faremeter, PayAI and the NEAR spec all do it, and
  `@x402/stellar` would refuse our case at its own 50,000 default. Paying always comes as an
  advertised opt-in with caps (the SVM flags, Kora, Circle).
- **Refusing well needs a dedicated error and the fix.** Upstream added
  `invalid_exact_svm_recipient_ata_missing` for exactly this (#3962). We would detect the missing
  (`asset`, `payTo`) entry directly rather than from the fee, and say that one transfer from the
  seller's own wallet creates it. That fix is inferred from the SAC docs, not tested.
- **Stellar lacks Solana's profit loop.** No balance is ever deleted and no rent returns to an
  owner. What remains is griefing by rotating invented C-addresses, at ≈ $0.005 to us each (untested
  that an invented C-address can be paid). Pubnet API keys (0105) already make that Sybil-costly.
- **If we pay, follow §5.4's bounds.** Pay once per (`asset`, `payTo`) with a record, keep a per-key
  or per-day budget, and raise the ceiling only when the simulation creates exactly that entry.
  Advertise it as `scheme_exact.md:40` asks; a Stellar analogue of `ataCreationSponsored` could be
  proposed upstream.
- **The money is small; the precedent is not.** About $0.005 per new seller is far below Solana's
  $0.108. What decides it is control (exposure unbounded over time) and consistency with other
  facilitators.
