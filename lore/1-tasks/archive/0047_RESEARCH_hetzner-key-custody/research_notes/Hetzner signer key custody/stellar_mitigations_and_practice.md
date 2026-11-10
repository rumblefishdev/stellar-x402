# Stellar-native mitigations for facilitator hot-key compromise or loss, and industry practice (as of 2026-10-15)

Scope note: OpenZeppelin Relayer and its Stellar channels plugin were deliberately not used or studied (licensing constraint). Some search hits pointed at it; they were ignored.

Repo context checked (our code, `packages/signer-pool/src/setup.ts`): channels are created with `CHANNEL_STARTING_BALANCE = "1.5"` XLM, the facilitator added as signer with weight 1, `masterWeight: 0`, thresholds left at their default 0. `checkChannel` flags any other signer with weight > 0 as `"extra-signer"`. With all thresholds at 0, the facilitator key alone meets the **high** threshold today, so a thief can change signers on every channel.

## 1. Stellar signer model: can the hot key sign transactions and fee bumps but not change signers?

### Takeaway
Yes. Set each account's thresholds so the hot facilitator key's weight meets what its job needs but stays below **high**, and add a cold recovery key whose weight alone meets high. Signer changes, threshold changes and account merge are high-threshold operations, so the hot key can no longer lock us out. The fee account can be held tighter still: a fee bump needs only the fee account's **low** threshold, so the hot key can sit below medium there and cannot even send a `Payment` from it.

### Cited findings
- Each operation is low, medium or high. A signature set authorizes an operation when its summed weights reach that threshold (0–255). Defaults: all thresholds 0, master weight 1. Docs recommend `low <= medium <= high`. — [Stellar docs: Signatures and multisig](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/signatures-multisig.mdx)
- Threshold per operation, from the official list:
  - **High:** `Set options` when updating signers or thresholds; `Account merge`.
  - **Medium:** `Set options` for everything else; Create account; Payment; both path payments; offers; Change trust; Manage data; Create claimable balance; Begin/End sponsoring future reserves; Revoke sponsorship; Clawback; Liquidity pool deposit/withdraw; **Invoke Host Function**; Extend footprint TTL; Restore footprint.
  - **Low:** Allow trust; Bump sequence; Claim claimable balance; Set trustline flags.
  - — [Stellar docs: List of operations](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/list-of-operations.mdx)
