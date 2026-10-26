---
title: "Facilitator key custody on Hetzner: KMS, Vault/OpenBao Transit and the rest"
type: research
status: developing
spawns:
  - R-openbao-on-hetzner.md
  - R-key-leak-impact.md
tags: [keys, custody, hetzner, vault, openbao, kms, hsm]
links:
  - ../spike/results.md
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-15"
    status: developing
    who: okarcz
    note: "Options compared, Vault and OpenBao Transit tested on testnet; recommendation awaits review."
  - date: "2026-10-16"
    status: developing
    who: okarcz
    note: "Mainnet unseal checked: no HSM on Hetzner, a cloud KMS seal through OpenBao's KMS plugin instead."
  - date: "2026-10-16"
    status: developing
    who: okarcz
    note: "OpenBao and AWS KMS compared again: OpenBao needs its own machine, and mainnet may unseal from a KMS anyway; the choice is reopened."
  - date: "2026-10-16"
    status: developing
    who: okarcz
    note: "Our eth-signer-kms read as a pattern for a KMS Stellar signer; a Stellar adapter needs none of its fix-ups."
---

# Facilitator key custody on Hetzner

## Question

ADR 0011 kept the facilitator key in AWS SSM on testnet and moved it into AWS KMS on mainnet. The
facilitator now runs on Hetzner instead. Is a KMS signer still the best way to keep the key, or is
HashiCorp Vault's Transit engine better? We were told that Transit "can create keys and expose
endpoints that sign with the private key, like KMS, and supposedly supports Stellar keys".

## What the key needs

- **One hot key per network** (AD-12). It is the only signer of every channel and pays every fee
  bump, so it signs at least once per settlement. The pool sees it only as a `TransactionSigner`
  (`packages/signer-pool/src/types.ts`): `signTransaction(xdr, { networkPassphrase })`.
- **Stellar signs with pure Ed25519** over the 32-byte transaction hash. A signer must sign those
  32 bytes as they are, not pre-hash them (Ed25519ph is rejected).
- **A leak can't redirect payments**, since the buyer's auth binds the amount and the payee, but it
  can spend the fee balance and lock the channels (`docs/threat-model.md`).
- **The signer is on the settle path.** If it is down, `/settle` is down; each call adds its
  latency to every settlement.
- **Rotation is an on-chain signer change** (ADR 0011), whatever holds the key.

## The claim about Vault Transit, checked

- **Transit has an `ed25519` key type** that signs and verifies (Vault API docs; OpenBao docs).
- **There is no Stellar support as such.** No Vault plugin for Stellar turned up, and Transit
  knows nothing of Stellar. It works because Stellar's keys are plain Ed25519.
- **The spike proves it** (`../spike/results.md`), on Vault 2.1.2 and OpenBao 2.7.1:
  - Transit's signature over the transaction hash is 64 bytes, and `stellar-sdk` accepts it;
  - a key generated inside Transit gives its raw 32-byte public key, so its G-address;
  - an existing `S…` secret can be imported (BYOK) and keeps its G-address;
  - a non-exportable key refuses export;
  - a `createAccount` signed only by OpenBao landed on testnet (`26a93987…`, ledger 5210493);
  - about 6 ms per signature on a local dev server.

So the claim holds: Transit works like KMS for us. A Transit `TransactionSigner` would parse the
XDR, send `tx.hash()` to `transit/sign/<key>`, strip the `vault:v1:` prefix and add the signature.

## Options

### A. The key as a secret on the host (today's code)

`FACILITATOR_SECRET` from an env file, Docker secret, systemd credential or SOPS/age file.

- Simple, no extra service, no latency.
- The raw key is in the facilitator process. Anyone with the host, the container or a memory dump
  has it for good; the only fix is an on-chain rotation. No audit of its use.

### B. A cloud KMS called from Hetzner

**AWS KMS** (`ECC_NIST_EDWARDS25519`, task 0036) or **Google Cloud KMS** (`EC_SIGN_ED25519`,
documented as pure Ed25519 over the data).

