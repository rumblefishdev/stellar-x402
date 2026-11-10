# AWS KMS as the Stellar facilitator signer, from Hetzner (as of 2026-10-15)

Scope: one Ed25519 facilitator key per network, signing the 32-byte Stellar transaction hash (pure Ed25519), up to ~100 signatures per 5 s ledger at peak (~20 Sign/s), called from Hetzner hosts. Official AWS docs are marked [AWS]; third-party sources are marked [3P]. No OpenZeppelin material was used.

## 1. What Ed25519 support AWS KMS has, and whether it is Stellar-compatible

### Takeaway
AWS KMS has supported Ed25519 since 2025-11-07: key spec `ECC_NIST_EDWARDS25519`, algorithm `ED25519_SHA_512` with `MessageType: RAW`, which is pure EdDSA (FIPS 186-5 §7.6). Messages can be up to 4096 bytes, so the 32-byte Stellar hash goes in as a RAW message. AWS says the signature is 64 bytes, and a public Solana signer uses KMS's output as raw 64 bytes, with no DER decoding. The API reference doesn't spell out the EdDSA signature encoding, but the evidence points to raw R||S. `ED25519_PH_SHA_512` is HashEdDSA, which Stellar rejects, and AWS hashes the input a second time in that mode.

### Cited Findings
- [AWS] Announced on 2025-11-07: "AWS KMS now supports Edwards-curve Digital Signature Algorithm (EdDSA)". You can create Ed25519 asymmetric KMS keys or data key pairs to sign and verify. The announcement gives 64-byte signatures and 32-byte public keys, names blockchain/cryptocurrency as a use case, and says the feature is "available in all AWS Regions" (GovCloud and China included). — [AWS What's New](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/)
- [AWS] The key spec is `ECC_NIST_EDWARDS25519 (ed25519) - signing and verification only`. `ED25519_SHA_512` is "NIST FIPS 186-5, Section 7.6, EdDSA signature ... KMS requires MessageType:RAW". `ED25519_PH_SHA_512` is "NIST FIPS 186-5, Section 7.8, HashEdDSA ... KMS requires MessageType:DIGEST ... AWS KMS still performs the SHA-512 prehash ... the input is hashed twice: once by you and once by KMS." The doc adds: "These message types cannot be used interchangeably." — [KMS key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html)
- [AWS] Sign `Message` takes 1–4096 bytes. With `RAW`, "AWS KMS uses the standard signing algorithm, which begins with a hash function", which for Ed25519 is the SHA-512 inside pure EdDSA. The response `Signature` encoding is documented only for RSA (PKCS#1) and ECDSA (DER, RFC 3279), not for EdDSA. Max length is 6144. — [Sign API reference](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
- [AWS] `GetPublicKey` returns "a DER-encoded X.509 public key ... SubjectPublicKeyInfo (SPKI), as defined in RFC 5280", and `ECC_NIST_EDWARDS25519` is among the listed key specs. The Stellar G-address therefore has to be built from the last 32 bytes of the SPKI (an RFC 8410 Ed25519 SPKI is a 12-byte header followed by the 32-byte key). — [GetPublicKey API reference](https://docs.aws.amazon.com/kms/latest/APIReference/API_GetPublicKey.html)
- [3P] `@solana/keychain-aws-kms` v1.4.0 (Solana Foundation, MIT) signs Solana transactions with `SigningAlgorithm: ED25519_SHA_512`, `MessageType: RAW` and the raw message bytes. It takes `response.Signature` as a `Uint8Array` without DER parsing, rejects any length other than `ED25519_SIGNATURE_LENGTH` (64), then verifies the signature locally against the configured public key. It needs `kms:Sign` and `kms:DescribeKey`, and warns that concurrent requests can hit KMS throttling (it has a `requestDelayMs` option). — [README](https://cdn.jsdelivr.net/npm/@solana/keychain-aws-kms@1.4.0/README.md); [aws-kms-signer.js](https://cdn.jsdelivr.net/npm/@solana/keychain-aws-kms@1.4.0/dist/aws-kms-signer.js)
- [3P] Mysten Labs' Sui SDK has an AWS KMS signer, but its docs list only Secp256k1/Secp256r1 schemes, not Ed25519. — [Sui SDK AWS KMS signer](https://sdk.mystenlabs.com/sui/cryptography/signers/aws-kms)

### Inferences
- Pure Ed25519 in FIPS 186-5 §7.6 is the same algorithm as RFC 8032 Ed25519 (FIPS 186-5 adopted RFC 8032). Ed25519 signing is deterministic, so a KMS signature over the 32-byte Stellar tx hash should verify in stellar-core exactly like a local `Keypair.sign(hash)`. A Solana signer in production that checks every KMS output with a standard verifier backs this up, since Solana also uses pure Ed25519 over the raw message.
- This settles two open points from ADR 0011. The output is raw 64 bytes (from AWS's "64-byte signatures" and the Solana code's length check), and seed import is now documented (section 2). Treat the output encoding as confirmed by behaviour, not by the API spec: keep a defensive length==64 check and a local `verify` after each Sign. That costs about 50 µs of CPU and guards against any change in encoding.
- Stellar adapter: `hash = tx.hash()` → `Sign(RAW, ED25519_SHA_512, hash)` → `DecoratedSignature{hint = last 4 bytes of pubkey, signature}`. `ED25519_PH_SHA_512` must never be used, and a key policy can block it with the `kms:SigningAlgorithm` condition.

### Gaps
- No Stellar-specific example or report of KMS-signed Stellar transactions turned up (searched; none found). A testnet smoke test is still needed.
- No official AWS statement that the EdDSA `Signature` field is raw R||S. It is inferred from the announcement and third-party code.
- No statement on whether KMS's Ed25519 verification is cofactored or cofactorless. This doesn't matter for signing deterministic, valid signatures.

## 2. Key import (BYOK), exportability, multi-Region, disable/deletion

### Takeaway
Yes: an existing Ed25519 private key can be imported as PKCS#8 DER into an `EXTERNAL`-origin key, so the current facilitator G-address can be kept. The private key can never be exported from KMS; with imported material, your own copy is the backup. Multi-Region Ed25519 keys are supported, but with imported material you import into each replica yourself. Deletion has a 7–30 day waiting period. Deleting only the imported material can be undone by reimporting it.

### Cited Findings
- [AWS] Import is supported for "Asymmetric KMS keys (except ML-DSA keys)" and for "Multi-Region keys of all supported types", in all Regions, but not in custom key stores. — [Importing key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html)
- [AWS] The ECC import requirements list `ECC_NIST_EDWARDS25519 (ed25519)`, curve "NIST Ed25519", named curves only, and "BER-encoded or DER-encoded ... PKCS #8 format that complies with RFC 5208". Only the private key is imported, and KMS derives the public key. — [Create a KMS key with imported key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-conceptual.html)
- [AWS] Steps: create a key with Origin `EXTERNAL`, call `GetParametersForImport` (RSA wrapping key plus import token), wrap the material (RSAES_OAEP_SHA_1/256 for ECC private keys, or RSA_AES_KEY_WRAP_SHA_1/256), then `ImportKeyMaterial`. Expiration is optional, and expired material is deleted until the same material is reimported. The OpenSSL test examples don't include an Ed25519 line, but `openssl pkcs8 -topk8 -outform der -nocrypt` is the documented conversion. — [Encrypt the key material](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-encrypt-key-material.html); [conceptual](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-conceptual.html)
- [AWS] "The private key that generates signatures never leaves AWS KMS unencrypted." There is no export API for asymmetric private keys. — [Key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html)
- [AWS] Multi-Region keys can be asymmetric and/or use imported material, in all Regions. For `EXTERNAL` origin, "you must import the same key material ... into each replica Region key individually." A replica works even if the primary is disabled. Every primary and replica is billed as one key. A single-Region key can't be converted to multi-Region. — [Multi-Region keys](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html)
- [AWS] Deletion: the waiting period is 7–30 days (default 30, can run up to 24 h longer). The key is in `Pending deletion` and unusable for crypto during that time, and deletion can be cancelled. "Deleting the key material of a KMS key with imported key material is temporary and reversible." If the KMS key itself is deleted, the original asymmetric material can be imported into a new KMS key, which gives the same public key but a new key ID, policy and aliases. — [Delete an AWS KMS key](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html)

### Inferences
- Choosing between them: KMS-generated material means no seed exists anywhere outside the HSMs, but losing the key (account closure, an attacker with admin scheduling deletion that nobody cancels) loses the G-address. That is survivable for Stellar, because the facilitator key is a signer on the channel accounts and the master can rotate signers, but only if another signer or the master survives. Imported material keeps an offline seed backup and the current address, but the seed then exists outside an HSM, which weakens the "never extractable" story.
- Two-region resilience for a Hetzner deployment: create a multi-Region key in eu-central-1 with a replica in eu-west-1 or eu-north-1 and fail over in the signer client. Same key, same G-address.

### Gaps
- Whether KMS accepts a 32-byte raw Ed25519 seed wrapped as RFC 8410 PKCS#8 `OneAsymmetricKey` (OID 1.3.101.112) is implied by the docs but not shown in an Ed25519 example. Test on testnet first.

## 3. Quotas, latency, pricing

### Takeaway
Sign on ECC keys (Ed25519 included) shares a default quota of 1,000 req/s per account per Region. That quota is adjustable, is shared with Verify, DeriveSharedSecret and every ECC key in the account and Region, and is about 50× our ~20/s peak. Pricing: $1/key/month, and asymmetric ECC requests at $0.15 per 10k according to AWS's own ECC example (not shown as Ed25519-specific). Asymmetric calls are excluded from the free tier. AWS publishes no latency figures for Sign.

### Cited Findings
- [AWS] "Cryptographic operations (ECC and SM2) request rate", covering Sign, Verify and DeriveSharedSecret: 1,000 (shared) for ECC keys. "All AWS KMS request quotas are adjustable, except for the AWS CloudHSM key store request quota." Throttling counts requests from all principals in the account and Region. For cross-account use, the calling account is throttled. — [Request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)
- [AWS] The same page has a separate row for `GenerateDataKeyPair (ECC_NIST_EDWARDS25519)` at 100 req/s, which confirms Ed25519 is counted under ECC. — [Request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)
- [AWS] Pricing: $1/month per key, symmetric or asymmetric, with multi-Region primary and replicas each $1/month. The file-signing example bills an ECC 256 key at "$0.15 per 10,000 requests". Asymmetric Sign, Verify and GetPublicKey "are excluded from the free tier" (20,000 req/month). — [KMS pricing](https://aws.amazon.com/kms/pricing/)
- [3P/anecdotal] A re:Post user saw ~160 ms per ECC P-256 Sign from Lambda, and AWS staff asked for a support case. This is not a benchmark. — [re:Post](https://www.repost.aws/questions/QUPEubdAqrSnSLm-38Vjyqpw/kms-signing-performance-with-asymmetric-ecc-nist-p256-key-is-slow)

### Inferences
- Cost estimate, using the ECC rate as a proxy for Ed25519: 1M signatures/month ≈ $15 + $1 key, and 10M ≈ $150. Two networks with multi-Region replicas ≈ $4/month in keys.
- Throughput isn't a concern at our peak, but the quota is account-wide. Use a dedicated AWS account for the signer so other workloads can't starve it, and handle `ThrottlingException` with jittered retries.
- Latency: no official number. Sign from Hetzner Germany to Frankfurt should be dominated by TLS and HTTP round trips over a ~5–10 ms network path plus the HSM operation. A plausible p50 is 10–30 ms with warm keep-alive connections; p99 can be much higher. **Estimate, unverified. Measure it.** That fits inside a 5 s ledger, but it serialises if signing is in the critical path per settlement, so run Sign calls concurrently.

### Gaps
- The pricing page doesn't list an Ed25519-specific request rate. Confirm with the AWS Pricing Calculator.
- No published p50/p99 for KMS Sign, so a benchmark from a Hetzner box is needed.

## 4. Authenticating from Hetzner (outside AWS)

### Takeaway
The best fit is IAM Roles Anywhere: an X.509 client certificate from your CA (or AWS Private CA) is exchanged for temporary STS credentials of 15 min–12 h. Its private key can sit in a TPM 2.0 or PKCS#11 token on the host, so nothing long-lived needs to be extractable. The alternatives are a static IAM user access key (long-lived, extractable, worst) and OIDC web-identity federation from a self-hosted IdP (a signing key for the IdP has to live somewhere). In every case, an attacker with root on the Hetzner host can call Sign while they hold access. KMS limits the blast radius to "sign while compromised, fully logged". The key can't be stolen.

### Cited Findings
- [AWS] Roles Anywhere issues temporary credentials to workloads outside AWS using X.509 certificates from a CA registered as a trust anchor (external CA or AWS Private CA). Profiles can attach a session policy. Resources are regional. — [What is IAM Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html)
- [AWS] Credential helper (v1.8.5, 2026-08-24): the private key can be a plain file, a PKCS#11 URI (hardware/software token or HSM), a TPM-wrapped key (`TSS2 PRIVATE KEY`) or a TPM handle. `--session-duration` ranges from 900 s to 43,200 s. In `serve` mode it exposes an IMDSv2-compatible endpoint on 127.0.0.1:9911, refreshing 5 min before expiry, and warns that "any process running on the system that can reach 127.0.0.1 will be able to retrieve AWS credentials". `update` mode writes credentials to disk. — [Credential helper](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/credential-helper.html)
- [AWS] Certificate Subject, Issuer and SAN (first DNS, URI or DN) become session principal tags such as `aws:PrincipalTag/x509Subject/CN`, usable in trust and resource policies. The source identity is set from the CN. Revocation works only through imported CRLs (`ImportCrl`), with no OCSP or CDP callbacks. — [Trust model](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/trust-model.html)
- [AWS] KMS key policies support all global condition keys. `aws:SourceIp` works for direct calls; AWS warns that it breaks calls made by AWS services on your behalf, which doesn't apply here. For IPv6, IP conditions must include IPv6 ranges, because a policy listing only IPv4 doesn't deny IPv6 callers. `aws:SourceVpce` and `aws:SourceVpc` apply only to VPC endpoints, so they can't be used from Hetzner. — [AWS global condition keys in KMS](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-aws.html)
- [AWS] Encryption context doesn't apply to Sign, whose only parameters are KeyId, Message, MessageType, SigningAlgorithm, GrantTokens and DryRun. — [Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)

### Inferences
- What stays on the host, and the blast radius of each option:
  - **Static IAM user keys**: a long-lived secret in a file or environment variable. If stolen, it can be used from anywhere until rotated, unless a `NotIpAddress` deny on `aws:SourceIp` pins it to the Hetzner IPs, which is strongly recommended. Worst option.
  - **Roles Anywhere + TPM-bound certificate key**: the TPM key can't be extracted, but STS session tokens (up to 12 h, set it to 15–60 min) sit in memory or on the localhost endpoint and can be used from anywhere until expiry. Add `aws:SourceIp` to keep them from being replayed off-host. Revocation means an imported CRL, or removing the trust anchor or role.
  - **OIDC (`AssumeRoleWithWebIdentity`) from a self-hosted IdP**: the IdP's signing key becomes the root secret, and if it lives on Hetzner too, nothing is gained over Roles Anywhere. Not verified in this pass; based on general IAM knowledge.
- Recommended policy shape: the key policy allows only `kms:Sign` (plus `kms:GetPublicKey`/`DescribeKey`) to the one role, with conditions `kms:SigningAlgorithm = ED25519_SHA_512`, `kms:MessageType = RAW`, `aws:SourceIp` in the Hetzner server IPs (v4 and v6), and `aws:PrincipalTag/x509Subject/CN` set to the facilitator host. Admin actions (`ScheduleKeyDeletion`, `PutKeyPolicy`, `DisableKey`) go to a separate break-glass principal with MFA.
- Main limitation: KMS can't check *what* is signed. A 32-byte hash is opaque, so policy can't enforce "only fee bumps up to X". The host that holds a session can sign any Stellar transaction for this key, including a payment draining the facilitator's XLM. Content checks would need a signing proxy (for example a Lambda in AWS that rebuilds and checks the XDR before calling Sign), which adds latency.

### Gaps
- Roles Anywhere pricing wasn't checked. CreateSession quotas and latency weren't checked either. Whether `aws:SourceIp` is evaluated on Roles Anywhere-derived sessions calling KMS directly is expected (it is a direct call) but wasn't tested.

## 5. Network path, latency, availability

### Takeaway
Nearest Regions: Falkenstein and Nuremberg → eu-central-1 (Frankfurt), Helsinki → eu-north-1 (Stockholm), Hetzner Ashburn → us-east-1 (N. Virginia, same metro), Hetzner Hillsboro → us-west-2 (Oregon, same metro). AWS's SLA target for KMS is 99.999% monthly per Region. No measured Hetzner→Frankfurt RTT was found; forum estimates suggest single-digit ms.

### Cited Findings
- [AWS] KMS SLA: AWS "will use commercially reasonable efforts" to reach ≥99.999% monthly uptime per Region. Credits are 10% below 99.999%, 25% below 99.0% and 100% below 95.0%. Last updated 2022-11-29. — [KMS SLA](https://aws.amazon.com/kms/sla/)
- [3P/forum] Hetzner FSN↔NBG ≈ 3.2 ms (relayed Hetzner figure). Falkenstein backhauls through Nuremberg. One poster guessed Falkenstein→Frankfurt at "~5 ms at least" (estimate, not measured). Hetzner's ping targets are fsn.icmp.hetzner.com and nbg.icmp.hetzner.com. — [LowEndTalk](https://lowendtalk.com/discussion/comment/2854445/); [LowEndTalk](https://lowendtalk.com/discussion/comment/2095251/)
- [3P] On 2025-10-19/20, us-east-1 had a large outage (about 15 h end to end) caused by a race condition in DynamoDB's DNS automation, which spread to EC2, Lambda, STS, IAM sign-in and others. These are secondary write-ups; none mention KMS or eu-central-1. — [Medium](https://medium.com/@ismailkovvuru/aws-us-east-1-dns-dynamodb-outage-oct-20-2025-root-cause-lessons-and-the-future-of-cloud-47bd1848a0c8); [dev.to](https://dev.to/harshith_reddy_dev/anatomy-of-a-cloud-collapse-a-technical-deep-dive-on-the-aws-outage-of-october-2025-2mj4)

### Inferences
- STS, which Roles Anywhere uses to vend credentials, is a second regional dependency besides KMS. With sessions of an hour or more, a short STS outage doesn't stop signing, but a KMS outage does. A multi-Region key with client-side failover covers that, at roughly +10–25 ms RTT to eu-west-1 or eu-north-1 from Germany (estimate).
- Avoid us-east-1 for the EU deployment. Keep the Ashburn mapping only if the US Hetzner sites are used.

### Gaps
- No measured RTT from Hetzner to AWS endpoints (estimates only). No KMS-specific outage history found. The AWS Health Dashboard history wasn't searched.

## 6. Audit: CloudTrail and alarms

### Takeaway
Every Sign is a CloudTrail **management** event (logged by default in Event history and in any trail). It records key ID, signing algorithm, message type, caller identity and source IP, but not the message, so you get "who signed when from where" and not "what". Alarms can come from CloudTrail → EventBridge/CloudWatch.

### Cited Findings
- [AWS] Example Sign event: `eventName: Sign`, `sourceIPAddress`, `requestParameters: {messageType, keyId, signingAlgorithm}`, `responseElements: null`, `readOnly: true`, `managementEvent: true`, `eventCategory: Management`. — [CloudTrail Sign event](https://docs.aws.amazon.com/kms/latest/developerguide/ct-sign.html)
- [AWS] AWS points to Service Quotas / CloudWatch alarms on request rate, and CloudWatch alarms on use of keys pending deletion or on imported material nearing expiry. — [Request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html); [Deleting keys](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html); [Importing](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys.html)

### Inferences
- Useful alarms: Sign from a `sourceIPAddress` that isn't a Hetzner IP; Sign rate far above settlement rate (compare with the facilitator's own settlement count); any `PutKeyPolicy`, `ScheduleKeyDeletion`, `DisableKey` or `ImportKeyMaterial`. Logging every Sign means CloudTrail volume roughly equal to settlement volume. Management events in the default trail's first copy are free; extra trails are paid.
- Because the message isn't logged, matching Sign events to Stellar transactions has to happen on our side (log the tx hash next to the KMS `requestID`).

### Gaps
- Exact CloudTrail delivery latency, and the cost of a second trail at high Sign volume, weren't checked.

## 7. Compliance: FIPS 140-3

### Takeaway
The KMS HSM has FIPS 140-3 **Level 3** (CMVP certificate #4884, interim validation, sunset 2026-11-17). Its security policy (firmware 1.8.104, Oct 2024) lists ECDSA P-256/384/521 and secp256k1 but **no EdDSA**. Ed25519 launched in Nov 2025, after that firmware, so as of this research **Ed25519 signing isn't shown to be inside the validated boundary**.

### Cited Findings
- [Mirror of NIST CMVP] "AWS Key Management Service HSM": Security Level 3, interim validation, sunset date 2026-11-17. — [sec-certs #4884](https://sec-certs.org/fips/id/4884); [NIST CMVP #4884](https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4884)
- [Security policy, mirror] HW 3.0 / FW 1.8.104, doc v0.35 dated 2024-10-25. Approved algorithms: ECDSA FIPS 186-4 (P-256/384/521) under CAVP A1908, plus "ECDSA secp256k1 ... may only be used in block-chain related applications". No EdDSA row appears in the portion read (the first ~100k of ~212k characters). — [Security policy text](https://sec-certs.org/fips/9326acebbb07fdc5/target.txt)
- [AWS] The Ed25519 announcement doesn't mention FIPS. — [AWS What's New](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/)

### Inferences
- For a Stellar facilitator, FIPS is unlikely to be a hard requirement. If it ever is, ask AWS (Artifact or support) whether a newer HSM certificate covers FIPS 186-5 EdDSA. #4884 sunsets next month, so a successor certificate is likely in process.

### Gaps
- The rest of the security policy (after 100k characters) wasn't read. No 2026 successor certificate was found.

## 8. Overall pros and cons for a Hetzner-hosted Stellar facilitator

### Takeaway
KMS works for this: native pure Ed25519, a 4 KB message limit, raw 64-byte output that the Solana ecosystem has already shown works, documented PKCS#8 import, quota far above our needs, and costs of a few dollars to low hundreds per month. What it costs us: a cross-cloud network dependency on the settlement hot path (an estimated 10–30 ms per signature, unmeasured), an AWS identity bootstrap on Hetzner (Roles Anywhere + TPM is the cleanest), and no control over what gets signed. A compromised host can still sign arbitrary transactions while it holds credentials. KMS limits that to signing while compromised, with an audit trail, and the key itself can't be stolen.

### Cited Findings
- See sections 1–7 for sources. Main ones: [key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html), [Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html), [quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html), [pricing](https://aws.amazon.com/kms/pricing/), [import requirements](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-conceptual.html), [Roles Anywhere credential helper](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/credential-helper.html), [Solana KMS signer](https://cdn.jsdelivr.net/npm/@solana/keychain-aws-kms@1.4.0/dist/aws-kms-signer.js).

### Inferences
- **Pros**: the key can't be extracted (in KMS-generated mode); HSM-backed at FIPS 140-3 L3 hardware, though Ed25519 isn't shown in the boundary; every Sign is logged with source IP; revoking access is instant (disable the key or change the policy); a multi-Region replica keeps the same G-address; scaling headroom of 1,000 rps that can be raised; low cost; plugs into the existing `signTransaction(xdr)` interface.
- **Cons**: an extra failure domain (AWS Region + STS + internet path) on every settlement, so a KMS outage halts settlement unless there's multi-Region failover; per-signature WAN latency; data/egress paths cross providers; AWS account security becomes part of the facilitator's trust base; the hash is opaque to policy (no amount or destination limits without a proxy); Ed25519 has no FIPS validation evidence yet; Roles Anywhere adds PKI work (CA, CRL import, cert rotation).
- **Mitigations to consider**: a dedicated AWS account; key policy pinned to algorithm, message type, source IP and cert CN; separate admin principal with MFA; a multi-Region replica with client failover; local verify of every signature; keep the facilitator's XLM balance low and top it up from a cold account, which caps the loss from a compromised host better than any KMS policy can.

### Gaps
- Needed before deciding: (1) a testnet end-to-end run (create or import key → sign a fee bump → submit); (2) Sign latency p50/p99 from FSN/NBG to eu-central-1; (3) a check that Ed25519 PKCS#8 import of an existing Stellar seed gives the same G-address.
