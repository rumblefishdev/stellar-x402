# Non-AWS managed KMS / HSM / custody signers for a Hetzner-hosted Stellar facilitator (Oct 2026)

Requirement used throughout: pure Ed25519 (RFC 8032 PureEdDSA, not Ed25519ph) over the 32-byte Stellar transaction hash. Peak load is ~100 signatures per 5 s (20/s, 1,200/min). The signer is called over HTTPS from Hetzner, and the private key never enters the app process.

Note on Stellar: the "message" given to the signer is the 32-byte tx hash itself. Stellar signs that hash with pure Ed25519, which internally runs SHA-512 over it. A signer that offers "pure EdDSA over arbitrary bytes" therefore fits. A signer that only signs a "digest" in the ECDSA sense, or only does Ed25519ph, does not.

## 1. Does Hetzner itself offer KMS / HSM / secrets manager? EU-sovereign alternatives?

### Takeaway
I found no Hetzner KMS, HSM or secrets-manager product, in either Cloud or Robot. Of the EU clouds checked, Scaleway, OVHcloud, STACKIT and Azure offer only RSA and/or ECDSA signing, so none of them can sign for Stellar. A small Dutch provider, Thalassa Cloud, claims Ed25519 signing in its KMS, but I haven't checked it in depth.

### Cited Findings
- The Hetzner Docs root navigation covers General, Cloud, Robot, Managed, Network & Security ("DNS, Networks and Load Balancers") and Storage ("Object Storage, Storage Share, Storage Box"). None of these is a KMS, HSM or secrets manager — [Hetzner Docs](https://docs.hetzner.com/)
- The Hetzner Cloud product page lists the cloud plans, API/CLI, Networks, Firewalls, Images, one-click apps, Load Balancer, DNS, SSL Certificates, Object Storage, Storage Box and Storage Share. It has no key-management product — [Hetzner Cloud](https://www.hetzner.com/cloud)
- An older HashiCorp partner announcement covers Hetzner Cloud and Fortanix as separate Vault/Terraform integrations. It is not a Hetzner KMS — [HashiCorp blog](https://www.hashicorp.com/blog/tech-partner-product-integrations-announcements-june)
- **Scaleway Key Manager** offers asymmetric signing with EC-P256-SHA256, EC-P384-SHA256, RSA-PSS-{2048,3072,4096}-SHA256 and RSA-PKCS1-{2048,3072,4096}-SHA256. It has no Ed25519 — [Scaleway cryptographic details](https://www.scaleway.com/en/docs/key-manager/reference-content/cryptographic-details-key-manager/). The docs are inconsistent: an older schema lists only the EC algorithms, and the Go SDK guide names "ECC_P384_SHA384" — [Scaleway API schema](https://www.scaleway.com/en/developers/api/key-manager/v1alpha1/schema.yml), [Go SDK guide](https://www.scaleway.com/en/docs/key-manager/api-cli/sign-verify-key-with-go-sdk/)
- **OVHcloud KMS** documents RSASSA-PKCS1 v1.5 (RS256/384/512), RSASSA-PSS (PS256/384/512) and ECDSA on P-256/P-384/P-521. The snippets I retrieved show no Ed25519/OKP — [OVHcloud KMS usage](https://docs.ovhcloud.com/en/guides/manage-and-operate/kms/kms-usage)
- **STACKIT KMS**: a reseller page lists RSA-2048/3072/4096 (OAEP) as its asymmetric algorithms. I found no official signing-algorithm list — [innFactory STACKIT KMS](https://innfactory.de/en/cloud/stackit/products/key-management-service/)
- **Thalassa Cloud KMS** (EU provider) states that it supports asymmetric signing with RSA, ECDSA and Ed25519 keys. Ed25519 public keys are returned as base64 raw key material, and sign/verify calls are limited to the key's region — [Thalassa Cloud KMS sign/verify](https://docs.thalassa.cloud/docs/kms/sign-verify-hmac/)
- **Azure Key Vault (vaults)** offers EC-P256, P-256K, P-384 and P-521 (ES256/ES256K/ES384/ES512) plus RSA and oct-HSM, with no Ed25519/EdDSA/OKP. Sign is "strictly … 'sign hash'", meaning the service doesn't hash the content. The page was updated 2026-10-06 — [Microsoft Learn: Key types, algorithms](https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details)
- **Azure Managed HSM** lists the same EC curves (P-256, P-256K, P-384, P-521), RSA and AES, with no Ed25519. I read this on the Azure China mirror — [docs.azure.cn Managed HSM keys](https://docs.azure.cn/en-us/key-vault/managed-hsm/about-keys-details)

### Inferences
- Azure's model of signing a pre-computed hash makes it unsuitable for Ed25519 even in principle. Pure Ed25519 has to hash the message inside the signer.
- No EU hyperscaler-style KMS commonly paired with Hetzner (Scaleway, OVH, STACKIT, IONOS, Exoscale) appears to support Ed25519. Thalassa is the only EU cloud KMS that claims it, and it is a small vendor.

### Gaps
- I did not check the Hetzner changelog page by page. Absence is inferred from the docs navigation and the product page.
- I found no documentation on IONOS or Exoscale KMS signing algorithms.
- The STACKIT official signing-algorithm list is unconfirmed.
- I have not checked Thalassa Cloud's maturity, pricing, protection level (software or HSM), or whether its Ed25519 is pure or ph.

## 2. Google Cloud KMS / Cloud HSM — EC_SIGN_ED25519

### Takeaway
GCP Cloud KMS supports `EC_SIGN_ED25519` in PureEdDSA mode, which fits Stellar, but only at the SOFTWARE protection level: it is not in the HSM, single-tenant HSM or EKM tables. It is cheap (~$0.06 per key per month, $0.03 per 10k signs), and its quota (~60k signs/min) far exceeds our need. Hetzner hosts can authenticate through Workload Identity Federation with X.509 client certificates, so there is no long-lived service-account JSON. I could not verify whether an existing Stellar key can be imported.

### Cited Findings
- `EC_SIGN_ED25519` is "EdDSA on the Curve25519 in PureEdDSA mode, which takes raw data as input instead of hashed data." It appears in the "Any" and **software** tables, and **not** in hsm, hsm-single-tenant, external or external-vpc. The HSM EC signing table lists only EC_SIGN_P256_SHA256, EC_SIGN_P384_SHA384 and EC_SIGN_SECP256K1_SHA256 — [GCP KMS algorithms](https://docs.cloud.google.com/kms/docs/algorithms?hl=en)
- Community libraries say GCP KMS has supported Ed25519 since April 2024. The request sends raw bytes in the `data` field instead of `digest`, the signature comes back as raw 64 bytes (not DER), and the public key is SPKI, from which the 32 raw bytes are extracted. This source is secondary — [Signet Solana CloudKMS signer](https://signet.hexdocs.pm/Signet.Solana.Signer.CloudKMS.html), [Cartouche CloudKMS](https://cartouche.hexdocs.pm/Cartouche.Solana.Signer.CloudKMS.html)
- SOFTWARE keys use BoringCrypto (FIPS 140-2 validated, Level 1). HSM keys are FIPS 140-2 Level 3 — [GCP protection levels](https://cloud.google.com/kms/docs/protection-levels?hl=ko)
- Quotas for software-backed asymmetric sign:
  - before 16 Feb 2026: 60,000 QPM per calling project;
  - from 16 Feb 2026: a "Software usage" quota of 6,000,000 tokens/min (soft enforcement), at 100 tokens per sign, so roughly 60,000 signs/min.
  - The HSM quota is 3,000,000 tokens/min, at 4,500 tokens per P-256 sign — [GCP KMS quotas](https://docs.cloud.google.com/kms/quotas)
- Pricing (effective 17 Mar 2025):
  - software crypto operations cost $0.03 per 10,000;
  - software asymmetric EC key versions cost $0.000082192/hour, about $0.06/month — [GCP KMS pricing (via search snippet)](https://cloud.google.com/kms/pricing). The page itself was truncated when fetched, so treat these figures as snippet-verified only.
- Workload Identity Federation with X.509 certificates lets workloads that hold an mTLS client certificate exchange it for short-lived credentials. The CA is registered as a trust anchor, and third-party CAs, private CAs or self-signed certificates are accepted — [GCP WIF with X.509](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-x509-certificates)
- The separate "certificate-based access", which binds tokens to the mTLS endpoint, requires allowlist enrollment — [GCP CBA for WIF](https://docs.cloud.google.com/access-context-manager/docs/configure_cba_for_workloads)
- Import jobs exist in general: you wrap the key material with the job's public key, call ImportCryptoKeyVersion, and the job expires after 3 days — [google-cloud-kms ImportJob](https://docs.rs/google-cloud-kms-v1/1.11.0/google_cloud_kms_v1/model/struct.ImportJob.html)

### Inferences
- Load fits easily: 20 signs/s is 1,200/min, about 2% of the software quota.
- Cost: even a sustained 20/s for a whole month (~52M signs) would be about $155 in operations, plus cents for keys. This is my calculation from the cited rates.
- Custody: the key sits in Google's software KMS. It is non-exportable through the API but not HSM-protected.
- Credential left on the Hetzner host: an X.509 client private key, which could live in a TPM or on disk. A thief can sign until the certificate or the WIF provider is revoked; it cannot extract the Stellar key. An IAM condition can limit the identity to `cloudkms.cryptoKeyVersions.useToSign` on one key.
- Recovery: if keys are generated in KMS and cannot be exported, losing the GCP project means losing the key. For Stellar this can be mitigated by adding a backup signer or master key on the account, i.e. by account-level multisig rather than key export.
- Latency: likely about 20–40 ms Hetzner FSN/NBG/HEL → europe-west3 (Frankfurt) or europe-north1 (Finland) RTT plus KMS processing. **Unverified; no published figure found.**

### Gaps
- GA vs preview status of EC_SIGN_ED25519: the algorithms page shows no preview banner, but I found no release note dating GA.
- Whether `EC_SIGN_ED25519` is accepted for **import** (and with which wrapping method): not confirmed.
- No measured latency from Hetzner to GCP KMS.
- The GA status of X.509 WIF is not explicitly confirmed. The IAM doc presents it without a preview label.

## 3. Azure Key Vault / Managed HSM — Ed25519?

### Takeaway
Not supported. Both Key Vault and Managed HSM offer only NIST/secp256k1 ECDSA, RSA and AES, and their signing model is "sign a pre-computed hash", which cannot express pure Ed25519.

### Cited Findings
- EC curves are P-256, P-256K, P-384 and P-521 only. Sign is "strictly … 'sign hash'… Applications should hash the data to be signed locally" (doc updated 2026-10-06) — [Microsoft Learn](https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details)
- Managed HSM has the same curves and no EdDSA — [docs.azure.cn Managed HSM](https://docs.azure.cn/en-us/key-vault/managed-hsm/about-keys-details)

### Inferences
- Exclude Azure. Azure Cloud HSM (dedicated, PKCS#11) was not examined and would be a different, far costlier product.

### Gaps
- Azure Cloud HSM (the single-tenant Marvell-based successor to Dedicated HSM) was not checked for CKM_EDDSA.

## 4. Third-party HSM-as-a-service (Fortanix, Thales DPoD, Entrust, Utimaco, Securosys)

### Takeaway
Fortanix DSM SaaS (REST) and Thales Luna Cloud HSM on DPoD (PKCS#11 CKM_EDDSA, pure Ed25519 by default) both document Ed25519 that can do pure mode. Securosys CloudHSM supports Ed25519 according to a third-party integration doc, but I couldn't confirm it through its REST/TSB API. All of them are enterprise-priced or sales-gated, and I found no public price. Entrust nShield-as-a-service and Utimaco were not verified.

### Cited Findings
- **Fortanix DSM** lists EdDSA Ed25519 in "standard" and "prehash" modes, with prehash using SHA-512. Key formats are PKCS#8 / SPKI DER (RFC 8410) — [Fortanix DSM algorithm support](https://support.fortanix.com/docs/dsm-algorithm-support)
- Fortanix's REST endpoint is `POST /crypto/v1/sign`, and the key must be asymmetric with the SIGN op — [Fortanix sign API](https://support.fortanix.com/apidocs/sign-with-a-private-key-the-key-must-be-asymmetric-and-have-the-sign-key-operati.md)
- Keyfactor SignServer, integrated with Fortanix, supports Ed25519 as "Pure EdDSA with Edwards25519" and notes that the client must specify the hashing used — [Keyfactor SignServer algorithm support](https://docs.keyfactor.com/signserver/7.3.2/algorithm-support-2)
- **Thales Luna Cloud HSM (DPoD)**:
  - `CKM_EDDSA` follows "PureEDDSA" (RFC 8032). Leaving out the params gives plain Ed25519, and the prehash flag gives Ed25519ph (firmware ≥7.4.0). The context length must be 0. Keys are CKK_EC_EDWARDS — [Thales DPoD CKM_EDDSA](https://thalesdocs.com/dpod/services/luna_cloud_hsm/extern/client_guides/Content/sdk/luna_cloud_mechanisms/CKM_EDDSA.htm)
  - FIPS-approved status depends on firmware: one page says 7.8.9+, another 7.9.2+, and the 10.2 docs say "No" — [Luna 7 CKM_EDDSA](https://thalesdocs.com/gphsm/luna/7/docs/network/Content/sdk/mechanisms/CKM_EDDSA.htm), [Luna 10.2 CKM_EDDSA](https://thalesdocs.com/gphsm/luna/10.2/docs/network/Content/sdk/mechanisms/CKM_EDDSA.htm)
- **Securosys CloudHSM / Primus**:
  - Per the EJBCA integration, the HSM supports "RSA, ECDSA, and Ed25519 (not in legacy Sun P11 crypto token)" — [Keyfactor EJBCA Securosys](https://docs.keyfactor.com/ejbca/9.5/securosys-primus-hsm-and-cloudshsm-service)
  - The CloudHSM features page lists RSA, ECC, DH and PQC (Dilithium, Kyber, SPHINCS+), with APIs JCA/JCE, CNG, PKCS#11, OpenSSL, REST (TSB) and KMIP. It does not mention EdDSA explicitly — [Securosys CloudHSM features](https://docs.securosys.com/cloudhsm/Overview/features)
  - The TSB REST base URL is `https://rest-api.cloudshsm.com`, with JWT auth — [Securosys TSB quickstart](https://docs.securosys.com/tsb/quickstart)
  - Pricing: an "Economy (ECO)" monthly package with public pricing in Cloud Console (EUR) — [Securosys Cloud Console](https://www.securosys.com/cloud-security/cloud-console)

### Inferences
- **Fortanix DSM SaaS** fits our REST-over-HTTPS model best. Its "standard" Ed25519 mode is very likely pure (RFC 8032), but sending a 32-byte tx hash as the message with no hash should be tested on a trial account.
- **Thales DPoD** needs a PKCS#11 client library on the Hetzner host, which a Node app would call through a native binding or a small sidecar. That adds operational weight but gives FIPS 140-3 L3 hardware.
- **Securosys** is a Swiss/EU vendor with a REST TSB, which is attractive for EU sovereignty. Ed25519 through TSB is unconfirmed.
- All of these leave an API credential (API key, client cert or JWT/partition PIN) on the Hetzner host. They hold the key in real HSMs, and with Luna and Fortanix import/export can be governed by policy.

### Gaps
- Pricing for Fortanix SaaS, DPoD and Securosys: no public numbers found.
- EU data-centre locations were not confirmed for any of them.
- No latency figures.
- Entrust nShield-as-a-Service, Utimaco (u.trust Anchor / HSMaaS) and Marvell LiquidSecurity-based offerings were not researched, for lack of tool budget.
- Whether Securosys TSB REST exposes Ed25519 sign: unconfirmed (the API reference sits behind the support portal).

## 5. Crypto-custody signer APIs (Turnkey, Fireblocks, Dfns, Privy, Coinbase)

### Takeaway
Turnkey offers raw Ed25519 payload signing and lists Stellar as a supported Ed25519 chain. Fireblocks offers raw EdDSA signing as a paid add-on, but its Stellar raw signing has documented friction. Dfns has a native Stellar transaction-signing endpoint. Privy lists Stellar as a Tier 2, transaction-aware chain. At our volume, per-signature pricing makes these an order of magnitude or more costlier than GCP KMS, and some (Fireblocks) add policy/approval latency.

### Cited Findings
- **Turnkey**:
  - "we support signing for all chains and assets on the Ed25519, Secp256k1, and P256 curves", with Stellar named as an example of a chain not specifically listed — [Turnkey other ecosystems](https://docs.turnkey.com/ecosystems/others)
  - Turnkey also supports bare Ed25519 signing — [Turnkey docs search result](https://docs.turnkey.com/features/networks/others)
  - The sign_raw_payload `hashFunction` enum includes `HASH_FUNCTION_NOT_APPLICABLE`, and encoding includes `PAYLOAD_ENCODING_HEXADECIMAL` — [Turnkey sign raw payload](https://docs.turnkey.com/api-reference/activities/sign-raw-payload)
  - The Turnkey Dart SDK says the field "must be set to HASH_FUNCTION_NOT_APPLICABLE for EdDSA/ed25519 signature requests", i.e. pure Ed25519 over the given bytes — [turnkey_http TSignRawPayloadsBody](https://pub-web-s2.flutter-io.cn/documentation/turnkey_http/1.1.0/__generated___models/TSignRawPayloadsBody-class.html)
  - A batch endpoint (`sign_raw_payloads`) exists — [Turnkey sign raw payloads](https://docs.turnkey.com/api-reference/activities/sign-raw-payloads)
  - Billing is per successful signature, with 25 free per month — [Turnkey FAQ](https://docs.turnkey.com/faq)
  - Third-party, unverified figures: $0.10/signature pay-as-you-go, $0.05 on a $99/month plan, volume discounts down to about $0.01 — [apicostcalc](https://apicostcalc.com/privy-vs-dynamic-vs-turnkey-wallet-cost-calculator.html)
  - Third-party, unverified latency: "typically achieving 50-100ms" — [toolradar](https://toolradar.com/tools/turnkey)
- **Fireblocks**:
  - Raw signing generates ECDSA/EdDSA signatures over any message. It is a premium add-on and policy rules must allow RAW — [Fireblocks support](https://support.fireblocks.io/hc/en-us/articles/4413379762450)
  - API: `operation: RAW`, `extraParameters.rawMessageData.messages`, algorithm `MPC_EDDSA_ED25519`, up to 127 messages per call — [Fireblocks: Structure the API call](https://developers.fireblocks.com/reference/structuring-the-api-call-1)
  - A community thread shows HTTP 400 "Invalid message content" when signing raw Stellar XDR for XLM_TEST; a reply suggests hashing and hex-encoding first — [Fireblocks community](https://community.fireblocks.com/t/trouble-signing-raw-stellar-transaction/539)
  - XLM is a natively supported asset — [Fireblocks signing callback ref](https://developers.fireblocks.com/reference/approve-transactions)
- **Dfns**:
  - A Stellar sign endpoint takes kind `Transaction`, an unsigned hex-encoded transaction and the network passphrase — [Dfns Stellar sign](https://docs.dfns.co/api-reference/sign/stellar)
  - Dfns supports EdDSA/Ed25519 hash signing and message signing — [Dfns generic signature](https://docs.dfns.co/d/api-docs/wallets/generate-signature-from-wallet/pseudo-networks-all-other-chains-generate-signature)
- **Privy**:
  - Stellar is listed in Tier 2 ("Sign transactions … Privy decodes and validates the transaction before signing"), not Tier 1 low-level signing — [Privy chains overview](https://docs.privy.io/wallets/overview/chains)
  - The raw sign endpoint is `POST https://api.privy.io/v1/wallets/{wallet_id}/raw_sign` with a 0x-hex hash — [Privy raw sign](https://docs.privy.io/wallets/using-wallets/other-chains/raw-sign)
  - The Privy docs describe the tiers inconsistently: one recipe says Tier 2 uses raw sign over a hash — [Privy Tier 2 recipe](https://docs.privy.io/recipes/use-tier-2.md)

### Inferences
- Cost at our peak: 20 signs/s sustained would be about 52M signs/month. At $0.01–$0.10 per signature that is roughly $0.5M–$5M/month, against about $155 on GCP KMS (my arithmetic from the cited rates). Even at 1M signs/month, Turnkey would cost about $10k–$100k. Unless negotiated enterprise pricing is close to free, custody APIs are uneconomic for a high-volume facilitator hot key.
- Custody model: Turnkey uses secure enclaves (TEE), Fireblocks and Dfns use MPC, and Privy uses TEE plus key sharding. These models are built for user wallets and treasury, with policy engines that add latency. Fireblocks RAW goes through its transaction lifecycle and policy engine, which is likely to be seconds, not milliseconds (**unverified**).
- Turnkey's raw payload with `HASH_FUNCTION_NOT_APPLICABLE` over the 32-byte tx hash matches Stellar's requirement exactly. It is the most direct fit among the custody APIs.
- Lock-in and recovery: Turnkey and Dfns support key export or import (the general product claim; **not verified here**). With MPC (Fireblocks), recovery goes through the vendor's recovery tool — [Fireblocks Recovery Tool for raw signing](https://support.fireblocks.io/hc/en-us/articles/22000090882716-Using-the-Recovery-Tool-for-raw-signing)

### Gaps
- Coinbase CDP Server Wallets: not researched; Stellar support unknown.
- No published per-request latency SLAs from any custody vendor.
- Rate limits for Turnkey, Privy and Dfns were not retrieved.
- Turnkey's official per-signature price was not found on turnkey.com.
- Whether Privy's Stellar Tier 2 signing accepts an arbitrary hash or requires a decodable Stellar transaction (it may need the XDR, not the hash): unclear.
- Fireblocks' accepted Stellar raw payload format is unconfirmed.

## 6. Pros/cons summary for a Hetzner-hosted Stellar facilitator

### Takeaway
Among the verified non-AWS options, the only one with pure Ed25519 that is also cheap, high-quota and REST-based is GCP Cloud KMS at the SOFTWARE level. It is not HSM-backed, and authentication from Hetzner goes through WIF X.509. For HSM-grade custody, Fortanix DSM SaaS (REST) or Thales DPoD (PKCS#11) are the candidates, each needing a sales conversation and a pure-mode test. Hetzner itself offers nothing, and the EU clouds (Scaleway, OVH, STACKIT, Azure) lack Ed25519.

### Cited Findings
- Each row below follows from the sections above. See the citations in §1–§5.

| Option | Pure Ed25519 | Protection | API | Host credential | Cost at 20/s | Main con |
|---|---|---|---|---|---|---|
| Hetzner | n/a ([docs](https://docs.hetzner.com/)) | — | — | — | — | no product |
| Scaleway / OVH / STACKIT | No | HSM/SW | REST | API key | low | no Ed25519 |
| Azure KV / MHSM | No ([MS Learn](https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys-details)) | HSM | REST | SP secret/cert | low | no Ed25519 |
| GCP Cloud KMS | Yes, PureEdDSA ([GCP](https://docs.cloud.google.com/kms/docs/algorithms?hl=en)) | **Software only** | REST/gRPC | X.509 cert via WIF | ~$155/mo ops (inferred) | not HSM; US hyperscaler; import unverified |
| Fortanix DSM SaaS | Yes, "standard" mode ([Fortanix](https://support.fortanix.com/docs/dsm-algorithm-support)) | HSM (FIPS) | REST | API key / cert | quote | price; pure-mode test needed |
| Thales DPoD Luna Cloud HSM | Yes, PureEdDSA ([Thales](https://thalesdocs.com/dpod/services/luna_cloud_hsm/extern/client_guides/Content/sdk/luna_cloud_mechanisms/CKM_EDDSA.htm)) | HSM | PKCS#11 | client cert + partition creds | quote | PKCS#11 client on host |
| Securosys CloudHSM | Likely ([EJBCA](https://docs.keyfactor.com/ejbca/9.5/securosys-primus-hsm-and-cloudshsm-service)) | HSM (Swiss) | REST TSB / PKCS#11 | JWT / cert | ECO monthly | REST Ed25519 unconfirmed |
| Thalassa Cloud KMS | Claimed ([Thalassa](https://docs.thalassa.cloud/docs/kms/sign-verify-hmac/)) | unknown | REST | API token | unknown | small vendor, unverified |
| Turnkey | Yes, NOT_APPLICABLE hash ([SDK](https://pub-web-s2.flutter-io.cn/documentation/turnkey_http/1.1.0/__generated___models/TSignRawPayloadsBody-class.html)) | TEE | REST | API key (P-256 stamp) | per-signature, very high | cost at volume |
| Fireblocks | EdDSA raw (add-on) ([Fireblocks](https://developers.fireblocks.com/reference/structuring-the-api-call-1)) | MPC | REST | API key + RSA secret | enterprise | latency/policy flow, cost |
| Dfns | Stellar tx endpoint ([Dfns](https://docs.dfns.co/api-reference/sign/stellar)) | MPC | REST | service account | per-plan | cost; tx-level, not hash |
| Privy | Stellar Tier 2 ([Privy](https://docs.privy.io/wallets/overview/chains)) | TEE | REST | app secret | per-plan | unclear hash vs tx |

### Inferences
- In every option, a credential that can **use** the key remains on the Hetzner host. What the managed signer adds is non-extractability, audit logs, revocation and rate or policy limits, not protection against misuse by a compromised host. On Stellar, a separate account-level signer can limit the blast radius, since the facilitator's key only needs to pay fees and sign channel transactions.
- Latency matters most for per-settlement round trips. At 20/s with ~30–60 ms RTT, a simple concurrency of 2–4 in-flight requests suffices for GCP KMS or Fortanix. MPC custody flows with policy engines may not keep up within x402 settle timeouts (**unverified**).

### Gaps
- No end-to-end latency measurements from Hetzner (FSN1/NBG1/HEL1) to any of these services.
- Pricing for the HSM-as-a-service vendors.
- EU residency for GCP KMS key location (europe-west3, europe-north1) is assumed available but not checked for Ed25519 specifically.
