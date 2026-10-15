# Self-hosted Ed25519 signer key custody on Hetzner (as of 2026-10-15)

Scope: production operation and security of a self-hosted signer for one Ed25519 Stellar hot key per network (pure Ed25519 over a 32-byte tx hash, peak ~100 signatures / 5 s = ~20 sig/s). The spike already proved Vault 2.1.2 and OpenBao 2.7.1 Transit `ed25519` produce Stellar-valid signatures, BYOK import, non-exportability, ~6 ms/sign on localhost; none of that is re-verified here. No OpenZeppelin material was used.

Research budget note: ~18 tool calls. Several items below come from secondary sources or from prior knowledge and are flagged **[unverified]**; treat them as leads, not facts.

## OpenBao vs HashiCorp Vault for production Transit signing

### Takeaway
OpenBao is the better fit for a small team: MPL-2.0, a monthly-ish cadence with frequent security releases, and in 2.7 it moved most KMS seals out to plugins while keeping a built-in **static** seal and Transit seal, and added Transit "external key material" (HSM-backed keys). Vault Community is still BSL 1.1 (licensor now IBM); internal production use is allowed, but PKCS#11/HSM seal is Enterprise-only. Both have had a steady stream of auth/audit advisories in 2025–2026; no 2024–2026 advisory specific to Transit signing was found.

### Cited Findings
**Releases / cadence**
- OpenBao v2.7.0 shipped 2026-09-23 (beta 2026-09-09); v2.7.1 followed 2026-10-01 — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)
- 2.7.1 fixed 6 advisories (incl. AppRole secret IDs still usable after expiry before tidy; Kubernetes SA JWTs not revalidated on renewal; cert auth quota calculation; disclosure of `tls_acme_eab_mac_key`); 2.7.0 fixed 9 advisories (plugin path/catalog restrictions, policy template and cache handling, cross-namespace policy resolution, audit log leakage, PKI ACME SAN validation, OIDC `prompt=none` redirect, agent/proxy quit endpoint). Notes identify them by GHSA ID, not CVE — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)
- 2.7.0 removed Kerberos, LDAP, RADIUS auth and LDAP secrets from the core binary (now in openbao-plugins); removed the `file` storage backend in favor of PebbleDB (file deprecated for `bao operator migrate`, removed in 2.8.0) — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)
- 2.7.0 Transit: ML-DSA (FIPS 204) keys; and **external key material**, "so Transit can sign, verify, encrypt, and decrypt with keys held in KMS or HSM-backed providers" — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)
- 2.7 Raft fixes: auto-create storage dir, check node exists before promote/demote, batch-apply perf regression fix, unbounded Raft log growth fix after restart; 2.7.1 fixes `auto_join` when discovered addresses include ports — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)

