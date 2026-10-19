# ADR 0013: Keep the facilitator key in OpenBao Transit on the facilitator's own server

- Status: accepted
- Date: 2026-10-19
- Supersedes: the key custody part of [ADR 0011](0011-facilitator-hosting.md) ("Keys, secrets and
  access": the SSM parameter for `FACILITATOR_SECRET` and the mainnet KMS key)

## Context

- The facilitator moves from AWS to the company's Hetzner dedicated server, to save cost. ADR 0011
  kept the key in AWS SSM on testnet and in AWS KMS on mainnet (0036). Neither exists on Hetzner,
  and Hetzner has no KMS, HSM or secret manager.
- AD-12: one facilitator key per network signs for every channel and pays fee bumps. It reaches the
  pool only as a `TransactionSigner`, so a remote signer can replace it.
- The key can't move buyers' or sellers' tokens. A thief gets the fee account's float and the
  channels' reserves: about 180 XLM at launch, roughly $30
  ([R-key-leak-impact](../../lore/1-tasks/active/0047_RESEARCH_hetzner-key-custody/notes/R-key-leak-impact.md)).
- A spike signed Stellar transactions with OpenBao 2.7.1 Transit Ed25519 keys. One landed on testnet
  (`26a93987…`, ledger 5210493), at about 6 ms a signature locally.
- The server also runs another company project's services.

## Decision

### Where the key lives

- **OpenBao's Transit engine holds the key.** It is generated inside OpenBao, `type=ed25519`,
  `exportable=false`, `allow_plaintext_backup=false`. The raw key never exists outside OpenBao.
- **OpenBao runs in its own container** on the facilitator's server, beside the facilitator's
  container, under Docker Compose. A systemd unit starts Compose and passes in the credentials.
  Neither container gets the Docker socket.
- **One OpenBao per server.** Testnet and mainnet each get their own Transit key, policy and
  AppRole, so a break-in on one network's facilitator gets only that network's token.
- **The same setup on testnet and mainnet,** so testnet runs exactly what mainnet will.
- **OpenBao does Transit signing only.** Other secrets, such as a keyed RPC URL, stay systemd
  credentials, so OpenBao is needed for `/settle` and not for the facilitator to start.

### How the facilitator signs

- **A Transit `TransactionSigner`** (0036) sends the 32-byte transaction hash to
  `transit/sign/<network key>` and adds the 64-byte signature.
- **A unix socket only.** OpenBao listens on a socket in a volume shared only with the
  facilitator's container. It opens no TCP port, so nothing on the network can reach it.
- **AppRole login.** The role ID and secret ID come in as Compose secrets. The token is valid for
  1 hour (`token_ttl`), at most 24 hours (`token_max_ttl`), and the signer renews it and logs in
  again by itself. The secret ID doesn't expire. The policy allows only `transit/sign/<network key>`.
  A leaked token stops working within the hour; a leaked secret ID is revoked by hand (runbook).
- **Fail closed.** If OpenBao is down, sealed, or can't write its audit log, `/settle` answers an
  error, `/verify` keeps working and an alarm fires. There is no fallback copy of the key.

### Unseal, backup and recovery

- **Static seal key as an encrypted systemd credential** (`systemd-creds`, `host` mode). systemd
  decrypts it at start and hands it to OpenBao, which unseals by itself after a restart.
  - TPM mode (`tpm2` or `host+tpm2`) would bind the credential to the board, so a copied disk
    couldn't open it. It is the first upgrade to consider; it isn't used now.
- **Daily Raft snapshots leave the server.** They go to our own sub-account and Borg repository on
  the company's existing Hetzner Storage Box (BX21), daily, keeping 14. The snapshots are encrypted
  by OpenBao, and the Borg repository is encrypted too.
- **The unseal key is kept offline, apart from the snapshots.** A snapshot opens only with it. Who
  holds that backup is open (see Open questions).
- **No cold key.** The OpenBao key stays each account's only signer, as AD-12 says today. 0048's
  cold recovery signer is declined for now and re-checked before mainnet.
- **If OpenBao's data and the unseal key are both lost,** the fee account and every channel are
  lost with their XLM. Recovery is then a new key, new accounts and new channels.

### Operations

- **Platform runs OpenBao** as part of 0026: upgrades, snapshots, the audit log and alarms.
  **Payments owns** the signer code, the key policy and this ADR.
- **No standing admin access.** The root token is revoked after setup and regenerated with the
  unseal key when needed. Admin is through SSH on the server with the `bao` CLI; no web UI, no
  remote admin.
- **The audit log** goes to a file on its own volume, rotated, with an alarm at 80% disk: OpenBao
  stops signing when it can't write it.
- **Alarms** (0027):
  - OpenBao sealed or down, or signing failing;
  - a fee bump on the fee account that our submitter didn't send, read from Horizon: the audit log
    can't show signatures made with a copied key;
  - the fee account's spendable balance below 50 XLM;
  - the audit log disk at 80%.
- **Moving to the OpenBao key on testnet:** the current key signs a `set_options` on the fee
  account and each channel that adds the OpenBao key and removes itself. The service stops for it,
  as in ADR 0011's rotation steps.
- **Rotation and break-in runbook** (0026):
  - a leaked token or secret ID: destroy the secret ID, revoke its tokens, issue a new one;
  - a suspected key theft: create a new Transit key, move every account to it with the old key,
    drain what is left, and check the fee-bump alarm's history.

## Rationale

- **The stakes set the cost.** Against about 180 XLM, a separate OpenBao machine (~€78–144 a year)
  or AWS KMS costs more than a likely loss.
- **OpenBao still beats a file secret at no cost.** A facilitator bug can leak only a token that
  expires within an hour, not the key, and every signature is in the audit log.
- **Root on the server can still copy the key,** from memory or from the disk plus the unseal
  credential. That is accepted at these stakes. The fee-bump and balance alarms catch a theft, and
  the float caps it.
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

## Consequences

- **The hot key can do anything on our accounts.** A theft costs the float plus downtime, and can
  lock us out of the channels. 0048 stays a mainnet blocker until it is re-decided.
- **Losing OpenBao's data and the unseal key loses the accounts.** The snapshots and the unseal key
  backup must be tested by a restore before mainnet.
- **A restart of the server stops `/settle` until OpenBao is unsealed,** which happens by itself in
  seconds.
- **We depend on another project's Storage Box.** If it is cancelled or resized, our snapshots go
  with it. 0026 tells that team.
- **0036 becomes the OpenBao Transit signer,** owned by Payments. 0026 gains the OpenBao deployment
  and its runbook.
- **The upgrade path** when the float or `upto` (0015) raises the stakes: TPM-bound credentials,
  then OpenBao on its own machine, then a KMS. The `TransactionSigner` stays the same.
- **The rest of ADR 0011 still describes AWS.** The move to Hetzner needs its own hosting ADR.

## Open questions

- **Who holds the unseal key backup,** and where (0047's acceptance criteria).
- **Where the fee account's top-ups come from** when the 50 XLM alarm fires.
- **Whether the server has a TPM,** for the upgrade above.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-12
- [ADR 0011](0011-facilitator-hosting.md): hosting, and the custody this ADR replaces
- Task 0047 (`lore/1-tasks/active/0047_RESEARCH_hetzner-key-custody/`):
  - `notes/S-key-custody-decisions.md`: every decision, question by question;
  - `notes/R-key-leak-impact.md`: what a leaked key costs;
  - `notes/R-key-custody-options.md` and `notes/R-openbao-on-hetzner.md`: the options compared;
  - `spike/results.md`: Transit signatures on Stellar.
- Tasks 0036 (signer), 0026 (deployment and runbook), 0027 (alarms), 0048 (thresholds, re-check)
- OpenBao: [Transit](https://openbao.org/docs/secrets/transit/),
  [static seal](https://openbao.org/docs/configuration/seal/static/),
  [AppRole](https://openbao.org/docs/auth/approle/)
- [systemd credentials](https://systemd.io/CREDENTIALS/)