- HSM-backed, managed, the key never leaves. Every `Sign` is audited.
- Hetzner has no KMS or HSM product (none found), so the key sits at another cloud:
  - the facilitator needs credentials for it. AWS IAM Roles Anywhere gives short-lived credentials
    against an X.509 certificate, so that certificate's key becomes the secret to protect on the
    Hetzner host; Google has Workload Identity Federation for the same purpose;
  - every settlement crosses the internet to sign (latency not measured; to do);
  - an outage there stops `/settle` here, and it keeps the vendor we are leaving.
- AWS's Ed25519 is unproven for Stellar (0036's spike); Google documents pure Ed25519 but the
  output was not tested here.
- The key can't be exported, so losing it locks the channels and the fee account.

### C. Vault or OpenBao Transit, self-hosted on Hetzner

- The raw key never enters the facilitator process: it calls an API, as with KMS.
- Every use is in the audit log; policies limit the facilitator's token to
  `transit/sign/<its key>`. Revoking the token stops signing at once.
- Runs in our private Hetzner network: about 6 ms locally, no other vendor.
- Keys can be generated inside (non-exportable) or imported, so the testnet key and an existing
  mainnet key can move in.
- **It is software, not an HSM.** The key sits in OpenBao's storage, encrypted under its barrier
  key, and in OpenBao's memory while unsealed. Root on the OpenBao server can get it. So it must
  run on its own server, never on the facilitator's host.
- **We run it.** Storage (Raft), backups, upgrades, TLS, and unsealing after every restart.
- **The unseal is the new root of trust:**
  - Shamir (default): people enter key shares after every restart. Secure, but a reboot stops
    `/settle` until someone unseals;
  - static seal (OpenBao): a 32-byte key in a file or env var on the OpenBao server. Auto-unseal,
    and that one secret is what protects the vault;
  - PKCS#11 seal: an HSM unwraps the root key once at start. Open source in OpenBao (an external
    KMS plugin; KMS plugins work since 2.6.0); Vault offers HSM seals only in Enterprise. Hetzner
    can't host the HSM today (see [Mainnet unseal, checked](#mainnet-unseal-checked));
  - cloud KMS seal: AWS, GCP, OVHcloud and other KMSs unwrap the root key once at start, also
    through a KMS plugin (see the same section).
- Backups of its storage keep the key (encrypted), so a lost server isn't a lost key, unlike a
  KMS key. The backups need the unseal keys.

### D. A hardware HSM (YubiHSM 2)

