# ADR 0013: Keep the facilitator key in OpenBao Transit on the facilitator's own server

- Status: accepted
- Date: 2026-10-19
- Amended: 2026-10-20 (where the unseal backup lives, the restore drill, the fee float and
  top-ups; [S-key-custody-decisions](../../lore/1-tasks/active/0047_RESEARCH_hetzner-key-custody/notes/S-key-custody-decisions.md#backup-and-top-ups-2026-10-20));
  2026-10-21 (the AWS logging role and the other secrets, to match ADR 0011's Hetzner revision;
  a socket per network, OpenBao's own unit and limits, from the PR #24 review)
- Supersedes: the key custody part of [ADR 0011](0011-facilitator-hosting.md) ("Keys, secrets and
  access": the SSM parameter for `FACILITATOR_SECRET` and the mainnet KMS key)

## Context

- The facilitator moves from AWS to the company's Hetzner dedicated server, to save cost. ADR 0011
  kept the key in AWS SSM on testnet and in AWS KMS on mainnet (0036). Neither exists on Hetzner,
  and Hetzner has no KMS, HSM or secret manager.
- AD-12: one facilitator key per network signs for every channel and pays fee bumps. It reaches the
  pool only as a `TransactionSigner`, so a remote signer can replace it.
- The key can't move buyers' or sellers' tokens. A thief gets the fee account's float and the
  channels' reserves: about 130 XLM at launch (a 100 XLM float plus ~30 XLM of reserves)
  ([R-key-leak-impact](../../lore/1-tasks/active/0047_RESEARCH_hetzner-key-custody/notes/R-key-leak-impact.md)).
- A spike signed Stellar transactions with OpenBao 2.7.1 Transit Ed25519 keys. One landed on testnet
  (`26a93987…`, ledger 5210493), at about 6 ms a signature locally.
- The server also runs another company project's services.

## Decision

### Where the key lives

- **OpenBao's Transit engine holds the key.** It is generated inside OpenBao, `type=ed25519`,
  `exportable=false`, `allow_plaintext_backup=false`. The raw key never exists outside OpenBao.
- **OpenBao runs in its own container** on the facilitator's server, beside the facilitators'
  containers, under Docker Compose, pinned by digest, with a 256 MiB memory limit and half a CPU.
  Its own systemd unit (`x402-openbao.service`, ADR 0011) starts it and passes in the unseal
  credential. No container gets the Docker socket.
- **One OpenBao per server.** Testnet and mainnet each get their own Transit key, policy, AppRole
  and socket, so a break-in on one network's facilitator gets only that network's token and can't
  reach the other network's socket. It still shares the process, so a flood from one network
  slows the other's signing; that is accepted at these stakes (Rationale).
- **The same setup on testnet and mainnet,** so testnet runs exactly what mainnet will.
- **OpenBao does Transit signing only.** Other secrets, the database password and `RPC_URLS` (one
  credential file per version, ADR 0011), stay systemd credentials, so OpenBao is needed for
  `/settle` and not for the facilitator to start.

### How the facilitator signs

- **A Transit `TransactionSigner`** (0036) sends the 32-byte transaction hash to
  `transit/sign/<network key>` and adds the 64-byte signature.
- **A unix socket per network only.** OpenBao has one listener per network, each on a socket in
  its own volume, mounted only into that network's facilitator. It opens no TCP port, so nothing
  on the network can reach it.
- **AppRole login.** The role ID and secret ID come in as Compose `file:` secrets, decrypted by
  the network's unit to a tmpfs (ADR 0011), never as environment variables. The token is valid
  for 1 hour (`token_ttl`), at most 24 hours (`token_max_ttl`), and the signer renews it and logs
  in again by itself. The secret ID doesn't expire. The policy allows only `transit/sign/<network key>`.
  A leaked token stops working within the hour; a leaked secret ID is revoked by hand (runbook).
- **Fail closed.** If OpenBao is down, sealed, or can't write its audit log, `/settle` answers an
  error, `/verify` keeps working and an alarm fires. There is no fallback copy of the key.

### Unseal, backup and recovery

- **Static seal key as an encrypted systemd credential** (`systemd-creds`, `host` mode). systemd
  decrypts it at start and hands it to OpenBao, which unseals by itself after a restart.
  - TPM mode (`tpm2` or `host+tpm2`) would bind the credential to the board, so a copied disk
    couldn't open it. It is the first upgrade to consider; it isn't used now.
- **Daily Raft snapshots leave the server.** They go to our own sub-account and Borg repository on
  the company's existing Hetzner Storage Box, daily, keeping 14. The snapshots are encrypted
  by OpenBao, and the Borg repository is encrypted too.
- **The backup set is kept in AWS Secrets Manager, apart from the snapshots.** A restore on a new
  server needs four items, all of which are lost with the server
  ([R-unseal-key-backup](../../lore/1-tasks/active/0047_RESEARCH_hetzner-key-custody/notes/R-unseal-key-backup.md)):
  1. the static seal key and its exact key ID (OpenBao refuses a key whose ID differs, and
     `-force` doesn't get round it), plus the previous pair for 14 days after a rotation;
  2. the recovery key, which regenerates a root token (it can't unseal or open a snapshot);
  3. the Borg passphrase, plus `borg key export` output in keyfile mode;
  4. the `seal "static"` stanza and the OpenBao version.
- **One secret, `x402/production/openbao-backup`,** in `eu-central-1`, in the AWS account that
  soroban-explorer and prices-api share. One server runs both networks, so one OpenBao and one
  secret. It is one JSON (`seal_key_hex`, `seal_key_id`, `seal_key_sha256`,
  `previous_seal_key_hex`, `previous_seal_key_id`, `recovery_key`, `borg_passphrase`,
  `borg_key_export`, `seal_config`, `openbao_version`, `updated`), encrypted with the default
  `aws/secretsmanager` key, with a 30-day recovery window. Tags `Project=stellar-x402`,
  `Environment=production`.
  - **AWS is a store here, not a signer.** People read it during a restore; no settlement calls it.
    The facilitator's server has no AWS credentials except the roles ADR 0011 names and
    justifies, and none of them may sign or read this secret. Today that is one logs-and-metrics
    role (IAM Roles Anywhere), held only by the CloudWatch agent on the host. An S3 fallback for
    the snapshots would get its own named, write-only role there, not this one.
  - **Made by hand with the CLI, never by CDK,** so no stack teardown deletes it: stage the JSON in
    `/dev/shm`, `create-secret`, `shred`. Later changes use `put-secret-value`; the old version
    stays as `AWSPREVIOUS`. The 0026 operator writes it; the runbook names the fields, never the
    values.
  - **AWS is the only copy.** No paper copy for now.
- **Init with one recovery share:** `bao operator init -recovery-shares=1 -recovery-threshold=1`,
  and the share goes into the secret.
- **A restore drill proves the backup.** On a throwaway machine with no route to production, using
  only the secret and the Storage Box: restore the newest snapshot, regenerate a root token, issue
  an AppRole login, check that the Transit public key equals the on-chain signer, and check the
  CloudTrail event history for reads that weren't drills. Before mainnet (first on testnet), then
  every quarter and after any seal key rotation, passphrase change or OpenBao upgrade. Owned by
  Platform (0026).
- **No cold key.** The OpenBao key stays each account's only signer, as AD-12 says today. 0048's
  cold recovery signer is declined for now and re-checked before mainnet.
- **If OpenBao's data and the unseal key are both lost,** the fee account and every channel are
  lost with their XLM. Recovery is then a new key, new accounts and new channels.

### Operations

- **Platform runs OpenBao** as part of 0026: upgrades, snapshots, the audit log and alarms.
  **Payments owns** the signer code, the key policy and this ADR.
- **No standing admin access.** The root token is revoked after setup and regenerated with the
  recovery key when needed. Admin is through SSH on the server with the `bao` CLI; no web UI, no
  remote admin.
- **The audit log** goes to a file on its own volume, rotated, with an alarm at 80% disk: OpenBao
  stops signing when it can't write it.
- **Alarms** (0027):
  - OpenBao sealed or down, or signing failing;
  - a fee bump on the fee account that our submitter didn't send, read from Horizon: the audit log
    can't show signatures made with a copied key;
  - the fee account's spendable balance below 25 XLM, as a Slack message (0027 decides where the
    check runs and what the message says);
  - the audit log disk at 80%.
- **The fee float is 100 XLM, with the alarm at 25 XLM, and no upper limit.** That is about 24,000
  typical `exact` settlements (~41,200 stroops each, ADR 0003), and about 6 days to act after the
  alarm at 1,000 settlements a day. Testnet uses the same numbers for now.
  - **Top-ups are by hand.** Testnet: Friendbot (a one-line script in the 0026 runbook). Mainnet:
    a withdrawal from the company's exchange account to the fee account; who makes it is named
    before mainnet. Never an automatic top-up from a key on the server, which would put the
    treasury behind the same root.
  - **A weekly review** after the mainnet deploy (okarcz, Payments): the real fee spend, the next
    refill amount, and whether this custody still fits the float (see Rationale).
- **Moving to the OpenBao key on testnet:** the current key signs a `set_options` on the fee
  account and each channel that adds the OpenBao key and removes itself. The service stops for it,
  as in ADR 0011's rotation steps.
- **Rotation and break-in runbook** (0026):
  - a leaked token or secret ID: destroy the secret ID, revoke its tokens, issue a new one;
  - a suspected key theft: create a new Transit key, move every account to it with the old key,
    drain what is left, and check the fee-bump alarm's history.

## Rationale

- **The stakes set the cost.** A leak reaches the float plus the channels' reserves: about 130 XLM
  at launch. Against that, a separate OpenBao machine (~€78–144 a year) or AWS KMS costs more than
  a likely loss. The float has no upper limit, so the weekly review re-checks this: once a year of
  the upgrade path costs less than a leak would, the review raises the upgrade.
- **OpenBao still beats a file secret at no cost.** A facilitator bug can leak only a token that
  expires within an hour, not the key, and every signature is in the audit log.
- **Root on the server can still copy the key,** from memory or from the disk plus the unseal
  credential. That is accepted at these stakes. The fee-bump and balance alarms catch a theft, and
  the float caps it.
- **Any admin of the shared AWS account can read the backup set,** and with one snapshot from the
  Storage Box, take the key. That is accepted for the same reason, and it is the access model
  soroban-explorer and prices-api already use. AWS KMS can't hold the backup: it never gives a key
  back.
- **One mechanism on both networks** means testnet rehearses mainnet, unlike ADR 0011's SSM/KMS
  split.
- **OpenBao over Vault:** the same API (the spike passed on both), MPL-2.0 rather than BSL, and its
  HSM and static seals are open source.

## Alternatives considered

- **OpenBao on its own Hetzner Cloud machine,** linked over a vSwitch with mTLS: root on the
  facilitator's server could sign but not copy the key. Rejected for cost at today's stakes.
- **AWS KMS called from Hetzner:** the key never leaves KMS, for ~$12–36 a year. Rejected: it
  brings AWS back after a move made to leave it for cost, and adds a cross-cloud call to every
  settlement.
- **The key as a file secret** (systemd credential): free, but a facilitator bug leaks the key
  itself, and nothing logs its use.
- **Shamir unseal:** protects a copied disk or snapshot, but `/settle` stops after every restart
  until key holders unseal.
- **A cold recovery signer (0048 as written):** limits the hot key to fees and allows recovery
  after a loss, but needs a cold key held offline. Declined for now.
- **A hardware HSM:** not offered by Hetzner for dedicated servers.
- **For the backup set:** a password manager vault held by two people, a paper copy in a safe,
  one holder only, or a Shamir split of the seal key. Rejected for the AWS account the other
  projects already run: one holder is a single point of failure, and a split is over-built at
  these stakes. AWS KMS can't hold it at all.

## Consequences

- **The hot key can do anything on our accounts.** A theft costs the float plus downtime, and can
  lock us out of the channels. 0048 stays a mainnet blocker until it is re-decided.
- **Losing OpenBao's data and the backup set loses the accounts.** The restore drill tests both
  before mainnet and every quarter.
- **We depend on the shared AWS account.** If it is closed or we lose access, the backup set goes
  with it. The AWS account has no CloudTrail trail, so nothing alarms on a read of the secret; the
  drill checks the 90-day event history, and an alarm is a 0027 follow-up.
- **A restart of the server stops `/settle` until OpenBao is unsealed,** which happens by itself in
  seconds.
- **We depend on another project's Storage Box.** If it is cancelled or resized, our snapshots go
  with it. 0026 tells that team.
- **0036 becomes the OpenBao Transit signer,** owned by Payments. 0026 gains the OpenBao deployment
  and its runbook.
- **The upgrade path** when the float or `upto` (0015) raises the stakes: TPM-bound credentials,
  then OpenBao on its own machine, then a KMS. The `TransactionSigner` stays the same.
- **ADR 0011 describes the hosting on Hetzner** (task 0039): the containers, the deploys and the one
  AWS role above. A new AWS role on the server needs its own entry and reason there.

## Open questions

- **Who makes mainnet top-ups,** and a backup person (before mainnet, 0026).
- **Three facts the first drill settles:** whether a restore needs `-force`, whether
  `-recovery-shares` works with the static seal, and the AppRole re-login after a restore.
- **Whether the server has a TPM,** for the upgrade above.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-12
- [ADR 0011](0011-facilitator-hosting.md): hosting, and the custody this ADR replaces
- Task 0047 (`lore/1-tasks/active/0047_RESEARCH_hetzner-key-custody/`):
  - `notes/S-key-custody-decisions.md`: every decision, question by question;
  - `notes/R-key-leak-impact.md`: what a leaked key costs;
  - `notes/R-unseal-key-backup.md`: what a restore needs, and where its backup lives;
  - `notes/R-key-custody-options.md` and `notes/R-openbao-on-hetzner.md`: the options compared;
  - `spike/results.md`: Transit signatures on Stellar.
- Tasks 0036 (signer), 0026 (deployment and runbook), 0027 (alarms), 0048 (thresholds, re-check)
- OpenBao: [Transit](https://openbao.org/docs/secrets/transit/),
  [static seal](https://openbao.org/docs/configuration/seal/static/),
  [AppRole](https://openbao.org/docs/auth/approle/),
  [seal concepts and recovery keys](https://openbao.org/docs/concepts/seal/)
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)
- [systemd credentials](https://systemd.io/CREDENTIALS/)
