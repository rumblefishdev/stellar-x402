---
title: "Backing up the static seal key: what the sources say, and who holds it"
type: research
status: mature
spawned_from: S-key-custody-decisions.md
spawns: []
tags: [keys, custody, openbao, unseal, backup, recovery, systemd]
links:
  - S-key-custody-decisions.md
  - R-key-leak-impact.md
  - R-openbao-on-hetzner.md
  - ../../../../../docs/adr/0013-facilitator-key-custody.md
history:
  - date: "2026-10-20"
    status: developing
    who: okarcz
    note: >
      Answers ADR 0013's open question "who holds the unseal key backup, and where" from OpenBao,
      Vault, systemd, NIST and OWASP sources. Recommends a restricted password-manager vault held
      by two people, plus the recovery key shares and the Borg passphrase, tested by a restore.
  - date: "2026-10-20"
    status: mature
    who: okarcz
    note: >
      Decided: the backup set goes into AWS Secrets Manager in the account soroban-explorer and
      prices-api share, instead of a password manager (S-key-custody-decisions, B1–B13).
---

# Backing up the static seal key

> **Decided 2026-10-20** ([S-key-custody-decisions, B1–B13](S-key-custody-decisions.md#the-unseal-backup-set)):
> okarcz chose **AWS Secrets Manager** in the AWS account soroban-explorer and prices-api share
> (`x402/production/openbao-backup`), readable by that account's admins, instead of the password
> manager recommended below. The four-item backup set, the recovery-key finding, one recovery share
> and the restore drill are kept. ADR 0013 records it.

## Question

[ADR 0013](../../../../../docs/adr/0013-facilitator-key-custody.md) unseals OpenBao with a static
seal key, passed in as a `host`-mode systemd credential. Raft snapshots go daily to the Storage
Box. If the server is lost, we need a snapshot and an off-server copy of the seal key. Without
both, the fee account and every channel are lost. Who holds that copy, and where?

## Short answer

- **Back up four things, not one:** the seal key with its key ID, the recovery key shares, the
  Borg passphrase (and key), and the OpenBao config. A restore on a new server needs all of them
  (see [What a restore needs](#what-a-restore-needs)).
- **Keep them in a restricted vault in the company password manager, shared by two people**
  (Payments and Platform), one entry per network. Never on the server, the Storage Box or in git.
- **Add a sealed paper copy in a safe for mainnet,** if the company has a safe. It covers losing
  the password manager account.
- **Test it by a restore** on a throwaway machine before mainnet, then every quarter and after any
  change of key, holder or OpenBao version.
- **One finding for the ADR:** with a static seal, a root token is regenerated with the
  **recovery keys**, not the seal key. ADR 0013 says "regenerated with the unseal key".

## What OpenBao says about the seal key

- **The seal key is the only way back.** "If the seal mechanism or its keys are permanently
  deleted, then the OpenBao cluster cannot be recovered, even from backups"
  ([OpenBao seal concepts](https://openbao.org/docs/concepts/seal/#auto-unseal)). OpenBao asks for
  "careful controls around management of the seal mechanism" (same page).
- **The key is 32 random bytes,** an AES-256-GCM-96 key, given raw, hex or base64, from a file or
  an env variable. The docs make one with `openssl rand -out … 32`
  ([static seal](https://openbao.org/docs/configuration/seal/static/)).
- **The key ID matters as much as the key.** `current_key_id` is the "permanent identifier of the
  key", and "the key identifier MUST always match the underlying key"
  ([static seal](https://openbao.org/docs/configuration/seal/static/)). The code enforces it: the
  static wrapper decrypts only data whose stored key ID equals `current_key_id` or
  `previous_key_id`, and otherwise fails with `unknown key id for data`
  ([go-kms-wrapping `static.go`, `Decrypt`](https://github.com/openbao/go-kms-wrapping/blob/main/wrappers/static/static.go)).
  So the backup must hold the key ID string exactly as configured.
- **OpenBao warns about this seal.** It is "only recommended when an existing source of trust,
  such as another third-party secrets manager, already exists", and "it is imperative that any key
  material be injected properly" ([static seal](https://openbao.org/docs/configuration/seal/static/)).
  The [static seal RFC](https://openbao.org/community/rfcs/static-auto-unseal/) adds that a static key,
  unlike KMS credentials, can't be revoked, and that KMS or HSM seals stay the preferred choice.
  Our systemd credential is that "source of trust" on the server; the backup copy is a second one
  off it.
- **Rotation keeps one old key.** `previous_key` and `previous_key_id` allow `n-1` to `n` rotation
  ([static seal](https://openbao.org/docs/configuration/seal/static/)). A snapshot taken before a
  rotation still needs the old key, so the backup keeps old keys until the last such snapshot ages
  out (14 days with our Borg retention).

## Recovery keys: what they are, and why we need them

- **Auto-unseal gives recovery keys at init, not unseal keys.** They come from "an internal
  recovery key that is split via Shamir's Secret Sharing" ([seal concepts: Recovery
  key](https://openbao.org/docs/concepts/seal/#recovery-key)). Static is an auto-unseal seal.
- **They can't unseal.** "Recovery keys cannot decrypt the root key, and thus are not sufficient
  to unseal OpenBao if the Auto Unseal mechanism isn't working. They are purely an authorization
  mechanism" ([seal concepts](https://openbao.org/docs/concepts/seal/#auto-unseal)). They also
  can't open a snapshot: that takes the seal key.
- **They are what regenerates a root token.** Quorum operations "require _recovery keys_" under
  auto-unseal, and for `generate-root` "selection of the recovery keys … is automatic"
  ([seal concepts](https://openbao.org/docs/concepts/seal/)). ADR 0013 revokes the root token
  after setup, so the recovery keys are our only admin path. They also authorize rotating the
  root key and the recovery key itself (same page).
- **Defaults and options.** `bao operator init` makes 5 recovery shares with a threshold of 3 by
  default; `-recovery-shares`, `-recovery-threshold` and `-recovery-pgp-keys` change that
  ([operator init](https://openbao.org/docs/commands/operator/init/)). They can be delayed with
  `recovery_shares=0`, but then need a root token later: "Just don't forget to generate them well
  before you need them!" ([seal concepts](https://openbao.org/docs/concepts/seal/#recovery-key)).
  The init page lists these flags for "HSM, KMS and Transit seals"; it doesn't name the static
  seal, which is also an auto-unseal seal (not checked by running it).
- **They matter for our restore.** The recovery key config lives in OpenBao's storage, so a
  snapshot brings back the old cluster's recovery keys and AppRole data. The AppRole role ID and
  secret ID came from the lost server's Compose secrets. To issue a new secret ID on the new server
  we need a token, so a root token, so the original recovery keys. Without them we could unseal
  and sign nothing new until we found another way in (an inference from the docs above, not tested).

## What a restore needs

- **A running, initialized cluster.** Vault's procedure: bring up new storage, re-initialize, and
  log in with the new root token, which "is temporary as you will overwrite the cluster state with
  the snapshot data" ([Vault: Restore a
  snapshot](https://developer.hashicorp.com/vault/docs/sysadmin/snapshots/restore)). OpenBao's
  restore is the same command, `bao operator raft snapshot restore`
  ([OpenBao operator raft](https://openbao.org/docs/commands/operator/raft/)).
- **The force flag skips the key check.** OpenBao's `snapshot-force` endpoint "bypasses checks
  ensuring the Autounseal or shamir keys are consistent with the snapshot data"
  ([OpenBao raft API](https://openbao.org/docs/api/system/storage/raft/)); the CLI has the same
  `-force` flag ([source](https://github.com/openbao/openbao/blob/main/internal/command/operator_raft_snapshot_restore.go)).
  Without it, a mismatch fails with "could not verify hash file, possibly the snapshot is using a
  different autoseal key"
  ([source](https://github.com/openbao/openbao/blob/main/internal/vault/logical_system_raft.go)).
  Vault's guide always uses `-force` for a snapshot from another cluster
  ([Vault: Restore a snapshot](https://developer.hashicorp.com/vault/docs/sysadmin/snapshots/restore)).
- **After the restore OpenBao reloads the root key through the seal.** If the snapshot's keyring
  differs, OpenBao with an auto seal "can try to use the seal to unseal again. If the auto-unseal
  mechanism has changed then there isn't anything we can do but seal"
  ([source, `raftSnapshotRestoreCallback`](https://github.com/openbao/openbao/blob/main/internal/vault/raft.go)).
  So the new server must run the **same seal key under the same key ID**. `-force` does not get
  round a wrong key.
- **The restore is asynchronous.** The command returns when the file is accepted; wait for
  "post-unseal setup complete" and "vault is unsealed" in the logs
  ([Vault operator raft](https://developer.hashicorp.com/vault/docs/commands/operator/raft)).
- **The snapshot itself is in Borg.** "In order to regain access to a repository, one needs both
  the exported key and the original passphrase." In keyfile mode the key lives on the backing-up
  machine and "needs to be backed up independently"; in repokey mode it is in the repository
  ([borg key export](https://borgbackup.readthedocs.io/en/stable/usage/key.html)). Either way the
  passphrase is lost with the server unless it is backed up.

So the off-server set is: the seal key, its key ID (and the previous pair after a rotation), the
recovery key shares, the Borg passphrase (plus `borg key export` output in keyfile mode), and the
`seal "static"` stanza with the OpenBao version.

## The systemd credential is not a backup

- **`host` mode ties the credential to the server's disk.** It is encrypted with "a secret key
  stored in the `/var/lib/systemd/credential.secret` file which is only accessible to the root
  user", and "decryption is possible with access to the host file system and sufficient
  privileges" ([systemd-creds(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)).
- **TPM mode ties it to the board.** `host+tpm2` "requires both access to the original TPM2 chip
  and the OS installation" (same page). systemd adds that encrypted credentials "can only be
  decrypted and validated on the local hardware and OS installation" and "cannot be prepared on a
  machine other than the local one" ([systemd: Credentials,
  Encryption](https://systemd.io/CREDENTIALS/#encryption)).
- **Neither page says how to back up or move them.** Copying `credential.secret` beside the `.cred`
  file would work in `host` mode, but that pair is the plaintext key in two parts, and it dies
  with the disk. The backup is the raw key; on a new server it is re-encrypted with that server's
  own host key (and, later, TPM).

## Distributing key material

- **Encrypt shares to their holders.** OpenBao and Vault can PGP-encrypt each share at init
  (`-recovery-pgp-keys`), so that only the matching private key reads it
  ([operator init](https://openbao.org/docs/commands/operator/init/);
  [Vault: PGP, GnuPG and Keybase](https://developer.hashicorp.com/vault/docs/concepts/pgp-gpg-keybase)).
  Vault's reason: one person seeing every key in plain text "defeats the promises of Vault's
  security model" (same page).
- **PGP has its own failure mode.** HashiCorp's validated design notes it "relies on their private
  key, which may not be well secured or reliably stored", and that a leaver's share "becomes
  inaccessible if it is PGP encrypted"
  ([HVD: Vault detailed design](https://developer.hashicorp.com/validated-designs/vault/installation-guide/vms/detailed-design)).
- **Several holders, and plan for people leaving.** Shares go to "a chosen set of trusted
  individuals"; the default is 5 shares, threshold 3 (same HVD page). The Well-Architected page
  warns that when holders leave "you risk not having the required key shares", and asks for a
  rekey workflow ([HashiCorp WAF: Vault recommended
  patterns](https://developer.hashicorp.com/well-architected-framework/operational-excellence/security-vault-anti-patterns)).
- **Keep backups away from the cluster.** Vault recommends "retaining cluster snapshots outside
  cluster storage or physical datacenters where clusters operate"
  ([Vault: snapshots](https://developer.hashicorp.com/vault/docs/sysadmin/snapshots)). No
  OpenBao or Vault page we found says in so many words "don't store the seal key with the
  snapshot"; that rule comes from the seal warning above plus NIST's separate locations below.

## NIST and OWASP on key backup

- **Back up keys that protect stored data.** NIST marks symmetric data-encryption and key-wrapping
  keys "OK" to back up (Table 7), and says a key-wrapping key that protects stored keys "should be
  backed up or archived for as long as the protected keying material may need to be accessed"
  ([SP 800-57 Pt 1 Rev 5](https://doi.org/10.6028/NIST.SP.800-57pt1r5), §8.2.2.1, B.3.5). The seal
  key is such a key-wrapping key. OWASP agrees: "Data that has been encrypted with lost
  cryptographic keys will never be recovered"
  ([OWASP Key Management Cheat Sheet: Escrow and
  Backup](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html#escrow-and-backup)).
- **Signing keys are the exception, and we are the exception to it.** NIST says private signature
  keys are not backed up "in general", unless they can't be replaced in time, as for a CA (Table 7,
  B.3.1.1). OWASP: "Never escrow keys used for performing digital signatures" (same cheat sheet).
  Our Transit key has no replacement path on chain (no cold key, ADR 0013), so its snapshot backup
  falls under NIST's exception. NIST then asks that a recovered signing key be "replaced as soon
  after the recovery process as possible" (B.3.1.1); for us that means moving the accounts to a
  fresh Transit key after any restore where the old server might be compromised.
- **Separate locations, checked copies.** Keep "one or more copies … in physically separate
  locations", and "the integrity of each copy should be periodically checked" (§6.2.2.1–6.2.2.2).
- **Confidentiality at rest: encryption, a FIPS module, or a safe.** Stored secret keys must be
  protected by encryption in a validated module, by such a module, or by "secure storage with
  controlled access (e.g., a safe or protected area)" (§6.2.2.3). OWASP: encrypt keys bound for
  offline storage with a key-encryption key at least as strong (cheat sheet, storage item 6).
- **Split knowledge is defined, not required here.** With split knowledge, "any k – 1 key shares
  provides no information about the key", and concatenating halves is not acceptable (§8.1.5.2.1,
  Glossary). NIST uses it for manual key distribution "so that no single individual can acquire
  access to all key shares" (§6.2.1.3). It doesn't require it for every backup.
- **Recovery is a policy decision, and all of it must come back.** "If the decision is made to
  provide key recovery, all information associated with that key shall also be recoverable"
  (§9.5). For us that is the key ID, the recovery shares and the Borg passphrase above.
- **Inventory without secrets.** A key inventory records owner, type and location, and "shall not
  include secret or private keys but shall include a reference to the key" (§9.2.1).
- **Accountability.** OWASP: the system "should account for all individuals who are able to view
  plaintext cryptographic keys" (cheat sheet, Accountability and Audit).

## Testing restores

- **HashiCorp asks for a written restore procedure and drills.** "You should establish standard
  operating procedures for restoring a Vault cluster from a snapshot", and without testing "your
  key stakeholders will not feel confident they can effectively perform the disaster recovery
  plan" ([WAF: Vault recommended
  patterns](https://developer.hashicorp.com/well-architected-framework/operational-excellence/security-vault-anti-patterns)).
- **Restore tests run isolated.** "Upgrade or restore tests should always be performed in a fully
  isolated network environment", so the test copy can't reach production
  ([Vault: Restore a snapshot](https://developer.hashicorp.com/vault/docs/sysadmin/snapshots/restore)).
- **Know your key holders.** The same guide's first prerequisite: "You must know, and be able to
  contact your unseal/recovery key holders."
- **NIST:** check each backup copy's integrity periodically (§6.2.2.2). No source gives a cadence.

## Options compared

Our constraint: the copy must survive the loss of the server **and** the Storage Box account, and
must not sit where the snapshots sit.

| Option | Survives server loss | Off the snapshot's location | Availability in an incident | Who can read it | Cost | Fit |
| ------ | -------------------- | --------------------------- | --------------------------- | --------------- | ---- | --- |
| **Password manager, restricted vault, 2 holders** | yes | yes | high: reachable from anywhere, by either holder | the 2 holders (+ PM admins, see below) | €0 if the company has one; ~€3–8 a user a month if not (unverified) | **best** |
| **Paper or USB in a safe** | yes | yes | low: someone must reach the safe | whoever opens the safe | €0 with an existing safe | good as a 2nd copy |
| **One person only** | yes | yes | one person away = no restore | 1 | €0 | poor: a single point of failure, which the WAF page warns about |
| **Shamir split of the seal key (e.g. 2-of-3)** | yes | yes | needs 2 people and a tool outside OpenBao (OpenBao only splits its own recovery and unseal keys) | no single person | €0, more drill effort | over-built at ~180 XLM; revisit with the upgrade path |
| **Another KMS / secret manager (AWS, GCP)** | yes | yes | high | cloud IAM | ~$1–12 a year, plus another account | rejected in ADR 0013 for bringing AWS back |

Notes:

- **The password manager's provider and admins** can, in principle, reach the vault. Most business
  password managers encrypt end to end, but we didn't check which one the company uses, or whether
  it has one (see Unverified).
- **Split knowledge doesn't buy much here.** Whoever holds the seal key and a snapshot can already
  decrypt OpenBao's data offline; the recovery keys only gate admin inside a running OpenBao. And
  root on the server can already read the key (ADR 0013 accepts it). Splitting the backup guards a
  path that is not the weakest one at these stakes.

## Recommendation

1. **Init with recovery keys we can use.** Per network: `bao operator init -recovery-shares=2
   -recovery-threshold=1`, so each holder alone can regenerate a root token. Optionally
   `-recovery-pgp-keys` with each holder's key, if both keep their PGP keys reliably (the HVD
   caveat above); otherwise plain shares, stored only in the password manager.
2. **One password manager entry per network**, e.g. "OpenBao seal – mainnet", in a vault shared
   by exactly two people: okarcz (Payments) and the Platform owner who runs OpenBao (0026). It
   holds:
   - the seal key in hex, and `current_key_id` exactly as in the config (and the previous pair
     until 14 days after a rotation);
   - the holder's recovery key share (or both shares);
   - the Borg passphrase for our sub-account, plus `borg key export` output if keyfile mode;
   - the `seal "static"` stanza and the OpenBao version;
   - a SHA-256 of the key, so a copy can be checked without showing it.
3. **Mainnet only: a sealed paper copy** of the same entry in the company safe, if there is one,
   with the date and both holders' signatures on the envelope. It covers a locked or lost password
   manager account. Testnet doesn't need it: losing testnet costs only a reset.
4. **Never** put any of it on the server, the Storage Box, in Borg, in git or in CI secrets.
5. **Inventory, not secrets, in the repo.** The 0026 runbook names the holders, the entry names
   and the key IDs, never the values (NIST §9.2.1).
6. **Restore drill.** Before mainnet (ADR 0013 already requires it), then quarterly, and after a
   seal key rotation, a holder change or an OpenBao upgrade:
   - on a throwaway machine with no route to production (a local Docker or a short-lived cloud VM);
   - pull the newest snapshot from Borg with the backed-up passphrase;
   - start OpenBao with the seal key and key ID from the password manager; init; restore (try
     without `-force`, then with it);
   - regenerate a root token with the recovery share;
   - read the Transit key's public key and check it equals the on-chain signer; sign a test hash;
   - destroy the machine and its disk afterwards (NIST §8.2.2.1 asks that removed backups leave
     no traces), and log the drill's date and result.
7. **When a holder leaves:** rotate the seal key (`previous_key`) and rekey the recovery shares
   (`bao operator rotate-keys -target=recovery`, [seal
   concepts](https://openbao.org/docs/concepts/seal/#recovery-key)), and give the new holder the
   new entry.

Cost: no money if the company has a password manager, about an hour to set up, and about an hour a
quarter for the drill. The risk it leaves: two people (and the password manager) can read the
material that, with a snapshot, gives the signing key. At ~180 XLM that is accepted, as ADR 0013
already accepts root on the server.

**For the ADR:** replace "regenerated with the unseal key" with "regenerated with the recovery
keys", and name the recovery shares and Borg passphrase as part of the backup.

## Unverified

- **Whether a non-forced restore works** onto a fresh cluster with the same static key and key ID.
  The code suggests the hash check would pass (the sealed hashes decrypt with the same key), but
  Vault's guide always forces, and we haven't run it. The drill settles it.
- **`-recovery-shares` with the static seal.** The init page lists the flags for "HSM, KMS and
  Transit seals"; the RFC says the static seal "does not change auto-unseal initialization
  processes". Not run yet.
- **That we can't issue a new AppRole secret ID without a root token** after a restore. It follows
  from ADR 0013's revoked root token, but no doc states this case.
- **Whether the company has a password manager, which one, and a safe.** Not found in the repo.
  The per-user price above is a rough market figure, not checked against a vendor page.
- **OpenBao docs have no page on restoring onto a new cluster.** The procedure here comes from
  Vault's guide plus OpenBao's API docs and source; OpenBao forked Vault's raft code, but the two
  may drift.
- **Borg's mode** (repokey or keyfile) for our sub-account isn't decided yet (0026).
- NIST SP 800-57 Part 2 (key management policy) wasn't read; Part 1 covers the points above.

## Sources

- OpenBao: [Seal/Unseal concepts](https://openbao.org/docs/concepts/seal/) (auto-unseal warning,
  recovery keys, rotation); [static seal](https://openbao.org/docs/configuration/seal/static/);
  [static auto-unseal RFC](https://openbao.org/community/rfcs/static-auto-unseal/);
  [operator init](https://openbao.org/docs/commands/operator/init/);
  [operator raft](https://openbao.org/docs/commands/operator/raft/);
  [/sys/storage/raft API](https://openbao.org/docs/api/system/storage/raft/) (checked 2026-10-20
  from the `main` branch sources in `website/content/`)
- OpenBao source (`main`, 2026-10-20):
  [`operator_raft_snapshot_restore.go`](https://github.com/openbao/openbao/blob/main/internal/command/operator_raft_snapshot_restore.go),
  [`logical_system_raft.go`](https://github.com/openbao/openbao/blob/main/internal/vault/logical_system_raft.go),
  [`raft.go`](https://github.com/openbao/openbao/blob/main/internal/vault/raft.go),
  [go-kms-wrapping `wrappers/static/static.go`](https://github.com/openbao/go-kms-wrapping/blob/main/wrappers/static/static.go)
- HashiCorp Vault: [Restore a snapshot](https://developer.hashicorp.com/vault/docs/sysadmin/snapshots/restore);
  [Snapshots](https://developer.hashicorp.com/vault/docs/sysadmin/snapshots);
  [operator raft](https://developer.hashicorp.com/vault/docs/commands/operator/raft);
  [PGP, GnuPG and Keybase](https://developer.hashicorp.com/vault/docs/concepts/pgp-gpg-keybase);
  [Production hardening](https://developer.hashicorp.com/vault/docs/concepts/production-hardening)
  (root token only);
  [Validated design: detailed design](https://developer.hashicorp.com/validated-designs/vault/installation-guide/vms/detailed-design);
  [Well-Architected: Vault recommended patterns](https://developer.hashicorp.com/well-architected-framework/operational-excellence/security-vault-anti-patterns)
- systemd: [Credentials](https://systemd.io/CREDENTIALS/);
  [systemd-creds(1)](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
- [NIST SP 800-57 Part 1 Rev. 5](https://doi.org/10.6028/NIST.SP.800-57pt1r5): §6.2.1.3, §6.2.2,
  §8.1.5.2.1, §8.2.2.1 (Tables 7–8), §9.2.1, §9.5, Appendix B.3
- [OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html)
- [BorgBackup: borg key export](https://borgbackup.readthedocs.io/en/stable/usage/key.html)