- Signs Ed25519 in hardware; the key never leaves.
- About 168 ms per Ed25519 signature of 256 bytes (Yubico's data sheet): too slow for the hot path
  at the pool's rates, one device is one point of failure, and Hetzner would need a dedicated
  server with a USB device, which Hetzner doesn't offer (see
  [Mainnet unseal, checked](#mainnet-unseal-checked)).
- Fits better as **OpenBao's PKCS#11 seal**, which signs nothing per settlement.

### E. Stellar-level limits (with any option)

Not custody, but they cap what a stolen key can do:

- keep a small fee balance on the hot account, topped up from an offline account;
- a second, offline signer on each channel and the fee account, so a lost or locked key can be
  replaced (0036's recovery question);
- the per-transaction fee ceiling (exists), spend budgets (0024), balance alarms (0027).

## Comparison

| | A. Secret on host | B. Cloud KMS | C. OpenBao Transit | D. YubiHSM |
| --- | --- | --- | --- | --- |
| Raw key in the facilitator | yes | no | no | no |
| Key in hardware | no | yes | no (unless the seal is) | yes |
| Audit of each signature | no | yes | yes | device log |
| Per-signature latency | none | internet round trip (unmeasured) | ~6 ms local + private network | ~168 ms |
| Runs on Hetzner | yes | no, another cloud | yes | needs hardware |
| What we operate | nothing | cross-cloud identity | a 1–3 node cluster, unseal, backups | the device |
| Losing the key | backups of the secret | locked accounts | storage backups + unseal keys | locked accounts |
| Proven for Stellar | yes | AWS: no (0036); Google: untested | yes (spike, testnet) | not tested |
| Cost | none | ~$1/key/month + per sign | one small server per network | device |

## Vault or OpenBao

They are API-compatible for Transit: the same spike passed on both, unchanged.

- **License:** Vault is under the Business Source License 1.1 since August 2023 (IBM owns
  HashiCorp since 2025). Internal self-hosting is allowed, but not offering it as a competing
  service; the terms can change again. OpenBao is MPL-2.0 under the Linux Foundation, forked from
  Vault 1.14.
- **Features we'd use:** both have Transit with Ed25519, import and non-exportable keys. OpenBao
  has the PKCS#11 HSM seal and a static seal in open source; Vault puts HSM seals in Enterprise.

OpenBao fits better: open license, and the HSM seal without Enterprise.

## Mainnet unseal, checked

After every restart OpenBao is sealed and signs nothing until it gets its root key. Where that key
lives is the custody's root of trust: whoever has it and a copy of OpenBao's storage has the
facilitator key. The recommendation left mainnet open between Shamir and an HSM seal, so both were
checked on 2026-10-16.

**An HSM on Hetzner: not available today.**

- Hetzner documents no way to attach a customer's USB device, such as a YubiHSM, to a dedicated
  server. Extra hardware is ordered by a Robot support ticket, and the listed add-ons are
  Hetzner's own, e.g. 16 and 64 GB USB sticks. Only a ticket could confirm it either way.
- Colocation, which would allow our own hardware, is closed to new customers "until further
  notice" (Hetzner's colocation FAQ, changed 2026-03-06).
- A YubiHSM can be shared over the network through its HTTPS connector, but it would then sit
  outside Hetzner, a new weak point and a single point of failure.

**A cloud KMS seal: possible.**

- OpenBao 2.7 has seals for AWS KMS (`awskms`), GCP Cloud KMS, Azure Key Vault, OCI, AliCloud,
  OVHcloud KMS (`ovhcloud`), KMIP and another OpenBao's Transit, besides static and Shamir.
- Since 2.7.0 the vendor seals (`alicloudkms`, `awskms`, `azurekeyvault`, `gcpckms`, `ocikms`)
  are no longer built in. They are external KMS plugins from the `openbao-plugins` collection,
  "drop-in support" per the deprecation notice, declared with a `plugin "kms"` stanza that the
  `seal` block names.
- The KMS unwraps the root key once at start, never per signature. So it gives hardware-backed
  protection of the root key without option B's costs on every settlement: no cross-cloud call
  per signature, and a KMS outage matters only while OpenBao restarts.
- Its costs: one more plugin to install and upgrade, credentials for the other cloud on the
  OpenBao server, and a restart during a KMS outage leaves OpenBao sealed.
- OVHcloud KMS is a European provider. Whether it suits us better than AWS or GCP isn't
  checked.

**So mainnet's real choice is Shamir with an on-call person, or a cloud KMS seal.** The HSM seal
is out until Hetzner offers one.

## OpenBao or AWS KMS, revisited

The recommendation below chose OpenBao assuming it needs nothing beyond our Hetzner setup. Two
findings weaken that:

- OpenBao can't share the facilitator's server, so it needs its own Cloud machine
  ([R-openbao-on-hetzner](R-openbao-on-hetzner.md)): €6.49–11.99 a month for one node, about
  €19.50–36 for three, plus our time to run it.
- With no HSM on Hetzner, a hardware-rooted mainnet unseal is a cloud KMS seal
  ([Mainnet unseal, checked](#mainnet-unseal-checked)). We would then run OpenBao *and* depend on a
  cloud KMS.

### One settlement with KMS, the facilitator on Hetzner

```
seller ==> POST /settle ==> facilitator on the Hetzner dedicated server (Falkenstein)
==> builds the channel transaction, hashes it
==> HTTPS to KMS eu-central-1 (Frankfurt): Sign(hash, ED25519_SHA_512, RAW) ==> 64-byte signature
==> builds the fee bump around it, hashes it ==> Sign again ==> sends it to the network
```

- **Two signatures per submission, one after the other:** `submitter.ts` signs the inner
  transaction, then the fee bump, whose hash covers the signed inner one. Each is a KMS round trip
  (with OpenBao, a round trip over the vSwitch). `/verify` signs nothing.
- **Credentials:** Hetzner has no IAM role, so the facilitator gets short-lived AWS credentials
  through IAM Roles Anywhere, against an X.509 certificate on its server. The IAM policy allows only
  `kms:Sign` on the one key, with the condition `kms:SigningAlgorithm = ED25519_SHA_512`. Every
  `Sign` is in CloudTrail; disabling the certificate or the trust anchor stops signing.
- **Same interface:** a KMS `TransactionSigner` replaces `Keypair.sign(hash)` with a remote call,
  as an OpenBao one would.

### Hardware or software custody

- **Software (OpenBao):** the key is decrypted into the memory of an ordinary computer to sign.
  Root on the OpenBao machine, a memory dump, or a storage backup together with the unseal keys
  can **copy** it. A copy is usable for good, until a rotation on chain.
- **Hardware (KMS's HSMs):** the key is generated and used inside the HSM, and no API returns it.
  An attacker can only **use** it while they have access, and cutting access ends it.
- **On the facilitator's server, the two are equal:** root there can't take the key in either
  case, but can make it sign while there. Task 0048's thresholds bound what those signatures can
  do.
- **The difference is the second place:** OpenBao adds a machine, its backups and its unseal
  keys, any of which can leak the key for good. KMS has no such place on our side.
- **Hardware's cost is no copy:** a key generated in KMS has no backup, so 0048's offline
  recovery signer becomes mandatory. Importing our own key keeps an offline original, which is
  again a copy outside hardware.

### Can KMS sign for Stellar?

- **The documentation says yes:** key spec `ECC_NIST_EDWARDS25519`; `ED25519_SHA_512` with
  `MessageType: RAW` is pure EdDSA (FIPS 186-5 section 7.6), and RAW takes 0–4096 bytes, so the
  32-byte transaction hash fits. `ED25519_PH_SHA_512` (`DIGEST`) is HashEdDSA, which Stellar
  rejects. Import (BYOK) is supported for asymmetric keys other than ML-DSA.
- **Indirect evidence:** Solana's keychain has an AWS KMS backend, `@solana/keychain-aws-kms`,
  which "uses `ED25519_SHA_512` algorithm with `RAW` message type". Solana accepts only pure
  Ed25519, as Stellar does; only the signed bytes differ (the message there, the 32-byte hash
  here).
- **Not tested here:** a test in our AWS account was stopped before it created any key
  (okarcz, 2026-10-16). The real test, a known key imported and its signature compared byte for
  byte with stellar-sdk's (Ed25519 is deterministic), plus one testnet transaction, would be the
  first step of 0036 if KMS is chosen.

### A pattern we already have: `eth-signer-kms`

[`@rumblefishdev/eth-signer-kms`](https://github.com/rumblefishdev/eth-signer-kms) (ours, ISC)
is an ethers `Signer` that signs Ethereum transactions with an AWS KMS key (`ECC_SECG_P256K1`).
Read on 2026-10-16:

- **Address:** `GetPublicKey` returns the key as DER SPKI; it decodes the ASN.1 to the 65-byte
  point and takes keccak256's last 20 bytes.
- **Signature:** it hashes the transaction with keccak256 itself and calls
  `Sign(hash, ECDSA_SHA_256, MessageType: DIGEST)`, since KMS has no keccak. Three fix-ups follow:
  1. it decodes KMS's DER `{r, s}` into two 32-byte numbers;
  2. it flips `s` to low-s (`n − s`, EIP-2);
  3. it finds the recovery bit `v` by trying 0 and 1 until the recovered address matches.
- **Permissions:** `kms:Sign` and `kms:GetPublicKey` on the key.
- **Tests:** without AWS, with `docker-compose` running `nsmithuk/local-kms` (a KMS emulator) and
  `anvil` (a local Ethereum node).

The same adapter for Stellar is simpler:

| Step              | Ethereum (`eth-signer-kms`)                     | Stellar                                                      |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Key spec          | `ECC_SECG_P256K1`                               | `ECC_NIST_EDWARDS25519`                                      |
| Address           | ASN.1 → 65-byte point → keccak → 20 bytes       | the SPKI's last 32 bytes (fixed 12-byte header) → `G…`       |
| Sent to KMS       | keccak hash, `ECDSA_SHA_256`, `DIGEST`          | the 32-byte transaction hash, `ED25519_SHA_512`, **`RAW`**   |
| Returned          | DER `{r, s}`                                    | the 64-byte signature as is                                  |
| Fix-ups           | DER decoding, low-s, recovery bit               | none: Ed25519 is deterministic and has no recovery bit       |
| Into the tx       | `{r, s, v}`                                     | `tx.addSignature(G…, signature)`, which also verifies it     |

- **`RAW`, not `DIGEST`:** pure Ed25519 hashes the message itself (SHA-512, inside the
  algorithm), so the transaction hash goes in as the message. `DIGEST` with `ED25519_PH_SHA_512`
  is the prehash variant Stellar rejects.
- **Behind `TransactionSigner`:** `signTransaction(xdr, { networkPassphrase })` parses the XDR,
  signs `tx.hash()` through KMS and adds the signature, so the pool needs no change.
- **Two improvements over `eth-signer-kms`:**
  1. take the `G…` address from config instead of `GetPublicKey` at start, so the facilitator's
     role needs only `kms:Sign` (as `@solana/keychain-aws-kms` does); an admin role can check the
     address against `GetPublicKey` once;
  2. rely on `addSignature`'s own check, so a wrong mode or key fails before anything is sent.
- **An emulator test, free and without AWS:** `local-kms` won't do, as its README lists only the
  NIST P-curves (secp256r1/384r1/521r1). MiniStack supports `ECC_NIST_EDWARDS25519` with
  `ED25519_SHA_512` over `RAW` since June 2026. It would test the adapter end to end (address,
  signature, `addSignature`, a testnet transaction), but not what real KMS returns, which stays the
  first step of 0036.

### Side by side

|                                     | OpenBao on its own Cloud machine                     | AWS KMS                                          |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| Key in hardware                     | no                                                   | yes                                              |
| A second place the key can leak from | the OpenBao machine, its backups, its unseal keys    | none on our side                                 |
| What we run                         | the machine, upgrades, backups, unseal, HA            | a certificate (rotation) and an IAM policy        |
| Monthly cost                        | €6.49–36, plus our time                              | $1 a key, plus $0.15 per 10,000 signatures       |
| Per-signature path                  | vSwitch to our machine (~6 ms locally, unmeasured there) | internet to Frankfurt (unmeasured)          |
| Outage that stops `/settle`         | our machine (unless three nodes)                     | KMS, or the path to AWS                          |
| Proven for Stellar                  | yes (spike, testnet)                                 | documented, and used for Solana; not tested here |
| Vendor                              | none                                                 | AWS, which hosting has just left                 |

**Reading:** with its own machine and possibly a KMS seal, OpenBao no longer wins on cost or
simplicity. KMS gives hardware custody with nothing to run. OpenBao still wins if we want no AWS
dependency at all, or if KMS's test fails. Before choosing:

1. Why hosting left AWS: cost only, or no AWS at all.
2. The latency of two sequential `Sign` calls from the facilitator's server to `eu-central-1`.
3. If KMS: the real test above, first.

## Recommendation

> Decided on 2026-10-19 in [ADR 0013](../../../../../docs/adr/0013-facilitator-key-custody.md):
> OpenBao in a container on the facilitator's server, no cold key
> ([S-key-custody-decisions](S-key-custody-decisions.md)). Reopened on 2026-10-16: see
> [OpenBao or AWS KMS, revisited](#openbao-or-aws-kms-revisited). The list below is the original
> recommendation.

1. **A self-hosted OpenBao Transit signer, not a cloud KMS.** On Hetzner a KMS means another
   cloud, cross-cloud credentials and a network round trip per settlement, for the one property
   OpenBao lacks: hardware custody. OpenBao keeps the key out of the facilitator process, audits
   each signature, and is proven on testnet. The pool already takes any `TransactionSigner`.
2. **The same mechanism on both networks.** Unlike ADR 0011, testnet runs the same signer, so
   mainnet isn't its first real load.
3. **OpenBao on its own server** in the private network, TLS, a token or certificate whose
   policy allows only `transit/sign/<key>`, the audit log shipped off the box. Where it runs, its
   cost and its link to the facilitator: [R-openbao-on-hetzner](R-openbao-on-hetzner.md).
4. **Unseal:** a static seal on testnet; for mainnet, choose between Shamir with an on-call person
   and a cloud KMS seal (AWS, GCP or OVHcloud). An HSM seal isn't possible on Hetzner today
   ([Mainnet unseal, checked](#mainnet-unseal-checked)).
5. **Recovery on chain:** a second, offline signer on every channel and the fee account, and a
   small hot balance.
6. **Keep B open.** If mainnet needs hardware custody, a cloud KMS behind the same interface is
   still possible; 0036's spike would then run against the chosen cloud.

## Open questions

- Is Hetzner the decision for both networks? ADR 0011 still says AWS; it needs a superseding ADR.
- OpenBao or AWS KMS, now that OpenBao needs its own machine (see the revisited comparison).
- Mainnet unseal: Shamir and on-call, or a cloud KMS seal, and which KMS (AWS, GCP or OVHcloud)?
  Hetzner can't host an HSM today.
- One OpenBao node or three (Raft) for mainnet: a lone node down stops `/settle`.
- The latency from the facilitator to OpenBao over Hetzner's private network (to measure).
- Do the channels keep the facilitator key as their only signer, or get an offline second one?

## Sources

- [Vault Transit API](https://developer.hashicorp.com/vault/api-docs/secret/transit): key types,
  sign, import (BYOK), export (checked 2026-10-15)
- [OpenBao Transit](https://openbao.org/docs/secrets/transit/) and
  [its API](https://openbao.org/docs/api/secret/transit/)
- [OpenBao PKCS#11 seal](https://openbao.org/docs/configuration/seal/pkcs11/),
  [static seal](https://openbao.org/docs/configuration/seal/static/)
- [HashiCorp's BSL 1.1 announcement](https://discuss.hashicorp.com/t/hashicorp-projects-changing-license-to-business-source-license-v1-1/57106)
- [Google Cloud KMS algorithms](https://docs.cloud.google.com/kms/docs/algorithms) (`EC_SIGN_ED25519`)
- [AWS KMS key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html),
  [Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html),
  [importing key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html),
  [pricing](https://aws.amazon.com/kms/pricing/) (checked 2026-10-16)
- [rumblefishdev/eth-signer-kms](https://github.com/rumblefishdev/eth-signer-kms),
  [nsmithuk/local-kms](https://github.com/nsmithuk/local-kms),
  [MiniStack v1.3.58 changelog](https://ministack.org/blog/changelog-v1-3-58.html) (checked
  2026-10-16)
- [@solana/keychain-aws-kms README](https://cdn.jsdelivr.net/npm/@solana/keychain-aws-kms@1.4.0/README.md)
- [IAM Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html)
- [OpenBao seal configuration](https://openbao.org/docs/configuration/seal/),
  [AWS KMS seal](https://openbao.org/docs/configuration/seal/awskms/),
  [deprecation notices](https://openbao.org/community/deprecation/) (checked 2026-10-16)
- [Hetzner colocation FAQ](https://docs.hetzner.com/de/robot/colocation/faq),
  [dedicated server hardware](https://docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/dedicated-server-hardware-overview/),
  [server add-on prices](https://docs.hetzner.com/robot/dedicated-server/dedicated-server-hardware/price-server-addons/)
  (checked 2026-10-16)
- [YubiHSM 2 overview](https://docs.yubico.com/hardware/yubihsm-2/hsm-2-user-guide/hsm2-intro-overview.html)
- [YubiHSM 2 data sheet](https://docs.yubico.com/hardware/yubihsm-2/datasheet/_static/YubiHSM_2_Technical_Data_Sheet.pdf)
- ADR 0011, task 0036, `docs/threat-model.md`, spine AD-12
- The spike: `../spike/` (scripts and results)