**OpenBao advisories 2025–2026 (via third-party trackers; GitHub advisories page not fetched)**
- CVE-2025-62513 / GHSA-ghfh-fmx4-26h8: audit logs failed to redact some raw HTTP bodies (ACME challenge codes, OIDC token/claim data), 2.2.0–2.4.1, fixed 2.4.2 — [Tenable](https://www.tenable.com/plugins/container-security/435735)
- CVE-2025-62705 / GHSA-rc54-2g2c-g36g: byte-slice fields leaked into audit logs (Go vulndb, unreviewed) — [cvefeed](https://cvefeed.io/vuln/detail/CVE-2025-62513); [Go vulndb](https://go.googlesource.com/vulndb/+/7336c194943cd5efe8930f0ce768c503ce34d328/data/reports/GO-2025-4052.yaml)
- CVE-2026-33757 / GHSA-7q7g-x6vg-xpc3: JWT/OIDC `callback_mode=direct` login without user confirmation (phishing), fixed 2.5.2 — [Tenable](https://www.tenable.com/plugins/container-security/439318)
- CVE-2026-33758 / GHSA-cpj3-3r2f-xj59: reflected XSS on OIDC error page exposing Web UI token, CVSS v4 9.4, fixed 2.5.2 — [Tenable](https://www.tenable.com/plugins/cloud-security/439337)
- CVE-2026-39396 / GHSA-r65v-xgwc-g56j: OCI plugin downloader decompression bomb (no size limit, SHA256 checked after write), fixed 2.5.3 — [Tenable](https://www.tenable.com/plugins/cloud-security/440688)

**Vault advisories 2025**
- HCSEC-2025-22 (2025-08-06): multiple vulns mostly in auth flows (LDAP MFA bypass, TOTP code reuse, userpass lockout bypass…), fixed in 1.20.2 / 1.19.8 / 1.18.13 / 1.16.24 — [HashiCorp Discuss](https://discuss.hashicorp.com/t/hcsec-2025-22-multiple-vulnerabilities-impacting-hashicorp-vault-and-vault-enterprise/76096)
- HCSEC-2025-24 / CVE-2025-6203 (2025-08-28): DoS via complex JSON payloads, fixed CE 1.21.0 — [HashiCorp Discuss](https://discuss.hashicorp.com/t/hcsec-2025-24-vault-denial-of-service-though-complex-json-payloads/76393)
- CVE-2025-6000 (2025): HashiCorp product security advisory (reported as code execution via plugin catalog by privileged operator **[details unverified]**) — [AhnLab ASEC](https://asec.ahnlab.com/en/89502/)
- Last Transit-specific advisory found: CVE-2023-4680 (arbitrary nonces with convergent encryption disabled, fixed 1.14.3) — encryption, not signing — [GitLab advisory DB](https://advisories.gitlab.com/pkg/golang/github.com/hashicorp/vault/CVE-2023-4680/)

**Licensing**
- Vault CE remains BSL 1.1 in 2026; Additional Use Grant permits production use except offering it to third parties hosted/embedded in competition with the licensor's paid versions; licensor in the LICENSE text is now International Business Machines Corporation; each release converts to MPL 2.0 after four years; no reversal as of April 2026 — [jorijn.com](https://jorijn.com/en/blog/hashicorp-vault-vs-openbao/); [Infisical](https://infisical.com/blog/hashicorp-new-bsl-license) (secondary; LICENSE file not fetched)
- OpenBao is MPL-2.0 under the Linux Foundation (OpenSSF) — **[from prior knowledge; not re-fetched]**

**HA / storage / auth / audit / policy**
- Hetzner Cloud spread placement groups: each server on different physical hardware; max 10 servers per group; free; 50 per project; 1 group per server — [Hetzner Docs](https://docs.hetzner.com/cloud/placement-groups/overview)
- (Prior knowledge, **[unverified this session]**) Placement groups are per location; to spread across locations (FSN1, NBG1, HEL1) use one private network in network zone `eu-central`, which spans those three locations; Raft is latency-sensitive but intra-EU-central latency (single-digit ms) is acceptable.
- (Prior knowledge, **[unverified this session]**) Both products: integrated storage Raft with `bao/vault operator raft snapshot save|restore`; audit devices `file`, `syslog`, `socket`; auth methods AppRole, TLS `cert`, JWT/OIDC, Kubernetes. A minimal policy: `path "transit/sign/stellar-pubnet" { capabilities = ["update"] }` plus nothing else (no `transit/keys/*`, no `transit/export/*`). Vault CE automated snapshots are Enterprise-only; OpenBao/Vault CE need a cron/systemd timer calling `snapshot save` — **[unverified]**.

### Inferences
- For our use (internal, not a hosted secrets service), Vault CE's BSL is legally usable, but OpenBao avoids licence risk entirely and is what we would ship in an Apache-2.0 monorepo's deploy docs.
- The 2025–2026 advisory stream is dominated by auth (OIDC, AppRole, K8s, LDAP) and audit-log leakage. Choosing the smallest auth surface (TLS cert auth or AppRole with short-lived, CIDR-bound secret IDs) and not enabling UI/OIDC directly reduces exposure. Patch cadence must be monthly — budget for it.
- OpenBao 2.7 "external key material" in Transit is the most interesting new path: Transit as the API/policy/audit front, key in an HSM. Ed25519 support through that path is **not confirmed** — needs a spike.
- With Raft, 3 nodes tolerate 1 failure; 2 nodes is worse than 1 (no quorum on one loss). A 1-node deployment plus frequent encrypted snapshots is a legitimate small-team choice if a short signing outage is acceptable.

### Gaps
- Exact Vault CE latest version/cadence in Oct 2026 (spike used 2.1.2) and any Vault 2.x Transit/auth advisories in 2026 — HCSEC list after 2025-24 not checked.
- Full OpenBao GHSA list (github.com/openbao/openbao/security/advisories) not fetched directly.
- Whether OpenBao Transit external key material supports Ed25519 via PKCS#11.

## Unseal / root of trust without a cloud KMS

### Takeaway
Options in increasing automation: Shamir (default; every restart needs humans), OpenBao **static seal** (key from file/env — automation but the unseal key lives on the host), **transit auto-unseal** from a second small OpenBao (moves the problem one hop), PKCS#11 seal (OpenBao: external plugin since 2.7.0; Vault: Enterprise only), or AWS/GCP KMS auto-unseal (now also plugins in OpenBao 2.7). For a small team on Hetzner, Shamir on a 3-node cluster (rolling restarts keep quorum) or transit auto-unseal from a hardened unsealer node is the pragmatic sweet spot.

### Cited Findings
- If no seal is configured OpenBao defaults to Shamir, "requiring manual unsealing of nodes" — [OpenBao seal docs](https://openbao.org/docs/configuration/seal/)
- Seal types listed: AliCloud KMS, AWS KMS, Azure Key Vault, GCP Cloud KMS, KMIP, OCI KMS, OVHcloud KMS, PKCS#11, Static Key, T Cloud Public KMS, OpenBao Transit — [OpenBao seal docs](https://openbao.org/docs/configuration/seal/)
- In 2.7.0 the `pkcs11`, `alicloudkms`, `awskms`, `azurekeyvault`, `gcpckms`, `ocikms` seals "are no longer built-in and must be installed as external plugins"; HSM distribution discontinued; "PKCS#11 functionality remains available via the PKCS#11 KMS plugin" — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)
- PKCS#11 seal: built-in in 2.6.x, plugin-only from 2.7.0; config via `plugin "kms" "pkcs11" { command = "openbao-plugin-kms-pkcs11" }` + `seal "pkcs11"`; a plugin shadows a built-in seal of the same name; OpenBao does not create HSM key material — it must exist before init — [OpenBao PKCS#11 seal docs](https://openbao.org/docs/configuration/seal/pkcs11/)
- 2.7.0 added options to disable Auto Seal health checks and tune their interval/timeout — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)
- Static seal: built-in, 32-byte AES-256-GCM-96 key supplied in config, `env://` or `file://`; docs warn "Carefully evaluate use of Static Key Auto Unseal to see if its use meets the desired security properties" and "It is imperative that any key material be injected properly"; recommended when an existing trust source (e.g. a third-party secrets manager) already exists to chain to; supports rotation with `previous_key`/`current_key` — [OpenBao static seal docs](https://openbao.org/docs/configuration/seal/static/)
- Vault: PKCS#11 auto-unseal and seal wrap require Vault Enterprise (HashiCorp tutorial says Enterprise Plus; Futurex says Governance & Policy module — sources disagree on tier); needs the `+ent+hsm` build — [Vault PKCS#11 seal docs](https://www.vaultproject.io/docs/configuration/seal/pkcs11); [HashiCorp seal-wrap tutorial](https://developer.hashicorp.com/vault/tutorials/enterprise/seal-wrap); [Futurex](https://docs.futurex.com/hsm-integration-guides/acoZ-configure-the-futurex-pkcs-11-library-with-hashicorp-vault)
- Third-party HSM vendor docs cover OpenBao PKCS#11 auto-unseal (Securosys) — [Securosys](https://docs.securosys.com/openbao/auto-unseal/installation_pkcs11)

### Inferences
- **Shamir**: strongest at-rest property (no unseal secret on any server), but a single-node reboot (kernel patch, Hetzner host maintenance) = signing outage until a key holder unseals. With 3 Raft nodes, rolling one node at a time keeps quorum and signing up; only a full-cluster outage needs a human. Acceptable for a small team if someone is on call.
- **Static seal** with `file://` on the same disk as the Raft data gives availability but protects only against theft of a Raft snapshot/backup alone, not against host disk compromise. Combining it with `systemd-creds` sealed to the host TPM (dedicated servers only) gives "disk theft" protection; it does not help against root on a running host.
- **Transit auto-unseal** from a separate small OpenBao (Shamir-sealed, firewall-restricted to the cluster IPs) is the usual self-hosted pattern: the main cluster restarts unattended; the unsealer is rarely restarted. Its outage blocks only restarts, not running signing.
- **AWS/GCP KMS** auto-unseal from Hetzner works (plugin in OpenBao 2.7) but adds a US-hyperscaler dependency and cloud IAM credentials stored on the Hetzner host — the credential is then the effective unseal secret. Availability risk: KMS/Internet outage blocks restarts only.
- **PKCS#11 seal with a YubiHSM 2 / Nitrokey** as seal-only device is plausible on a dedicated server *if* a USB device can be attached (see hardware gaps).

### Gaps
- Whether static seal is new in 2.7 or earlier — docs page does not say.
- Whether OpenBao supports multiple seals / seal HA (Vault Enterprise "seal HA") — not found.

## Hardware: HSM, TPM at Hetzner

### Takeaway
YubiHSM 2 supports Ed25519 but is far too slow as the live signer (~105 ms per 32-byte sign ⇒ ~9–10 sig/s per device vs ~20 sig/s peak); it is suitable as a **seal/backup root** only. Nitrokey NetHSM claims ~3,720 Ed25519 sig/s (network appliance) and could be the signer, but needs rack space (colocation) whose availability at Hetzner is uncertain. Nitrokey HSM 2 (USB token) does not do Ed25519. TPM 2.0: EdDSA exists in the TCG algorithm registry, but no evidence of shipping TPMs implementing it — do not plan on TPM signing; use TPM only to seal secrets on dedicated servers. No evidence Hetzner offers USB passthrough, vTPM or HSM services.

### Cited Findings
- YubiHSM 2 average EdDSA-25519 sign times on idle device: ~105 ms (32 B), 121 ms (64 B), 137 ms (128 B), 168 ms (256 B), 229 ms (512 B), 353 ms (1024 B); vendor says performance varies — [YubiHSM 2 Device Specs](https://docs.yubico.com/hardware/yubihsm-2/hsm-2-user-guide/hsm2-device-specs.html); [archived Product Overview](https://developers.yubico.com/Archive_Old_Dev_Docs/YubiHSM2/Product_Overview)
- YubiHSM 2 EdDSA is Ed25519 only — [YubiHSM 2 Technical Data Sheet](https://docs.yubico.com/hardware/yubihsm-2/datasheet/_static/YubiHSM_2_Technical_Data_Sheet.pdf)
- YubiHSM reached via `yubihsm-connector` over HTTP or directly over USB — [yubihsm.rs](https://docs.rs/yubihsm)
- Nitrokey NetHSM: ~3,720 Ed25519 signatures/s, measured end-to-end incl. network RTT with several parallel persistent connections (NetHSM 2 spec); an older factsheet lists much lower numbers (P-256 ~870/s vs 3,640/s), so figures vary by hardware generation — [Nitrokey NetHSM page](https://www.nitrokey.com/node/414); [NetHSM factsheet](https://www.nitrokey.com/files/doc/Nitrokey_NetHSM_factsheet.pdf)
- Nitrokey HSM (USB token) does not support Ed25519 — [Nitrokey support forum](https://support.nitrokey.com/t/is-it-possible-to-use-the-nitrokey-hsm-to-create-ed25519-signatures/181)
- Hetzner Robot features (rescue, OS install, KVM/VNC, WoL) — no USB passthrough/HSM add-on listed; add-on price list covers network items — [Hetzner Robot overview](https://docs.hetzner.com/robot/general/overview); [Hetzner add-on price list](https://docs.hetzner.com/robot/general/pricing/price-list-for-additional-products)
- Hetzner colocation lets customers house their own hardware (Nuremberg, Falkenstein, Helsinki racks) — [Hetzner colocation](https://www.hetzner.com/colocation?country=at); but a German page says no colocation space can be provided "until further notice" due to demand (undated) — [Hetzner colocation DE](https://www.hetzner.com/de/colocation/?country=no) — conflicting
- TCG Algorithm Registry added Curve25519 params (rev 1.29, 2020), a TPM_ALG_EDDSA note (1.30), EDDSA_PH and Curve448 (1.33, 2023) — [TCG Algorithm Registry 1.34](https://trustedcomputinggroup.org/wp-content/uploads/TCG-Algorithm-Registry-Revision-1.34_pub-1.pdf)
- TPM 2.0 Library 1.83 (March 2024) release notes list SVN/firmware hierarchies, ECC Encrypt/Decrypt etc.; EdDSA not mentioned — [TCG TPM releases](https://github.com/TrustedComputingGroup/TPM/releases)
- 2019 WebAuthn discussion: TPMs did not support EdDSA then — [W3C public-webauthn](https://lists.w3.org/Archives/Public/public-webauthn/2019Feb/0028.html)

### Inferences
- Throughput math: 20 sig/s peak ÷ ~9.5 sig/s per YubiHSM ⇒ ≥3 devices in parallel with zero headroom, plus USB-at-Hetzner uncertainty ⇒ reject YubiHSM as signer; consider as PKCS#11 seal device or offline backup of the seed (wrap-export).
- NetHSM throughput is ample (~180× peak), and OpenBao 2.7 Transit external key material could front it — but requires colocation (or an on-prem box with a link to Hetzner, adding latency and a WAN dependency). High cost/effort for a small team.
- TPM is useful only as a sealing root (systemd-creds, LUKS) on dedicated servers, not for Ed25519 signing.

### Gaps
- Whether Hetzner will plug a customer-supplied USB device into a dedicated server (needs a Hetzner support ticket). Not documented.
- Current Hetzner colocation availability (pages conflict).
- NetHSM and YubiHSM 2 current prices (not fetched).
- Whether any shipping TPM (Infineon, Nuvoton, STM, AMD fTPM, Intel PTT) implements TPM_ALG_EDDSA — check with `tpm2_getcap algorithms` on target hardware.
- Whether Hetzner dedicated servers (AX/EX lines) expose an enabled TPM 2.0 (likely AMD fTPM on AX; **unverified**).

## Confidential computing on Hetzner

### Takeaway
No Hetzner documentation for AMD SEV-SNP, Intel TDX, or vTPM on Hetzner Cloud was found; a community comment says Hetzner Cloud VMs have no TPM and no Secure Boot. On dedicated servers you control the BIOS, so SEV-SNP hosting is theoretically possible on EPYC hardware, but attestation chains and tooling are DIY.

### Cited Findings
- HN commenter: Hetzner does not provide a TPM for VMs, mentions no data-in-use encryption, and does not support UEFI Secure Boot (user comment, unverified) — [Hacker News](https://news.ycombinator.com/threads?id=Qasaur)
- SEV-SNP adds hardware protection against malicious hypervisor attacks (replay, remapping) — [Google Cloud Confidential VM](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/confidential-vm-overview?hl=ja)
- SEV-SNP alone doesn't guarantee untampered boot/config; vTPM provides measured boot/attestation — [arXiv 2303.16463](https://arxiv.org/html/2303.16463v2)

### Inferences
- Confidential computing is not a realistic option on Hetzner Cloud today; on dedicated it is a research project, not an ops pattern for a small team.

### Gaps
- Official Hetzner statement on SEV-SNP/TDX/vTPM/Secure Boot (none found in docs/changelog search).
- Whether Hetzner AX servers with EPYC CPUs have SEV-SNP enabled in BIOS.

## Baseline "secret on host" hardening

### Takeaway
SOPS+age, systemd-creds and Docker/Podman secrets all protect the key **at rest** (git repo, disk image, backups, `docker inspect`/env leakage) but none protects against root or code execution in the app process, because the plaintext seed is in process memory at signing time. They are a cheap improvement over a plain env var, not a substitute for separating the signer.

### Cited Findings
- No sources fetched this session for SOPS, systemd-creds or Docker secrets — the points below are from prior knowledge **[unverified this session]**:
  - SOPS+age: encrypts the secret in git/CI; decrypted at deploy; the age private key on the host becomes the secret to protect.
  - systemd-creds (`systemd-creds encrypt --with-key=tpm2` / `LoadCredentialEncrypted=`): credential is encrypted to the host TPM (+ optional host key), decrypted only for that unit into a non-swappable ramfs under `$CREDENTIALS_DIRECTORY`; protects against disk theft/copied images; needs a TPM, i.e. Hetzner dedicated, not Cloud (per the HN claim above).
  - Docker/Podman secrets: mounted as files under `/run/secrets` (tmpfs), not visible in `docker inspect` env, unlike env vars; Docker secrets in plain Compose are just bind-mounted files (encryption at rest only in Swarm).
  - Env vars leak via `/proc/<pid>/environ`, crash dumps, child processes, debug endpoints and error reporters.

### Inferences
- Minimal hardening even with OpenBao: OpenBao's own credentials (AppRole secret ID / client cert key) on the app host should use the same mechanisms — the app host still holds a credential that can *request* signatures, just not the seed.

### Gaps
- Sources for systemd-creds, SOPS and Docker secrets behaviour not fetched (time budget).

## Memory safety and separation from the app host

### Takeaway
Moving signing to OpenBao Transit on a separate server converts "app compromise ⇒ seed stolen" into "app compromise ⇒ attacker can request signatures while they hold access", which is auditable and revocable. Compromise of the OpenBao host itself (root on the unsealed node) still exposes the key in memory, as Transit keys are decrypted in process memory when unsealed.

### Cited Findings
- Spike (internal, given in brief): non-exportable Transit keys refuse export.
- Vault/OpenBao Transit key material lives in the barrier-encrypted storage and is held decrypted in memory on an unsealed node **[prior knowledge; not re-sourced]**.
- OpenBao 2.7 Transit external key material could keep the key in an HSM so even OpenBao memory does not hold it — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/) (Ed25519 support unconfirmed)

### Inferences
- Threat ladder: (1) env var in app — any RCE/SSRF-to-env/log leak = key gone forever, rotate Stellar signer; (2) OpenBao on same host — little gain vs root, some gain vs app-level bugs; (3) OpenBao on separate Hetzner server, private network only, firewall to app IPs, cert/AppRole auth, sign-only policy, audit log shipped off-host — app RCE = signing oracle, not key theft; (4) key in HSM — even OpenBao root cannot exfiltrate.
- Because a Stellar signer can be rotated on-chain (account signer weights), stage (3) plus a rotation runbook bounds the damage meaningfully.
- Add an app-independent rate limit/alert on the audit log (e.g. signs/minute vs settlements) to detect oracle abuse.

### Gaps
- None verified about memory locking (`mlock`, `disable_mlock` default with Raft) in OpenBao 2.7 — check docs.

## Estimated monthly cost on Hetzner (1-node and 3-node)

### Takeaway
After the 2026-04-01 (~30–37%, all customers) and 2026-06-15 (new orders/rescales; CPX/CCX +113–176%) price changes, shared-vCPU CX/CAX remain cheap: roughly €5.5–6/node ⇒ **~€6–8/month for 1 node** and **~€17–20/month for 3 nodes** (plus optional backups/IPv4). Dedicated-vCPU CCX13 at €42.99/node ⇒ ~€129/month for 3 nodes. CX/CAX availability was reported constrained in August 2026.

### Cited Findings
- New prices from 2026-06-15 08:00 CEST (EUR/month, excl. IPv4, DE/FI): CX23 3.99→5.49; CX53 22.49→29.49; CAX11 4.49→5.99; CAX41 31.49→40.99; CPX22 7.99→19.49; CPX42 25.49→69.49; CCX13 15.99→42.99; CCX23 31.49→85.99; applies to new orders and rescales; existing instances keep price; resize reprices — [privatedevops](https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do)
- Hetzner changelog: updated pricing applies to new orders and rescales from 15 June 2026; existing servers unaffected unless rescaled — [Hetzner Cloud What's New](https://docs.hetzner.cloud/whats-new) (via search summary)
- Earlier 2026-04-01 adjustment of up to ~37% also hit existing customers — [wz-it](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/); [findstack](https://findstack.com/resources/hetzner-price-increase-2026)
- Cost-Optimized CX/CAX lines shown "Currently not available" on Hetzner's cloud page by mid-August 2026 — [findstack](https://findstack.com/resources/hetzner-price-increase-2026) (secondary)
- Placement groups free — [Hetzner Docs](https://docs.hetzner.com/cloud/placement-groups/overview)

### Inferences
- 1 node: CX23 €5.49 (+ backups ~20% ≈ €1.10 **[backup % unverified]**, + IPv4 if needed, can be avoided with private network + NAT/bastion) ≈ **€6–7**.
- 3 nodes: 3× CX23 ≈ €16.47; 3× CAX11 ≈ €17.97; plus backups ≈ **€17–22**. Raft snapshots to Hetzner Object Storage add ~€5 base **[unverified price]**.
- Transit-unsealer node: +1× CX23 ≈ €5.5.
- If CX/CAX unavailable in a location, fallback CPX22 at €19.49 ⇒ 3 nodes ≈ €58.
- 20 sig/s at ~ms each is trivial load; the smallest shared vCPU plan suffices; dedicated vCPU (CCX) buys noisy-neighbour isolation, not needed capacity.
- Dedicated server (e.g. AX line, for TPM/USB) prices not fetched — likely ≥ €40/month each **[unverified]**.

### Gaps
- Official Hetzner price page not fetched directly; CX33/CAX21/CPX12/CPX32 new prices, IPv4 price post-April, backup %, Object Storage price, dedicated AX prices unknown.

## Pros/cons and operating burden for a small team

### Takeaway
Ranked for a ~4-dev team: (A) 3-node OpenBao Raft on CX/CAX across FSN/NBG/HEL, Shamir or transit auto-unseal, cert/AppRole auth, sign-only policy — best security/effort ratio (~€20–25/month, monthly patching, snapshot cron, on-call unseal). (B) 1-node OpenBao + static seal via systemd-creds (dedicated) or Shamir — cheapest, outage on every reboot/failure. (C) HSM-backed (NetHSM in colocation) — strongest, but hardware, colocation uncertainty and Ed25519-via-external-key path unverified. (D) Hardened env-var/systemd-creds only — no separation; acceptable only for testnet.

### Cited Findings
- OpenBao ships frequent security releases (15 advisories across 2.7.0/2.7.1 within ~1 week) — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)
- 2.7 moved seals and some auth engines to plugins — extra artifacts to install/upgrade — [OpenBao 2.7 release notes](https://openbao.org/community/release-notes/2-7-0/)
- Vault HSM features gated to Enterprise (Plus) — [HashiCorp seal-wrap tutorial](https://developer.hashicorp.com/vault/tutorials/enterprise/seal-wrap)

### Inferences
- Operating tasks: patching monthly (both have frequent auth advisories), unseal runbook with ≥3 key holders (e.g. 3-of-5 Shamir / recovery keys), snapshot backups encrypted off-site and a tested restore, audit log shipping, TLS cert rotation (internal CA, or OpenBao PKI), Raft member replacement runbook, OpenBao upgrade path with plugin-seal changes (2.6→2.7).
- Latency: ~6 ms localhost + private-network RTT (sub-ms in same location, few ms cross-location) is negligible for settlement; a connection pool/keep-alive client matters more than node size.
- Failure modes: lose quorum ⇒ no signing ⇒ facilitator `/settle` down; therefore the signing client should have a timeout and clear 503, and nodes should be spread over 3 locations (one network zone).
- Vault vs OpenBao operationally near-identical; choose OpenBao for licence and because static seal / PKCS#11 plugin are available without Enterprise.

### Gaps
- No public post-mortems/benchmarks of Raft clusters spanning FSN/NBG/HEL found (not searched in depth).
