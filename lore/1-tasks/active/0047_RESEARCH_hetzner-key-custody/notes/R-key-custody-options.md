---
title: "Facilitator key custody on Hetzner: KMS, Vault/OpenBao Transit and the rest"
type: research
status: developing
spawns: []
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

## Recommendation

1. **A self-hosted OpenBao Transit signer, not a cloud KMS.** On Hetzner a KMS means another
   cloud, cross-cloud credentials and a network round trip per settlement, for the one property
   OpenBao lacks: hardware custody. OpenBao keeps the key out of the facilitator process, audits
   each signature, and is proven on testnet. The pool already takes any `TransactionSigner`.
2. **The same mechanism on both networks.** Unlike ADR 0011, testnet runs the same signer, so
   mainnet isn't its first real load.
3. **OpenBao on its own server** in the private network, TLS, a token or certificate whose
   policy allows only `transit/sign/<key>`, the audit log shipped off the box.
4. **Unseal:** a static seal on testnet; for mainnet, choose between Shamir with an on-call person
   and a cloud KMS seal (AWS, GCP or OVHcloud). An HSM seal isn't possible on Hetzner today
   ([Mainnet unseal, checked](#mainnet-unseal-checked)).
5. **Recovery on chain:** a second, offline signer on every channel and the fee account, and a
   small hot balance.
6. **Keep B open.** If mainnet needs hardware custody, a cloud KMS behind the same interface is
   still possible; 0036's spike would then run against the chosen cloud.

## Open questions

- Is Hetzner the decision for both networks? ADR 0011 still says AWS; it needs a superseding ADR.
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
