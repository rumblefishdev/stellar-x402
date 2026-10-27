---
id: "0026"
title: "Public testnet deployment"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011", "0012", "0013"]
related_tasks: ["0012", "0014", "0022", "0017", "0020", "0013", "0039", "0036", "0047"]
tags: [facilitator, deploy, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.5 (Platform lane)."
  - date: "2026-10-19"
    status: backlog
    who: okarcz
    note: "0047 (ADR 0013): the facilitator key moves to OpenBao Transit on the Hetzner server; adds its deployment and runbook."
  - date: "2026-10-20"
    status: backlog
    who: okarcz
    note: "Added where RPC_URLS lives and keeps its old values, from Stan's PR #41 review."
  - date: "2026-10-20"
    status: backlog
    who: okarcz
    note: "0047 (ADR 0013 amended): the unseal backup secret in AWS, the restore drill, the fee float and manual top-ups."
  - date: "2026-10-21"
    status: backlog
    who: stkrolikiewicz
    note: "Units per network for deploys, Postgres and rollback, secrets in tmpfs, backups from the host, deploy/testnet, from Oskar's and Adam's PR #24 reviews."
  - date: "2026-10-22"
    status: backlog
    who: stkrolikiewicz
    note: "Reading secrets from files (`*_FILE`) moved here from 0020, which was nearly done when #24 was rebased."
  - date: "2026-10-22"
    status: backlog
    who: stkrolikiewicz
    note: "PR #24 round three: pgBackRest backups, migrations before the old facilitator stops, testnet deploys record their digest for mainnet."
  - date: "2026-10-22"
    status: backlog
    who: stkrolikiewicz
    note: "Public URL through Cloudflare Tunnel on sorobanscan.com, from Marek's and Marcin's Slack proposal; no Caddy site block or Route 53 record."
  - date: "2026-10-23"
    status: backlog
    who: stkrolikiewicz
    note: "An Ansible playbook provisions x402's parts of the server, confirmed with Marek; deploys stay a digest over SSH (ADR 0011)."
  - date: "2026-10-23"
    status: backlog
    who: stkrolikiewicz
    note: "PR #24 round four: Compose exit codes and a start limit, the tunnel token for nonroot, 7844 over UDP and TCP, the zone settings that stay off, token rotation in the runbook; 0062 named as the tunnel's prerequisite."
---

# Public testnet deployment

## Summary

As a anyone integrating with or testing the facilitator, including the gate, I want the facilitator at a public HTTPS testnet URL, so that the e2e proxy and real resource servers can reach it.

**Story:** [M1 Story 2.5](../../../docs/planning/m1-epics.md#story-25-public-testnet-deployment) · **Lane:** Platform · **Covers:** FR21 prerequisite; NFR4, NFR9

## Context

- Needs [ADR 0011](../../../docs/adr/0011-facilitator-hosting.md) as revised in 0039, the 0022
  adapters and the OpenBao signer (0036).
- Related tasks: 0014, 0022, 0017, 0039, 0036, 0047.

## Implementation

- Dockerfile, image build and the deploy trigger from ADR 0011.
- Secrets and stores configured on the platform; runbook updated.
- From 0039 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md), revised): Docker Compose on the company Hetzner server
  (x86_64), project `x402`, owned by its own Linux user, apart from ClickHouse's
  `app` project, in `/srv/x402` (the ClickHouse project's deploy overwrites its own directory).
  - `/srv/x402/testnet/` holds the compose file, `deploy.sh`, `digest` and the encrypted
    credentials; the Ansible playbook puts the first two there from a reviewed commit (below).
  - `facilitator-testnet`: memory limit 512 MiB, one CPU, no restart policy (systemd restarts it),
    `stop_grace_period` 180 s, healthcheck on `/health` every 10 s set in the compose service,
    not the image (a Node one-liner, 5 s timeout, 30 s `start_period`, 3 failures), no published
    port.
  - `migrate-testnet`: a one-off service of the facilitator image in the `migrate` profile, memory
    limit 512 MiB, with its healthcheck disabled,
    run only by `docker compose run --rm`, with its own statement and query timeouts instead of
    the app pool's 10 s and 15 s (`migrateMain` uses `createPool` today).
  - A systemd timer on the host restarts the `facilitator-testnet` container when it is
    `unhealthy`, every 30 s, with a 10 s stop timeout: found by its Compose service label,
    skipping one-off containers, and only while `x402@testnet.service` is `active`.
  - `postgres-testnet`: PostgreSQL 18 pinned by digest, memory limit 1 GiB, `stop_grace_period`
    120 s, a set `shm_size`, data on a volume mounted at `/var/lib/postgresql` (the 18 image
    moved `PGDATA` to `/var/lib/postgresql/18/docker` and refuses the old `…/data` mount),
    reachable only from the facilitator and the migration service.
  - Networks `x402-testnet-edge` (`cloudflared-testnet` and the facilitator) and
    `x402-testnet-db` (`internal: true`, the facilitator, Postgres and the migration service),
    both part of our compose project.
  - `cloudflared-testnet`: Cloudflare's tunnel connector pinned by digest, memory limit 128 MiB,
    under its own unit `x402-tunnel@testnet.service`, enabled at boot and untouched by deploys,
    so it keeps forwarding while the facilitator drains; `x402@testnet` runs after it. The unit
    decrypts the tunnel token, an encrypted systemd credential, and `cloudflared` reads it from a
    file (`--token-file`; check that the pinned version has it), never from `environment:`. The
    token file is mode 0400 for `nonroot` (uid 65532; check it on the pinned digest). The
    server must allow outbound connections on port 7844, UDP and TCP.
  - OpenBao (ADR 0013): one container for both networks in `/srv/x402/openbao/`, pinned by
    digest, memory limit 256 MiB and half a CPU, a listener socket per network in its own volume,
    its own unit `x402-openbao.service` for the unseal credential. Its snapshots and restore
    drill follow ADR 0013 (task 0047).
  - Node `keepAliveTimeout` 125 s, above `cloudflared`'s 90 s idle keep-alive, with
    `headersTimeout` above it; the client IP from `CF-Connecting-IP` (0023).
- From 0039, the image: `pnpm deploy --prod` with `injectWorkspacePackages: true`;
  `"files": ["dist"]` in `apps/facilitator/package.json` and a `.dockerignore` that excludes
  `.env*`; `node:22-slim` pinned by digest, `linux/amd64`, user `node`, read-only root filesystem.
  Images go to GHCR, tagged with the git SHA; the workflow skips the build when the SHA exists.
  A successful testnet deploy records its digest and SHA as a GitHub Deployment in the `testnet`
  environment, which mainnet later promotes from (ADR 0011).
- From 0039, provisioning (ADR 0011): an Ansible playbook in `deploy/ansible/`, run by an admin
  from a reviewed commit, sets up x402's parts of the server: the `x402` user,
  `/srv/x402/<network>/`, the units and timers, the compose files, `deploy.sh`, the deploy
  user's `sudo` rule and forced command, `cloudflared`, and the pgBackRest and CloudWatch agent
  config. It never touches the server's base setup (firewall, `daemon.json`, users), and CI
  never runs it.
- From 0039, the deploy:
  - GitHub Actions connects over SSH to the server's existing SSH port, with the server's host
    key pinned in the workflow's `known_hosts`, as a deploy user with one key per network; each
    key's `authorized_keys` entry fixes its network
    (`command="/srv/x402/testnet/deploy.sh",restrict`), and the script accepts only an image
    digest (`sha256:` and 64 hex digits);
  - the deploy user isn't in the `docker` group: it may write only `digest.next` and run
    `sudo systemctl start x402-deploy@testnet`, its one `sudo` rule. `deploy.sh` holds a `flock`
    on `digest.next` while it writes it and starts the unit, which takes no lock of its own;
  - the `testnet` and `mainnet` environments carry the protection rules from ADR 0011
    (`deploy/testnet` only; `v*` tags, required reviewers, "Prevent self-review");
  - `deploy/testnet` is a protected branch: a pull request from `develop` with an approving
    review, and no bypass, admins included;
  - `x402-deploy@testnet.service` (a oneshot, as root) sets a marker in `/run/x402/testnet/`,
    decrypts the credentials with `x402@testnet`'s script (the migration needs the database
    password), pulls the new image and runs `migrate-testnet` from it while the old facilitator
    still serves; a failed migration fails the deploy and the old one keeps serving. Then it moves
    `digest.next` into `digest`, restarts `x402@testnet` and waits up to 120 s for `ready: true`
    (`docker exec` with the healthcheck's one-liner); on `ready` it writes `digest.good` and
    prunes all but the current and previous good images, and otherwise it puts `digest.good`
    back, restarts again and fails. The first deploy has no `digest.good` and fails into the
    alarms. `systemctl start` waits for it, so the job gets the result, and a dropped SSH session
    doesn't cut it;
  - `x402@testnet.service` decrypts the credentials to `/run/x402/testnet/` (tmpfs, 0700) and
    puts `digest.good` into `digest` unless the deploy's marker is there, then runs Compose in
    the foreground for the facilitator only (`--no-deps --exit-code-from facilitator-testnet`,
    since a plain `up` exits 0), without pulling or migrating, with `Restart=on-failure`,
    `RestartSec` 5 s, a start limit of 5 in 300 s and `TimeoutStartSec` 60 s; `ExecStop` stops
    it. It requires and runs
    after `x402-db@testnet.service`, which runs Postgres, decrypts its own credentials and has
    `TimeoutStopSec` 150 s, and it wants and runs after `x402-openbao.service`. All our units run
    Compose the same way, are `PartOf=docker.service` and run after it, the facilitator's with
    `TimeoutStopSec` 200 s, and they are enabled at boot;
  - it runs on a push to `deploy/testnet` unless only `lore/**`, `docs/**` or Markdown changed,
    and by hand, in a `concurrency` group with `cancel-in-progress: false`;
  - actions are pinned by commit SHA, with minimal token permissions, and the SSH key is an
    environment secret.
- From 0039, keys and secrets:
  - the facilitator signs through OpenBao Transit on the server (ADR 0013, 0036 a prerequisite);
  - the server gets short-lived AWS credentials through IAM Roles Anywhere, for a role that only
    writes logs and metrics, held only by the CloudWatch agent. The trust anchor is the
    ClickHouse project's existing client-certificate CA; the server certificate is issued with
    that project's script, valid for a year, its CN accepted by the role's trust policy and kept
    off the ClickHouse site's allowlist. Ask that project to tell us when it rotates its CA;
  - the database password and any keyed RPC URL are encrypted systemd credentials
    (`systemd-creds`), decrypted to `/run/x402/testnet/` and mounted as Compose `file:` secrets,
    never `environment:`. Each file is mode 0400, owned by the user that reads it: the database
    URL, `RPC_URLS` and the AppRole files by `node` (uid 1000), the Postgres password by
    `postgres` (uid 999), and the tunnel token by `nonroot` (uid 65532). Each unit decrypts
    the files its container reads;
  - the config reads `DATABASE_URL_FILE`, `RPC_URLS_FILE` and the OpenBao AppRole files when
    they are set, and the plain variables otherwise, for local runs;
  - no TLS to `postgres-testnet` on the internal network; `scram-sha-256` passwords.
- From 0039: backups of `postgres-testnet` go off the server with pgBackRest. Postgres hands each
  WAL segment to it (`archive_command`, `archive-async`, `archive_timeout` 60 s), and a timer
  runs a daily `pgbackrest backup`. The repository is of type `sftp`, in `pgbackrest/` on our own
  sub-account on the company's existing Storage Box (beside Borg's `openbao/`), compressed and
  encrypted, kept 14 days. Its passphrase and the Storage Box SSH key are encrypted systemd
  credentials, and the passphrase is also kept beside ADR 0013's backup secret in AWS Secrets
  Manager. Decide how the database reaches the box: a second network for Postgres, or pgBackRest
  on the host. The restore drill adds `pgbackrest check` and `pgbackrest verify`.