- The transaction source account's signatures must meet its **low** threshold. Each operation's signatures must meet that operation's threshold on the operation's source account. — [Stellar docs: Operations and transactions](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/operations-and-transactions.mdx)
- Fee bump (CAP-15): "the weight of that signature must meet the **low threshold** for the fee account". — [Stellar docs: Fee-bump transactions](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions)
- Master key weight 0 cannot sign anything, even a threshold-0 operation. Setting it can lock you out permanently unless other signers exist, so change weights in the right order. — [Signatures and multisig](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/signatures-multisig.mdx)
- The official docs use this exact split as a pattern. An anchor adds an extra key "with a weight below your anchor account's medium threshold": it can authorize low-threshold operations but cannot issue payments. A related example uses master weight 3, two employee keys at weight 1, and high threshold 3, so only the owner can change signers. — [Signatures and multisig](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/signatures-multisig.mdx)
- Each signer beyond the master key adds one base reserve to the minimum balance. At most 20 signatures per transaction, and an unneeded extra signature fails the transaction with `TX_BAD_AUTH_EXTRA`. — [Signatures and multisig](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/signatures-multisig.mdx)
- Anything that raises the minimum balance can be sponsored, signers included. A sponsor can revoke or transfer sponsorships (Revoke sponsorship is medium). — [Stellar docs: Sponsored reserves](https://github.com/stellar/stellar-docs/blob/main/docs/build/guides/transactions/sponsored-reserves.mdx)

### Inferences (proposed layout; not taken from a single source)
- **Channel accounts.** These are inner-transaction sources: Invoke Host Function is medium, and the source signature needs low. Proposed layout:
  - master 0; hot facilitator weight 1; cold recovery weight 2 (or a 2-of-3 cold quorum);
  - low = 1, medium = 1, high = 2.
  - The hot key then signs every x402 settlement but cannot `SetOptions` signers, change thresholds or `AccountMerge`.
  - What a thief can still do on a channel: Payment or CreateAccount of any XLM above the reserve (nothing, if the channel holds only its reserve, which our 1.5 XLM is: (2 + 1 signer) × 0.5); BumpSequence (griefing); ChangeTrust and ManageData (raise our reserve needs, or fail for lack of balance); submit junk Soroban calls.
- **Fee account.** Only fee-bump signing is needed, so:
  - hot weight 1; low = 1, medium = 2, high = 2 (or higher); cold recovery weight ≥ high.
  - A thief cannot Payment, merge or change signers. The remaining exposure is fees burned through fee bumps of transactions they craft.
  - Inclusion fees are normally the market rate rather than the bid. Under surge pricing, though, the effective fee becomes the bid, and Soroban resource fees (declared by the inner transaction, partly non-refundable) are paid by the fee account. A thief can therefore still drain the fee balance, but only through fees, and slowly unless the network is in surge. This is unverified in practice; bound it with a small hot balance (section 2).
- **`checkChannel` must change** to accept a recovery signer, if one is added. Today it returns `"extra-signer"` for any other signer, and `"thresholds-too-high"` compares only against medium. It should instead check: facilitator weight ≥ max(low, medium), facilitator weight < high, and recovery weight ≥ high.
- **Recovery signers cost reserves.** One extra signer on each of N channels adds N × 0.5 XLM (e.g. 300 channels → 150 XLM), unless a cold sponsor account sponsors it.
- **Sponsor channel reserves from a cold sponsor account.** The pattern is `BeginSponsoringFutureReserves` / `CreateAccount(amount 0)` / `EndSponsoring`, as SDP does (section 4). Channels then hold 0 own XLM. The hot key cannot touch the sponsor's balance, because sponsor-side operations need the sponsor's signatures.
  - Caveat: every channel created later then needs a cold-key signature. That trades operational convenience for safety; a separate "warm" sponsor key is an option.
- **Order matters when hardening existing accounts.** In one `SetOptions` per account, add the recovery signer first, then raise high. Set master 0 last, or in the same atomic transaction, so you never end up with weight sum < high.

### Gaps
- No official SDF guidance found that prescribes this split for fee-bump/channel infrastructure specifically. It is derived from the general multisig docs.
- No measurement of how fast a thief could burn a fee-account balance through fee bumps under surge pricing.

## 2. Limiting fee-account exposure

### Takeaway
Treat the fee account as a hot wallet: keep a small XLM float with automated top-ups from a cold or warm treasury, cap the bid per fee bump in our code, and alert on balance velocity and on any signer or threshold change. SDF's own SDP docs and the Solana Foundation's Kora docs both give the same "limited hot balance + monitor + top up" advice.

### Cited findings
- SDP: "The SDP wallet should be used primarily as a hot wallet with a limited amount of funds to minimize potential losses." — [SDP admin guide: Security](https://github.com/stellar/stellar-docs/blob/main/docs/platforms/stellar-disbursement-platform/admin-guide/security.mdx)
- Kora (the Solana Foundation fee relayer) says a compromised signer could "drain the balance, sign unauthorized transactions, or disrupt the paymaster". It advises:
  - funding only with SOL meant for fees and keeping a "minimal operational balance", with automated monitoring and top-offs;
  - dedicated keypairs;
  - alerting on unusual activity.
  - — [Solana docs: Kora signers](https://solana.com/docs/tools/kora/operators/signers.md)
- Inclusion fee: you pay only what is needed to get in, but under surge pricing the effective base fee becomes your max bid. Soroban transactions hit surge more often. Mainnet ledger limits as of July 2026 per the docs: 1,000 classic operations, 2,000 smart-contract transactions. — [Stellar docs: Fees, resource limits and metering](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/fees-resource-limits-metering.mdx)
- A fee-bump replacement for the same source and sequence must bid at least 10x the original. — [Fee-bump transactions](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions)

### Inferences
- **Top-ups.** A top-up is a `Payment` from a treasury account to the fee account, signed by a separate key (warm, or cold-scheduled). It never needs the facilitator key. With the threshold layout from section 1, the facilitator key also cannot move funds out of the fee account by Payment.
- **Monitors worth having** (Horizon or RPC event stream / Hubble):
  - fee-account balance and its burn rate per settled payment;
  - any `set_options`, `account_merge` or `payment` with a facilitator account as source;
  - channel sequence jumps not matched by our own submissions (a `bump_sequence` by a thief).
- **Fee cap.** Our AD-10 bid logic already bounds the fee per bump. A hard ceiling enforced in the signer, or in a policy layer in front of KMS/Vault, also stops a compromised app process from bidding huge fees. It does not stop a thief who holds the raw key.

### Gaps
- Found no public number from SDF or other Stellar operators for a "right" hot-float size.

## 3. Rotating a key that signs hundreds of accounts

### Takeaway
Rotation is batchable. A classic transaction holds up to 100 operations, each with its own source account, and one signature from a key that is a signer on all those accounts satisfies each of them. A cold recovery key with weight ≥ high on every channel can therefore sign one transaction that swaps the facilitator signer on 50 channels (remove old + add new = 2 `SetOptions` per channel), or on 100 channels if only the new signer is added first and the old one removed later. With the cold key on every account, rotation needs no hot-key cooperation, so it works after hot-key loss as well as after theft.

### Cited findings
- A transaction holds 1–100 operations; a smart-contract transaction holds only one. — [Operations and transactions](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/operations-and-transactions.mdx)
- Operations run as the transaction source unless the operation sets its own source. The signatures must meet the threshold for each operation's source account. — [Operations and transactions](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/operations-and-transactions.mdx)
- At most 20 signatures per transaction, and unneeded extra signatures fail it (`TX_BAD_AUTH_EXTRA`). — [Signatures and multisig](https://github.com/stellar/stellar-docs/blob/main/docs/learn/fundamentals/transactions/signatures-multisig.mdx)
- Our own creation code already batches for the 20-signature limit: `MAX_CHANNELS_PER_TX = 19` (facilitator + one per channel). Source: `packages/signer-pool/src/setup.ts`. SDP uses the same limit: "only create a MaxBatchSize (19) of accounts per transaction, this is due to the signature limit of a transaction". — [SDP channel_accounts_service.go](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/internal/transactionsubmission/services/channel_accounts_service.go)
- SDP 7.0.0 added CLI rotation: `distribution-account rotate --wallet-id` (rotates the account) and `rotate-wallet-dek` (re-wraps the stored key). — [SDP CHANGELOG 7.0.0](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/CHANGELOG.md)

### Inferences
- **Procedure sketch (cold key with weight ≥ high on every account):**
  1. Generate the new hot key in the target custody: KMS, Vault or HSM.
  2. Build transactions of up to 100 `SetOptions` ops, one per channel and the fee account, each adding the new key at the hot weight. One cold signature per transaction, so 300 channels take about 3 transactions.
  3. Deploy the facilitator with the new key. Either way works:
     - drain in-flight settlements first; channels are locked for at most a ledger-bound window;
     - or run both keys briefly, since both are valid signers.
  4. Remove the old key with a second round of `SetOptions` (weight 0).
- **Downtime.** Close to zero for planned rotation if done "add new → switch → remove old". For a theft, step 4 comes first (remove old, add new in the same op set: 2 ops per channel, so 50 channels per transaction), and settlement pauses until the new key is live.
- **Rotation is a race after theft.** A thief who already raised high, or added their own signer, wins if the hot key could meet high. That is the whole argument for the section 1 threshold layout: the thief cannot touch signers at all.
- **Do not let the cold key be the one-tx-per-ledger bottleneck.** Use the fee or recovery account as the transaction source, so you are not touching channel sequence numbers. Each `SetOptions` op names the channel as op source, and channel sequences stay untouched.
- **Loss case (non-exportable KMS key deleted).** Without a recovery signer, every channel and the fee account are permanently frozen. Recovering the XLM is impossible because `AccountMerge` needs high. With a recovery signer, loss becomes a routine rotation.

### Gaps
- Did not verify the transaction size limit, or whether 100 `SetOptions` ops with signer payloads fit in a classic transaction. They almost certainly do, since classic ops are small, but testnet should confirm it.
- No SDF doc found that describes a mass signer rotation procedure.

## 4. What SDF tooling does for server-side keys (SDP, Anchor Platform, Wallet SDK)

### Takeaway
SDF's own server products do **not** use KMS or HSM for Stellar signing keys. SDP keeps distribution and channel-account secret keys AES-GCM-encrypted in Postgres; the key-encryption key is a Stellar secret seed passed in by environment variable. Since 7.0.0, distribution wallets use per-wallet envelope encryption, a random DEK wrapped by that KEK. Channel accounts are sponsored by the distribution/host account and each has its own key. Anchor Platform dropped its custody integration. So the SDF reference implementation is roughly "key in env + encrypted DB" plus a hot-wallet balance limit; KMS would be stronger than that.

### Cited findings
- SDP `SignatureClient` types:
  - DistributionAccountEnv (key from env);
  - DistributionAccountDB, configured by `DistAccEncryptionPassphrase`;
  - ChannelAccountDB, configured by `ChAccEncryptionPassphrase`.
  - Both passphrases must be valid Ed25519 secret seeds ("encryption passphrase is not a valid Ed25519 secret").
  - — [SDP signature_client.go](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/internal/transactionsubmission/engine/signing/signature_client.go), [channel_account_db_signature_client.go](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/internal/transactionsubmission/engine/signing/channel_account_db_signature_client.go)
- Channel-account private keys are decrypted from the DB per signature (`c.encrypter.Decrypt(chAcc.PrivateKey, c.encryptionPassphrase)`), and the same client signs fee-bump transactions. — [channel_account_db_signature_client.go](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/internal/transactionsubmission/engine/signing/channel_account_db_signature_client.go)
- `EnvelopeEncrypter` gives "two-layer (envelope) encryption on top of the existing AES-GCM primitives": a random per-wallet DEK, wrapped with the caller's KEK. The code has no KMS integration. — [SDP envelope_encrypter.go](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/internal/utils/envelope_encrypter.go)
- SDP 7.0.0 (2026): multiple distribution accounts per tenant, "each with its own membership roles and envelope-encrypted signing key"; append-only audit tables; rotate commands; Prometheus/Grafana wiring. — [SDP CHANGELOG](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/CHANGELOG.md)
- `DISTRIBUTION_SIGNER_TYPE` is deprecated; the signer type is now set per tenant at provisioning. Account types include `DISTRIBUTION_ACCOUNT.STELLAR.DB_VAULT` and `DISTRIBUTION_ACCOUNT.CIRCLE.DB_VAULT`. Circle-backed tenants route payments through Circle's custody API instead of signing on Stellar themselves. — [SDP CHANGELOG](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/CHANGELOG.md); [SDP design and architecture](https://developers.stellar.org/docs/platforms/stellar-disbursement-platform/admin-guide/design-and-architecture)
- SDP creates channel accounts sponsored: `BeginSponsoringFutureReserves{SponsoredID}`, `CreateAccount{Amount: "0"}`, `EndSponsoringFutureReserves{SourceAccount: channel}`. — [SDP services/horizon.go](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/internal/transactionsubmission/services/horizon.go)
- Anchor Platform (java-stellar-anchor-sdk, still maintained, last push 2026-10-15) has DB migrations `V9__add_custody_txn_and_txn_pending_trust_tables.sql`, later `V26__drop_custody_transaction.sql`. The custody-service integration was added and then removed. — [java-stellar-anchor-sdk repo tree](https://github.com/stellar/java-stellar-anchor-sdk/tree/develop/platform/src/main/resources/db/migration)
- SDP's SEP-10 signing key is a plain env var (`SEP10_SIGNING_PRIVATE_KEY`). — [SDP backend README](https://github.com/stellar/stellar-disbursement-platform-backend/blob/develop/README.md)
- Stellar channel-account guide: the base account and each channel key both sign; secrets are held as an array of keys in the example. It gives no custody guidance. — [Stellar docs: Channel accounts](https://github.com/stellar/stellar-docs/blob/main/docs/build/guides/transactions/channel-accounts.mdx)

### Inferences
- SDP's model differs from ours: one key per channel versus our one facilitator key that signs for all channels. SDP compromise = DB dump + KEK env var. Ours = one key.
- Our model makes the single key more valuable. It also makes threshold hardening and batch rotation simpler: one recovery signer pattern, applied uniformly.
- Nothing in SDF tooling uses AWS/GCP KMS, Vault Transit or an HSM for Stellar signing. Choosing any of those would exceed the SDF reference practice. They are not an ecosystem convention we would be departing from.

### Gaps
- No SEP covers server-side key custody for anchors or facilitators; none found. The Stellar Wallet SDK docs were not checked in depth. They target client wallets, and no server-key recommendations surfaced.
- Did not inspect the old Anchor Platform custody integration (likely Fireblocks) before removal. Unverified which vendor it was.

## 5. How comparable Ed25519-chain backends hold hot fee-payer keys; incidents

### Takeaway
The Solana Foundation's fee relayer (Kora) supports in-memory/env keys, Turnkey (HSM-backed), Privy and HashiCorp Vault as signers, with signer pools. AWS KMS has supported Ed25519 signing natively since November 2025, which makes cloud-KMS custody of a Stellar key practical. No public report of a Stellar anchor or payment-service hot-key theft was found. Relevant incidents are key leakage through logging (Slope, Solana, 2022) and hosting-account compromise (BlackWallet, Stellar, 2018).

### Cited findings
- Kora signer types:
  - `memory`: private key in an env var or keypair file;
  - `turnkey`: "enterprise-grade key management" with HSMs and policy controls;
  - `privy`;
  - HashiCorp Vault.
  - Kora also has `[signer_pool]` strategies `round_robin`/`random`/`weighted` and recommends multiple signers in production. The doc describes no rotation procedure, and it does not mention AWS KMS or GCP.
  - — [Solana docs: Kora signers](https://solana.com/docs/tools/kora/operators/signers.md)
- A third-party blog says Kora supports remote signing via Turnkey and AWS KMS. The official Kora signers page does not list AWS KMS, so treat this as **unverified**. — [BlockEden blog, 2026-04-22](https://blockeden.xyz/blog/2026/04/22/solana-kora-signing-node-fee-relayer-gasless-ux-primitive/)
- AWS KMS added key spec `ECC_NIST_EDWARDS25519` (document history dated 2025-11-07). Its signing algorithms are `ED25519_SHA_512` (RAW message) and `ED25519_PH_SHA_512` (DIGEST); the two are not interchangeable. Stellar signs the 32-byte transaction hash with pure Ed25519, so `ED25519_SHA_512` with MessageType RAW is the one that fits (our inference). — [AWS KMS key spec reference](https://docs.aws.amazon.com/us_en/kms/latest/developerguide/symm-asymm-choose-key-spec.html); [AWS KMS document history](https://docs.aws.amazon.com/kms/latest/developerguide/dochistory.html)
- Slope wallet (Solana, Aug 2022): seed phrases were sent to a Sentry logging server with no scrubbing (Zellic, OtterSec). About 1,444 drained wallets were traced to it, and 5,300+ keys sat in Sentry. Root cause for the full ~9,200-wallet drain was never fully settled (SlowMist). — [BankInfoSecurity](https://www.bankinfosecurity.com/seed-phrase-compromise-may-have-caused-solana-wallets-drain-a-19705); [ITPro](https://itpro.com/security/hacking/368730/auditors-blame-4-million-cryptocurrency-heist-on-leaky-logging-tech); [Ackee](https://ackee.xyz/blog/2022-solana-hacks-explained-slope-wallet/); [SlowMist](https://slowmist.medium.com/analysis-of-a-large-scale-attack-on-solana-part-2-ee105d907c12)
- BlackWallet (Stellar web wallet, Jan 2018): the attacker got into the hosting-provider account, hijacked DNS and injected code that swept accounts holding > 20 XLM. About 670k XLM (~$400k) was taken. — [BleepingComputer](https://www.bleepingcomputer.com/news/security/hackers-hijack-dns-server-of-blackwallet-to-steal-400-000/)

### Inferences
- **Slope lesson for an env-held key.** Error trackers, crash dumps, debug logs and `/proc/<pid>/environ` all leak env secrets. Scrub them, or keep the raw key out of the process entirely (KMS, Vault Transit).
- **BlackWallet lesson for Hetzner.** The hosting/console account (Hetzner Robot/Cloud console, rescue mode, snapshots) is itself a key-exfiltration path for any key on disk or in env. Enforce 2FA and limit who has console access.

### Gaps
- No public, primary-source report of Stellar anchor, SDP-operator or x402-facilitator hot-key theft was found.
- No public detail on how Coinbase's x402 facilitator or other x402 facilitators custody their fee-payer keys; not researched within the call budget.

## 6. Threat model: what each custody option protects against

### Takeaway
No custody option stops a fully compromised facilitator host from *using* the key while the attacker is there. Only Stellar thresholds bound what that use can do. KMS, Vault and HSM stop key *exfiltration* (so the theft ends when access ends) and leaks through backups and logs. A cold recovery signer is what protects against key *loss*, including a KMS key that was deleted or became unreachable.

### Cited findings
- AWS KMS Ed25519 keys are sign/verify only, used through the KMS API. — [AWS KMS key spec reference](https://docs.aws.amazon.com/us_en/kms/latest/developerguide/symm-asymm-choose-key-spec.html)
- Kora warns that a compromised signer could "drain the balance, sign unauthorized transactions, or disrupt the paymaster", whatever the signer backend. — [Kora signers](https://solana.com/docs/tools/kora/operators/signers.md)
- SDP's practice (env KEK + AES-GCM-encrypted DB keys) plus a limited hot balance is SDF's reference baseline. — [SDP signing code](https://github.com/stellar/stellar-disbursement-platform-backend/tree/develop/internal/transactionsubmission/engine/signing); [SDP Security](https://github.com/stellar/stellar-docs/blob/main/docs/platforms/stellar-disbursement-platform/admin-guide/security.mdx)

### Inferences (analysis, not sourced fact)

Each option below is rated against six threats: host compromise (key use while the attacker is on the host), host compromise (key exfiltration), insider, backup/log leak, vendor/service outage, and key loss.

**Key in env/file on the Hetzner host**
- Host compromise, key use: no protection.
- Host compromise, exfiltration: no protection. The key is stolen and stays usable forever.
- Insider: no. Anyone with root or console access has it.
- Backup/log leak: no. Snapshots, logs and crash dumps can all carry it.
- Outage: none, since there is no dependency.
- Key loss: copies are easy, but each copy is another leak path.

**Self-hosted Vault/OpenBao Transit on Hetzner**
- Host compromise, key use: no, but Vault policy and audit logs can rate-limit use and record it.
- Host compromise, exfiltration: yes, if Transit is non-exportable and Vault runs on a separate host. If Vault is on the same box, the gain is only partial: unseal material and memory are exposed.
- Insider: partial. Vault admins and unseal-key holders can still get the key, unless the key is marked exportable=false and the storage is protected.
- Backup/log leak: partial. Encrypted storage protects it only while the unseal keys are separate.
- Outage: we operate the Vault, so we carry its HA burden.
- Key loss: lost if the Vault storage and its backups are lost. Backups trade loss-risk for leak-risk.

**Cloud KMS (AWS KMS Ed25519, GCP)**
- Host compromise, key use: no. Credentials on the host can call Sign, but IAM conditions and CloudTrail bound and log that use.
- Host compromise, exfiltration: yes. Key material is non-exportable, so revoking the IAM credential ends the theft.
- Insider: mostly yes. A cloud IAM admin can still sign, and can schedule deletion.
- Backup/log leak: yes.
- Outage: a KMS region outage or a Hetzner-to-AWS network failure stops signing, since every settlement needs a remote call.
- Key loss: scheduled deletion has a waiting period (AWS: 7–30 days, unverified here), but a deleted key is gone. A recovery signer is required.

**HSM (on-prem or cloud HSM)**
- Host compromise, key use: no; use is bounded by HSM policy.
- Host compromise, exfiltration: yes, non-exportable.
- Insider: strongest, with quorum or M-of-N admin.
- Backup/log leak: yes.
- Outage: hardware or service failure stops signing.
- Key loss: HSM backup/cloning exists but needs process. A recovery signer is still advised.

**Option-independent controls**
- Stellar thresholds (hot key < high) stop the worst case of a compromised host, signer takeover.
- A cold recovery signer turns loss into a rotation.
- A small fee float bounds money at risk to the float.
- Sponsored channels hold no drainable XLM.

### Gaps
- AWS KMS deletion waiting period and GCP Ed25519 GA status were not re-verified in this pass; other researchers may cover them.
- No public data on KMS signing latency from Hetzner (EU) to an AWS region, relevant to per-settlement fee-bump signing. The x402 settle path would add a round trip.
