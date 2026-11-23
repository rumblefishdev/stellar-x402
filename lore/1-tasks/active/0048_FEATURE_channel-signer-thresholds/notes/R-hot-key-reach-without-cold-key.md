---
title: "Limiting one hot key's reach without a cold key"
type: research
status: mature
spawns: []
tags: [keys, thresholds, security, mainnet]
links:
  - ../../../../../docs/adr/0013-facilitator-key-custody.md
  - ../../../../../docs/architecture/m1-spine.md
history:
  - date: "2026-11-23"
    status: mature
    who: okarcz
    note: "Research on option 2 of the re-check: Stellar first, then Ethereum and Solana standards. Primary sources only."
---

# Limiting one hot key's reach without a cold key

Research for task 0048 (re-check of the hot key's power before mainnet), done on 2026-11-23.
Sources are primary (Stellar docs/XDR/CAPs/SEPs, EIPs, Safe, Solana, Squads).
The OpenZeppelin Relayer and its x402 plugin were not used or read.

## Summary

1. On a Stellar classic account the **only** native limit on a key is weight vs thresholds. There is no per-operation policy, spending limit or timelock for classic signers, and Soroban contract accounts **cannot** be a transaction source or a fee-bump fee source, so they can't replace channels or the fee account.
2. Without a second key you can still limit the hot key: set the thresholds it must not reach **above its weight with no other signer**. The protocol allows this; that power is then gone for good (SDF documents the same pattern as "locking" an issuer, and the "key below medium" pattern for anchors).
3. The real choice is: **burn the dangerous powers** (no second key; accounts become disposable; loss and theft both mean "abandon and recreate") or **split them across 2-of-3 independent online custodians** (in-place rotation and recovery, more infra). Ethereum and Solana have no answer that fits a single classic key: Ethereum limits keys only through smart-account code (ERC-4337/7579), and Solana keypair accounts can't be limited at all; both fall back on small balances, top-ups and alerts.
4. Recommendation: lock the fee account's hot key below medium (fee bumps only), lock every channel's hot key below high, keep value small, treat accounts as disposable. Move to 2-of-3 online custodians at the next channel generation, if stranded reserves or in-place rotation start to matter.

## Stellar findings

**Thresholds are the whole toolbox for classic accounts.**
- An operation is authorized when the signature weights sum to at least its threshold ([Signatures and multisig, "Thresholds"/"Authorization"](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)).
- SetOptions is **High** when it changes the master weight, a threshold or a signer, and **Medium** for anything else. AccountMerge is High. Payment, InvokeHostFunction, CreateAccount, ManageData, BeginSponsoringFutureReserves and RevokeSponsorship are Medium. BumpSequence is Low ([List of operations](https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations)).
- A fee-bump's fee source needs only its **low** threshold ([Fee-bump transactions, "Validity of a fee-bump transaction"](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions)).
- A classic account's authority inside Soroban (`require_auth` on a G address) uses its **medium** threshold ([Authorization, "Account Abstraction > Stellar Account"](https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization)).

**Does some signer have to reach high?** No. The protocol accepts an account where no signer reaches high. Changing signers, thresholds or the master weight, and AccountMerge, then become impossible forever, while medium and low operations keep working. SDF documents this as a deliberate pattern: locking an issuing account so it is "completely frozen", which they warn is irreversible ([Control asset access, "Limiting the supply of an asset"](https://developers.stellar.org/docs/tokens/control-asset-access)). The multisig page warns that a master weight of 0 "may permanently lock you out" ([Signatures and multisig](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)). For us, the effect is to drop the hot key's high power without adding a key.
- **A key below medium is SDF's own hot-key pattern:** an extra key "below your anchor account's medium threshold" so a compromise can't issue credit ([Signatures and multisig, "Example 1: Anchors"](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)).
- **SDF hot-wallet guidance:** "The SDP wallet should be used primarily as a hot wallet with a limited amount of funds to minimize potential losses" ([SDP admin guide, security.mdx line 111](https://github.com/stellar/stellar-docs/blob/main/docs/platforms/stellar-disbursement-platform/admin-guide/security.mdx)). The channel-accounts guide has no key or threshold guidance ([Channel accounts](https://developers.stellar.org/docs/build/guides/transactions/channel-accounts)).

**Pre-authorized transaction signers.** The account adds a future transaction's hash as a signer. That transaction must be prepared "with the proper sequence number". The signer is removed automatically once the transaction applies, and stays otherwise ([Signatures and multisig, "Pre-authorized Transaction"](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)).
- Fragile for channels: the channel's sequence moves with every settlement, so a recovery transaction sourced from the channel goes stale at once. Sourcing it from a dedicated, otherwise idle account fixes the sequence, but that account then needs its own authorization (its own pre-auth signer or a key).
- It can only do one fixed thing. "Swap to a new hot key" needs that new key generated in advance and kept somewhere, which makes it a cold key. "Merge the channel back to our funder" works without one, and a leaked envelope can only send XLM back to us.
- An active thief defeats it anyway: AccountMerge fails while the account has subentries, and the stolen key can fund the channel and add trustlines or data entries, which needs medium only. Net value: recovering about 1.5 XLM of reserve per channel, minus 0.5 XLM for the extra signer. Not worth it.

**Hash(x) signers.** "allows anyone who knows x to sign", and x "will be known to the world as soon as a transaction is submitted" ([Signatures and multisig, "Hash(x)"](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)). At a weight that reaches high, x is a bearer secret that isn't bound to any transaction and becomes public on first use. That makes it **a cold key in disguise, and a weaker one**. Whether it is removed after use is not stated on that page (unverified).

**Sponsorship gives no recovery power.**
- RevokeSponsorship only removes or transfers the sponsorship of entries and signers. It fails with `LOW_RESERVE` if the owner can't afford the reserve.
- The sponsor gets the right "to unilaterally end the relationship" and nothing over the account's balance or contents ([CAP-33](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0033.md); [Sponsored reserves, "Revoke sponsorship"](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves)).
- So a sponsor can't reclaim the reserve of a frozen channel either: sponsorship moves where the reserve sits, not who controls the account.

**SEP-30 (account recovery).** Two or more recovery servers are added as signers, each at weight 1, with thresholds of 2. Each server signs a SetOptions that adds a new key after the user authenticates by phone, email or SEP-10. Status: **Draft** 0.8.1, 2021 ([SEP-30](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0030.md)). It is built for end-user wallets with identity authentication. Its shape is the useful part: **independent online co-signers, none sufficient alone**, which is option B2 below.

**Soroban contract accounts can't stand in for channels or the fee account.**
- In the XDR, `Transaction.sourceAccount` and `FeeBumpTransaction.feeSource` are `MuxedAccount`, which is only `KEY_TYPE_ED25519` or `KEY_TYPE_MUXED_ED25519`. A C address can't be either ([stellar-xdr Stellar-transaction.x](https://github.com/stellar/stellar-xdr/blob/curr/Stellar-transaction.x), `union MuxedAccount`, `struct Transaction`, `struct FeeBumpTransaction`).
- The docs agree: "A smart wallet can't pay its own transaction fees" ([Smart wallets, "Accounts and relayers"](https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets)), and "A contract account, such as a smart wallet, can't sign the inner transaction" ([Fee-bump transactions, "Common use cases"](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions)).
- `__check_auth` policies (limits, allow lists, timelocks) protect only what a contract account itself authorizes ([Smart wallets](https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets)). Our hot key's powers sit on classic accounts.
- CAP-71 (Final, protocol 27) adds delegated authentication for **custom (contract) accounts** and address-bound Soroban credentials (`SOROBAN_CREDENTIALS_ADDRESS_WITH_DELEGATES`, `ADDRESS_V2` in curr XDR). It does not change classic signers or thresholds ([CAP-71](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md)).

**Limits of the signer set.** A transaction carries at most 20 signatures, and each signer beyond the master key costs one base reserve, 0.5 XLM ([Signatures and multisig](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig)).

## Ethereum findings

- **EOAs can't be limited.** EIP-7702 delegation gives the delegated code "unrestricted access to the account", and "it is also not possible to implement a system of permissions at this level" ([EIP-7702, Rationale "Interaction with applications and wallets"](https://eips.ethereum.org/EIPS/eip-7702)). A plain key therefore has the same problem as ours, with no thresholds to help.
- **ERC-4337** (Final): each account supplies "its own validation logic executed as smart contract code", and paymasters pay gas for it. Its motivation names multisig and custom recovery; session keys and social recovery are not named in it ([ERC-4337, Abstract/Definitions/Motivation](https://eips.ethereum.org/EIPS/eip-4337)).
- **ERC-7579** (Draft): validator, executor, fallback and hook modules. Install and uninstall "MUST implement authorization control" ([ERC-7579, "Module configurations", "Security Considerations"](https://eips.ethereum.org/EIPS/eip-7579)). **ERC-6900** (Draft): validation functions can be scoped to function selectors, and it lists "session keys, subscriptions, spending limits" as module examples ([ERC-6900](https://eips.ethereum.org/EIPS/eip-6900)).
- **ERC-7710** (Draft): delegation managers that redeem delegated capabilities. Caveats appear only in MetaMask's reference implementation, i.e. vendor practice ([ERC-7710](https://eips.ethereum.org/EIPS/eip-7710)). **ERC-7715** (Draft): `wallet_requestExecutionPermissions` with allowance and expiry rules for a "DApp session account" ([ERC-7715](https://eips.ethereum.org/EIPS/eip-7715)).
- **Safe** (vendor, open source): modules "can execute arbitrary transactions" and owners enable them at the threshold ([Safe modules](https://docs.safe.global/advanced/smart-account-modules)). Guards check transactions before and after, and "a broken Guard can cause a denial of service" ([Safe guards](https://docs.safe.global/advanced/smart-account-guards)). The **Allowance module** gives delegates per-token allowances with an optional reset period; only the Safe configures them ([safe-modules/allowances](https://github.com/safe-global/safe-modules/tree/main/modules/allowances)).
- **The pattern:** a hot "session key" is limited **by code in the account**, and the power to change that code belongs to a different authority: owners at a threshold, or a timelocked recovery. Social recovery with guardians is vendor practice (Safe recovery modules), not an ERC. The real standards (7579, 6900, 7710, 7715) are mostly Drafts. **Without a second authority, Ethereum offers nothing either:** someone has to be able to install or remove modules.

## Solana findings

- **The fee payer must be a System-owned account** (or a nonce account), a signer at index 0 ([transaction-structure.mdx, "Fee payer requirements"](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/core/transactions/transaction-structure.mdx)). As on Stellar, a program-controlled account can't pay fees.
- **A keypair account has no weights, thresholds or signer rotation.** A stolen key is total and can't be revoked. PDAs have "no private key": only the deriving program signs for them, via `invoke_signed` ([pda/index.mdx](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/core/pda/index.mdx)). That is policy-in-code, as on Ethereum.
- **Squads v4** (vendor, open source):
  - multisig with time locks, spending limits, roles (Proposer/Voter/Executor) and a `config_authority`; its README warns a compromised `config_authority` can "instantly" change members ([Squads v4 README](https://github.com/Squads-Protocol/v4)).
  - Spending limits let a member move a set amount per period without full approval ([Squads docs, "Spending Limits"](https://docs.squads.so/main/navigating-your-squad/settings/spending-limits)). Time locks delay all approved transactions ([Squads docs, "Time Locks"](https://docs.squads.so/main/navigating-your-squad/settings/time-locks)).
- **Durable nonces** have a separate nonce authority; they extend a transaction's life and don't limit the key ([durable-nonces.mdx](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/core/transactions/durable-nonces.mdx)).
- **Fee-relayer practice (Kora, Solana Foundation):** a compromised signer can "drain your SOL balance". The advice is to "maintain minimal operational balance with automated monitoring and top-offs" and alert on unusual activity ([kora/operators/signers.mdx, lines 20-25 and 471-472](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/tools/kora/operators/signers.mdx)). Kora's signer pool spreads load across keys and doesn't limit any one of them.
- Note: solana.com rate-limited fetches (HTTP 429), so these were read from the docs' GitHub source.

## What carries over to Stellar

| Pattern | Carries over? |
|---|---|
| Session key limited by account code (ERC-4337/7579, Safe modules, Squads, PDAs) | **No** for our accounts: only G accounts can be a transaction source or fee source, and their only policy is thresholds |
| Separate fee payer from authority | **Already done** (fee bump from the fee account, channel as source). Could go further: the fee account's key needs only **low** |
| Owner/admin is a different authority from the hot key (Safe owners, Squads config authority) | **Yes, as a second signer at high:** online co-signers (B1/B2) or SEP-30-style recovery servers |
| Spending limits / allowances | **Only coarsely:** thresholds can take Payment away from the fee account entirely (funds then leave only as fees); no per-period limit exists |
| Timelocks / delayed recovery | **No** native classic primitive. Pre-auth transactions with time bounds are the closest, and too fragile for channels |
| Minimal balance, top-ups, alerts (Kora, SDP) | **Yes**, fully, and already in ADR 0013 (100 XLM float, theft alarm) |
| Disposable keys (Solana keypairs can't rotate anyway) | **Yes:** treat channels and the fee account as disposable, recreated under a new key |

## Options for 0048

What sits under the hot key today: fee float about 100 XLM, channel reserves 1.5 XLM each (about 30 XLM for 20 channels), no buyer or seller tokens (ADR 0013).

### A. Lock the hot key below the dangerous threshold, with no other signer (recommended)

- **How it works:**
  - Fee account: master (hot) key weight 1, thresholds low 1 / medium 2 / high 2.
  - Channels: hot key weight 1, master 0, thresholds low 1 / medium 1 / high 2.
  - On a new channel, one `SetOptions` (signed by the channel's own key while it is still master) sets the signer, master 0 and the thresholds together.
  - The live fee account needs one `SetOptions` signed by the hot key itself, the one exception to ADR 0013's "OpenBao signs settlements only".
- **Theft:** the thief can't add signers, change thresholds, merge, or Payment out of the fee account. The float leaves only as fees of fee bumps the thief submits, which is slower and visible to the balance and burn-rate alarms. On channels the thief keeps medium, so it can use them, push their sequence and add subentries if it funds them, but takes nothing. Response: stop top-ups, create a new fee account and channels under a new key, drop the old addresses from config.
- **Loss:** the float and reserves are stranded for good, since nothing can merge them. Loss is capped at float + 1 XLM + 1.5 XLM × channels. Recovery: a new key, a new fee account, new channels from the funder wallet.
- **Cost and complexity:** lowest. No new key, no extra reserve. Changes: thresholds in setup; `checkChannel` requires hot weight ≥ max(low, medium), < high, and no other signer; theft and rotation runbooks go from "merge" to "abandon"; spine AD-12; the threat model.
  - The theft alarm gets simpler: a signer or threshold change on our accounts becomes impossible.
  - A planned rotation means "stop top-ups, let the float run down, switch, abandon". It strands reserves: about 30 XLM at 20 channels, 450 XLM at 300.
- **Blockers:**
  - Irreversible: a later move to B needs new accounts.
  - Channel creation must stay on the funder wallet. `create-channels.ts` already uses `FUNDER_SECRET`, so the task text's "creating channels needs medium on the fee account" looks out of date; to confirm.
  - Leaked old keys keep medium on abandoned channels forever, so nothing may trust those addresses.

### B2. Split high across 2-of-3 independent online custodians (runner-up)

- **How it works:** every account gets hot key (OpenBao) weight 1 and two more online keys weight 1 each, in separate trust domains and never on the settle path. Examples: AWS KMS Ed25519 in a dedicated account, and GCP KMS or a second OpenBao on another host. Thresholds: channels low 1 / med 1 / high 2; fee account low 1 / med 2 / high 2. This is SEP-30's "no single server controls" shape and the Safe/Squads "admin ≠ hot key" pattern.
- **Theft:** taking over needs two domains. With one key, the thief has A's powers only, and we remove that key in place: one 2-of-3-signed transaction holds up to 100 operations ([Operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions), via 0047).
- **Loss:** any two custodians recover in place. Losing OpenBao becomes a routine rotation.
- **Cost and complexity:**
  - Two more signers on every account: +1 XLM reserve per channel (20 XLM now, 300 XLM at 300 channels), or sponsored.
  - Two more KMS keys (about $1 per key per month, from 0047's figures).
  - A small offline-of-settlement tool that collects two KMS signatures; runbooks and drills for it.
  - The second domain's credentials become a target, though one alone does nothing.
- **Blockers:** AWS KMS Ed25519 signing for Stellar is documented but untested by us (0047). AWS already holds ADR 0013's backup set, so the AWS custodian must be a different account and role from the backup secret, or the domains are not independent.

### B1. One warm recovery key at weight 2 in AWS KMS

This is 0048's original design with the cold key swapped for an online KMS key. It handles theft and loss of the hot key, but the KMS credential alone can take over, so it is a single key again, just off the server. It loses to B2 for one more key's cost.

### Status quo + value limits + alarms (accept full power)

Zero work. The thief can Payment the whole float out in one transaction, merge the channels and lock us out. Loss freezes everything, the same as A. It loses to A because A costs about the same and removes the one-shot float drain.

### Pre-auth merge transactions, hash(x), sponsorship, SEP-30, Soroban contract accounts

All rejected:
- **Pre-auth merges:** fragile (sequence numbers, subentries) and recover only reserves.
- **Hash(x):** a weaker cold key.
- **Sponsorship:** the sponsor has no control.
- **SEP-30:** a Draft built for user identity, not services. Its shape is B2.
- **Soroban contract accounts:** impossible as a transaction or fee source.

### Options table

| Option | Second key? | Theft of hot key | Loss of OpenBao | Cost / complexity | Main blocker |
|---|---|---|---|---|---|
| **A. Lock below threshold** | No | No takeover; float leaks only through fees; abandon and recreate | Float + reserves stranded (bounded); recreate | Lowest; thresholds + `checkChannel` + runbooks | Irreversible; rotation strands reserves |
| B2. 2-of-3 online custodians | Yes, 2 online | No takeover; rotate in place | Recover in place | +1 XLM per account, 2 KMS keys, a signing tool, drills | Ed25519 KMS untested; independence from AWS backup |
| B1. Warm KMS key at weight 2 | Yes, 1 online | Rotate in place | Recover in place | +0.5 XLM per account, 1 KMS key | KMS credential alone = takeover |
| Status quo + limits | No | Full takeover, float drained in one transaction | Everything frozen | None | Fails the threat model's ask |
| Pre-auth / hash(x) / sponsor / SEP-30 / contract accounts | n/a | Weak or none | Reserves at most | High or impossible | See above |

## Recommendation

**Option A now, B2 as the planned upgrade.** Lock the fee account's hot key to low only (fee bumps), lock every channel's hot key below high, and keep ADR 0013's small float, treasury top-ups and alarms.

- It is the only option with no second key, and the protocol enforces it, not our code.
- It matches two SDF-documented patterns: a key below medium, and a deliberately locked account.
- It removes the one way a thief takes real money in one transaction: Payment of the float. That is the same advice Solana's Kora and SDF's SDP give about value at risk.
- Its cost, stranded reserves on rotation, is the same loss that theft or OpenBao loss would cause today anyway.

Record in the ADR the trigger for B2 at the next channel generation: stranded reserves per rotation above a set XLM figure (for example, about 100 channels or more), or a need for in-place rotation (SLA, auditor). The 2-of-3 custodians must sit in domains independent of the server and of the AWS account that holds the OpenBao backup.

## Open questions

1. Does anything trust channel addresses in Soroban? Since 0093 the channel is the caller, and a leaked key keeps medium (Soroban `require_auth`) on abandoned channels forever. Check that no contract (upto-proxy included) grants a channel address any authority.
2. How fast can a thief burn the float through fee bumps (inclusion bid under surge, the Soroban non-refundable resource fee)? This sizes the float and the burn-rate alarm. Not measured.
3. Can a thief brick a channel with `BumpSequence` (Low) toward INT64_MAX? Unverified. It is a denial of service only, and A's response (abandon) covers it.
4. The fee account's one-time hardening `SetOptions` must be signed by the OpenBao key, an ADR 0013 exception. Alternatively, create future fee accounts already hardened.
5. The task text says channel creation needs medium on the fee account, but `packages/signer-pool/scripts/create-channels.ts` signs with a separate `FUNDER_SECRET`. Confirm no flow uses the fee account at medium.
6. For B2: test Ed25519 signing for Stellar on AWS KMS, and on GCP KMS or the second custodian (0047 lists it as untested).

## Sources

- Stellar: [signatures-multisig](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig) · [list-of-operations](https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations) · [fee-bump-transactions](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions) · [sponsored-reserves](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves) · [control-asset-access](https://developers.stellar.org/docs/tokens/control-asset-access) · [smart-wallets](https://developers.stellar.org/docs/build/guides/contract-accounts/smart-wallets) · [authorization](https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization) · [channel-accounts](https://developers.stellar.org/docs/build/guides/transactions/channel-accounts) · [SDP security.mdx](https://github.com/stellar/stellar-docs/blob/main/docs/platforms/stellar-disbursement-platform/admin-guide/security.mdx) · [Stellar-transaction.x](https://github.com/stellar/stellar-xdr/blob/curr/Stellar-transaction.x) · [CAP-33](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0033.md) · [CAP-71](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md) · [SEP-30](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0030.md)
- Ethereum: [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) · [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) · [ERC-7579](https://eips.ethereum.org/EIPS/eip-7579) · [ERC-6900](https://eips.ethereum.org/EIPS/eip-6900) · [ERC-7710](https://eips.ethereum.org/EIPS/eip-7710) · [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715) · [Safe modules](https://docs.safe.global/advanced/smart-account-modules) · [Safe guards](https://docs.safe.global/advanced/smart-account-guards) · [Safe allowance module](https://github.com/safe-global/safe-modules/tree/main/modules/allowances)
- Solana: [transaction-structure.mdx](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/core/transactions/transaction-structure.mdx) · [pda/index.mdx](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/core/pda/index.mdx) · [durable-nonces.mdx](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/core/transactions/durable-nonces.mdx) · [Kora signers.mdx](https://github.com/solana-foundation/solana-com/blob/main/apps/docs/content/docs/en/tools/kora/operators/signers.mdx) · [Squads v4 README](https://github.com/Squads-Protocol/v4) · [Squads docs llms-full](https://docs.squads.so/main/llms-full.txt)
- Repo: `packages/signer-pool/src/setup.ts`, `packages/signer-pool/scripts/create-channels.ts`, `docs/adr/0013-facilitator-key-custody.md`, `docs/architecture/m1-spine.md` (AD-12), 0047 report (branch `lore-0047-hetzner-key-custody`)