- From 0039: the public URL is `x402-facilitator.sorobanscan.com` through Cloudflare Tunnel
  (ADR 0011; one hostname for both networks, task 0076). Prerequisites, set up by task 0062: the
  `sorobanscan.com` zone on Cloudflare, and the tunnel `x402` with its routing (the hostname to
  `http://facilitator:4021`, so the facilitator's Compose service is `facilitator`, anything
  else 404) and DNS record, both Terraform in `soroban-infrastructure`'s `cloudflare/`
  (stkrolikiewicz applies it for now). Bot Fight Mode, Browser Integrity Check and "I'm Under
  Attack" stay off on the zone. Nothing goes into the ClickHouse project's repo.
- From 0039: `GET /health` answers 200 and reports `ready` in its body.
- From 0039, the runbook: running the playbook from a reviewed commit, deploy, rollback
  (automatic on a failed deploy; by hand, redeploy an earlier digest), long migrations outside
  the deploy, reboots, fetching the tunnel token from Cloudflare (dashboard, API or
  `terraform output`) into its systemd credential, rotating that token and checking the
  tunnel's connector count, renewing the Roles Anywhere certificate, key
  rotation as an on-chain signer change, and restoring the service on another machine.
- From 0013 ([ADR 0012](../../../docs/adr/0012-facilitator-state-store.md)), the database, on the
  server (ADR 0011):
  - the `postgres-testnet` container above, its credentials a Compose secret file;
  - the upgrade policy and a restore drill in the runbook; there is no failover on one server.
- From 0039, migrations: the deploy unit runs `node dist/migrate.js` in a one-off container of
  the new image, before the old facilitator stops, since the runtime image has no pnpm. Locally it is
  `pnpm --filter @stellar-x402/facilitator migrate` after `pnpm build`; the root has no `migrate`
  script.
- From 0022: at startup the facilitator checks that the database is reachable and every migration
  it knows is applied (a database ahead of the code passes, see below). Until then it isn't ready
  and `/settle` answers 503.
- Option from 0022's third review, to verify rather than a decision (a better approach may exist):
  - Separate database roles: a migrator that owns the schema, and an app role with DML only.
    `pnpm migrate` would then read its own URL variable.
  - Measure commit latency under a flood of rate-limit `hit` calls running alongside `claim`.
  - Migrations are tracked by name only. A checksum of each migration's SQL would catch an edited
    one. 0022's first review judged this too small; it matters once a database is durable.
  - The startup schema check (0025/0026) should accept a database ahead of the code, i.e. every
    known migration applied. Otherwise a rollback to an earlier SHA refuses to start.
- From 0022: measure `addHash` and the full settle path on the testnet database this task creates;
  0022 had no instance to measure on (ADR 0012's Consequences).
- From 0009 (PR #41, decision 47): decide where `RPC_URLS` lives on the server and keep its old
  values.
  - A keyed RPC URL is a secret (ADR 0011), but the Hetzner move left its store open: ADR 0013
    covers only the signing key.
  - Logs name an endpoint `RPC_URLS[i]#<fingerprint>` (the first 8 hex digits of the entry's
    SHA-256), and `RPC_URLS[i]` can mean another URL after a redeploy. Matching an old line to a
    URL needs that URL: a store with versions, or each change recorded in the deploy history. A
    plain env file that is edited in place loses it.
  - From 0039: `RPC_URLS` is an encrypted systemd credential like the other secrets, one file per
    version (`rpc-urls.<date>.cred`), never edited in place. The unit names the active one; the
    older files are the history, so an old fingerprint maps back to its URL.

### The facilitator key in OpenBao (0047)

> [ADR 0013](../../../docs/adr/0013-facilitator-key-custody.md) replaces the SSM parameter for
> `FACILITATOR_SECRET` above. The facilitator moved to the company's Hetzner server; the rest of
> this task still follows ADR 0011 until a hosting ADR replaces it.

- **Containers:** OpenBao (the official image, pinned by digest) under its own unit,
  `x402-openbao.service`, and each network's facilitator under that network's unit (ADR 0013),
  each unit passing in its own credentials. None gets the Docker socket. Swap and core dumps off
  for OpenBao.
- **Link:** a socket per network, each in its own volume mounted only into that network's
  facilitator, plus the admin socket (root-only, in no container); no TCP listener.
- **Keys:** one Transit key per network, generated inside OpenBao, `type=ed25519`,
  `exportable=false`, `allow_plaintext_backup=false`. One policy per network allowing only
  `transit/sign/<key>`, and one AppRole per network: `token_ttl` and `token_max_ttl` 1 h, a secret
  ID that doesn't expire, delivered as a Compose secret.
- **Unseal:** a static seal key as an encrypted systemd credential (`systemd-creds`, `host` mode).
  Note in the runbook whether the board has a TPM (ADR 0013's first upgrade).
- **Init:** `bao operator init -recovery-shares=1 -recovery-threshold=1`. Check that the static
  seal accepts these flags (the init docs name only HSM, KMS and Transit seals).
- **Backup secret** (ADR 0013): `x402/production/openbao-backup` in AWS Secrets Manager,
  `eu-central-1`, in the AWS account soroban-explorer and prices-api share; tags
  `Project=stellar-x402`, `Environment=production`; 30-day recovery window; default
  `aws/secretsmanager` key.
  - One JSON: `seal_key_hex`, `seal_key_id`, `seal_key_sha256`, `previous_seal_key_hex`,
    `previous_seal_key_id`, `recovery_key`, `borg_passphrase`, `borg_key_export`, `seal_config`,
    `openbao_version`, `storage_box_ro_user`, `storage_box_ro_ssh_key`, `updated`.
  - Made by hand from an admin's machine, never by CDK: stage the JSON in `/dev/shm`,
    `aws secretsmanager create-secret`, `shred`. Every change (a seal key rotation, a new Borg
    passphrase, an OpenBao upgrade) is a `put-secret-value` of the whole JSON; the old version stays
    as `AWSPREVIOUS`.
  - The server gets no AWS credentials that can read it: only the roles ADR 0011 names (today the
    logs-and-metrics role, ADR 0013). The runbook names the secret and its fields, never values.
- **Admin:** the root token revoked after setup, regenerated with the recovery key when needed
  through the legacy `/sys/generate-root/*` API with curl (the 2.6+ CLI needs a token); admin
  through SSH over the admin socket (root-only, in no container, with
  `disable_unauthed_generate_root_endpoints=false`); no UI.
- **Audit log:** a file on its own volume, rotated; alarm at 80% disk (0027).
- **Snapshots:** daily Raft snapshots to our own sub-account and Borg repository on the company's
  existing Hetzner Storage Box, keeping 14, set up like that box's other sub-account. Tell
  the team that owns the box that we depend on it. The job uses its own AppRole with a
  snapshot-only policy (`sys/storage/raft/snapshot`), its credential a systemd credential, over
  the admin socket. A second, read-only sub-account on the same directory, its SSH key in the
  backup secret, is what a restore uses. Decide the Borg mode (repokey or keyfile); in
  keyfile mode `borg key export` goes into the backup secret.
- **Fee float** (ADR 0013): refill to 100 XLM, alarm at 25 XLM, no upper limit, the same numbers on
  testnet for now. Set `checkFacilitatorBalance`'s `minSpendableStroops` to 25 XLM (its default is
  100 XLM).
- **Move testnet to the OpenBao key:** stop the service; in one transaction signed by the current
  key, create the OpenBao key's own account, a `set_options` on each channel adds the OpenBao key
  and removes the current one, and an `accountMerge` moves the old fee account into the new one;
  start the service in `openbao` signer mode with the new account as its address (0036).
- **Runbook** in `docs/runbook.md`:
  - **restore drill:** on a throwaway machine with no route to production, using only the backup
    secret and the Storage Box: pull the newest snapshot, start OpenBao with the seal key and key
    ID, init, restore (first without `-force`, then with it), regenerate a root token with the
    recovery key (legacy API), issue an AppRole login, check that the Transit public key equals the on-chain
    signer, check the CloudTrail event history for reads that weren't drills, destroy the machine,
    log the result. First on testnet, before mainnet; then quarterly and after any seal key
    rotation, passphrase change or OpenBao upgrade;
  - **top-ups:** testnet with a short Friendbot script (Friendbot only creates accounts, so it
    funds a fresh account and merges it into the fee account); mainnet by a withdrawal from the
    company's exchange account to the fee account (no memo). **Who makes it, and a backup person:
    TBD before mainnet;**
  - **weekly review** after the mainnet deploy (okarcz): the real fee spend, the next refill
    amount, and whether ADR 0013's custody still fits the float;
  - a leaked token or secret ID: destroy the secret ID, revoke its tokens, issue a new one;
  - a suspected key theft: new Transit key, then the same transaction as the move above with the
    old key, check the theft alarm's history;
  - OpenBao upgrades and what `/settle` does meanwhile (it answers an error).

## Acceptance Criteria

- [ ] Given the Hetzner server and Docker Compose of ADR 0011 (revised in 0039), when a deploy runs, then a container image built from the repo is deployed to it as the ADR describes, and the service answers `/supported` at a public HTTPS URL
- [ ] Given a running instance, when a new version is deployed, then the old process stops before the new one starts; the process is long-lived and never scaled to zero
- [ ] Given the facilitator key, when the service is deployed, then it signs through the testnet OpenBao Transit key, the raw key never reaches the facilitator's process, the image or the logs, and it is a testnet-only key (ADR 0013)
- [ ] Given `DATABASE_URL_FILE` or `RPC_URLS_FILE`, when the service starts, then it reads the value from that file, and with neither set it falls back to `DATABASE_URL` and `RPC_URLS`
- [ ] Given the durable stores from 0022, when the service runs, then it uses them, and `docs/runbook.md` has the deploy and rollback steps
- [ ] Given the deployed facilitator, when it settles, then it signs through OpenBao Transit over the unix socket, no secret seed is on the server outside OpenBao, the backup secret exists in AWS, and a restore drill from it has passed
