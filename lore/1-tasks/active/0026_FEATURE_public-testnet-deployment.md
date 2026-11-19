---
id: "0026"
title: "Public testnet deployment"
type: FEATURE
status: active
owner: okarcz
milestone: 1
related_adr: ["0011", "0012", "0013"]
related_tasks: ["0012", "0014", "0022", "0017", "0020", "0013", "0039", "0036", "0047", "0099", "0100", "0118", "0127"]
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
  - date: "2026-10-28"
    status: backlog
    who: stkrolikiewicz
    note: "0077: one facilitator for both networks in a production environment (x402@production, deploy/production, no promotion step), a database per network; the deploy waits for listed too."
  - date: "2026-10-28"
    status: active
    who: stkrolikiewicz
    note: "Started with reading secrets from files (`*_FILE`); the server parts follow #79's names, and signing waits for 0036."
  - date: "2026-10-28"
    status: active
    who: stkrolikiewicz
    note: "Oskar's review of #79: x402-db-testnet@production, wanted rather than required by x402@production, secret files named per network, and only migrate-testnet beside the facilitator holding testnet's database password."
  - date: "2026-10-30"
    status: active
    who: stkrolikiewicz
    note: >
      Keys and settings before the first deploy (#96). The deploy key's public half is
      deploy/ansible/files/deploy-production.pub, SHA256:DDjhArrC+m/iaBZ3WUSYc/GdswEia1yc1CxK+/dZoFw;
      its private half exists only as the production environment's DEPLOY_SSH_KEY. HOST_KEY pins
      ch-prod-01's ed25519 key, SHA256:xHEsZRyqxld+80uqEtAGBv98/3DqjpoEuG9WPbnSPzI, read from
      /etc/ssh/ssh_host_ed25519_key.pub on the server over SSH checked against the admin's
      known_hosts. The production environment deploys only from deploy/production, needs one
      approval from any of six reviewers (stkrolikiewicz, karolko9, karczuRF, adamkoot, kowalski,
      mmisiorek) and never the person who started the deploy, has no admin bypass, and holds
      DEPLOY_HOST as a secret. The repo's default workflow permissions are read-only, and Actions
      can't create or approve pull requests.
  - date: "2026-10-30"
    status: active
    who: stkrolikiewicz
    note: "The production environment's reviewers are the x402 team only: stkrolikiewicz, karolko9, karczuRF and adamkoot; kowalski and mmisiorek came off the list."
  - date: "2026-10-30"
    status: active
    who: stkrolikiewicz
    note: >
      ch-prod-01 is set up up to the facilitator. deploy/production exists, protected by a ruleset
      (a pull request with one approval, no deletion or force push, no bypass). The playbook ran
      from develop, last at bb0660c, whose check run changed only compose.yaml. The four credentials are
      encrypted with the host key: the database password and URL, the RPC URLs (version
      2026-10-30: SDF's and gateway.fm's testnet RPC) and the tunnel token.
      x402-db-testnet@production and x402-tunnel@production run on the fixed subnets of #98, after
      the first start failed on Docker's empty address pool. cloudflared passed UDP and TCP 7844
      and uses QUIC; Browser Integrity Check is off for the hostname (soroban-infrastructure#2).
      The public URL answers 502: the tunnel is up and the facilitator isn't. Before the first
      deploy: the signer and channels (0036 and OpenBao on the server), then the GHCR package
      made public after the first image.
  - date: "2026-11-02"
    status: active
    who: stkrolikiewicz
    note: >
      OpenBao's project (deploy/openbao), its unit and the playbook's steps, tried locally on
      OpenBao 2.7.2: init with one recovery share under the static seal, Transit and an AppRole,
      a signature through testnet's socket from a container running as uid 1000 that verifies
      against the key, and a restart that unseals by itself. Raft needs a TCP listener for its
      cluster address, so admin is a loopback listener inside the container instead of a host
      socket (ADR 0013 amended). The step that moved testnet off an old key is gone: nothing ran
      on one (0036 decision 15).
  - date: "2026-11-03"
    status: active
    who: stkrolikiewicz
    note: >
      OpenBao runs on ch-prod-01. The playbook from develop at d413e75 changed only OpenBao's
      directories, compose file, config, unit and volumes. OpenBao started on 2026-11-02 at 16:25
      UTC and was initialised at 16:28 with one recovery share; the backup secret was created and
      read back the same. The admin's shell was lost before step 4, and init's root token with it:
      a root token from the recovery key in AWS (policy root) proved the backup, and init's token
      was revoked by its accessor. Then the Transit key stellar-testnet, the policy and AppRole
      x402-testnet, both AppRole credentials (each decrypts to 36 bytes), and the root token
      revoked on 2026-11-03 at 08:58:39 UTC (audit log). The key's account
      GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP holds 10,000 XLM from Friendbot,
      and 20 channels came in two transactions (2c966cac…, 34973a78…); on Horizon each has the key
      as its only signer and 1.5 XLM. Only the admin user is in the docker group. The firmware
      exposes no TPM (no ACPI TPM2 or TCPA table, no SMBIOS type 43, no /dev/tpm*); most likely the
      Ryzen 9 3900's fTPM is off in the BIOS, which wasn't checked. The .env values
      (FACILITATOR_ADDRESS_TESTNET, CHANNELS_TESTNET) and the facilitator wait for #102.
  - date: "2026-11-04"
    status: active
    who: stkrolikiewicz
    note: >
      The first deploy. #119 merged develop at 49790a8 (with 0091's #118 and #120) into
      deploy/production as e577fe6 at 12:32 UTC, and the push started Deploy production (run
      41830217640) although the workflow isn't on main; the image job built
      sha256:a56db8b2… by 12:34. While the deploy job waited for the production environment, the
      playbook ran, before the deploy rather than after it as the runbook then said; the runbook
      now allows both. The playbook from origin/deploy/production at e577fe6 changed two things,
      the hardened compose.yaml and /etc/logrotate.d/x402-openbao; x402-db-testnet@ and
      x402-tunnel@ were
      restarted onto it, and docker inspect showed Postgres as 999:999, cloudflared as
      65532:65532 and OpenBao as openbao, each with drop [ALL], add [] and no-new-privileges. The
      GHCR package x402-facilitator was made public (an anonymous token lists its tags). karczuRF
      approved the deploy, which ran from 12:57:07 to 12:57:37 UTC. /health answers ready, signer
      ok and listed; /supported lists exact on stellar:testnet with fees sponsored and the signer
      GAVE5V5I…KKRP. Not yet: a /settle through OpenBao, the facilitator container's inspect, and
      Run workflow (a rollback by digest), which needs the workflow on main: #126 puts a stub
      there. Making develop the default branch would remove that stub and deploy-board.yml's pin;
      a repo setting for the team, not decided.
  - date: "2026-11-05"
    status: active
    who: okarcz
    note: >
      okarcz takes over the server side from Stan: the second deploy and its checks, the no-seed,
      logrotate and audit-log checks, the backups and the restore drill. Karol has 0029. #126
      (main's stub, squashed) merged to main as 0e73532 and #125 to develop. The second deploy:
      before it, the running facilitator had only OPENBAO_ROLE_ID_FILE and OPENBAO_SECRET_ID_FILE,
      and no file under /srv/x402 set the plain names #121 refuses. Under deploy/ only the two
      .env.example files had changed, which the playbook doesn't install, so no playbook run.
      #132 merged develop at 1f7ece4 into deploy/production as 1df2055 at 11:46 UTC; the image job
      built sha256:e6bfaa1a… by 11:48 (run 42021731996), Stan approved the deploy, which ran from
      12:15:46 to 12:16:19 UTC. x402-deploy@production: the migration applied nothing, then
      "service facilitator is not running" at 12:15:59 (the probe's first try, with the old
      container already gone), the new one started at 12:15:59.7 and "deployed" at 12:16:17.
      digest and digest.good are both e6bfaa1a…, GitHub's production deployment records it beside
      a56db8b2…, and x402@, x402-db-testnet@, x402-tunnel@ and x402-openbao are active. /health
      answers ready, signer ok and listed; /supported 200. docker inspect: facilitator node,
      Postgres 999:999, cloudflared 65532:65532 and OpenBao openbao, each with drop [ALL], add []
      and no-new-privileges; migrate-testnet's config shows ALL and no-new-privileges:true.
  - date: "2026-11-05"
    status: active
    who: okarcz
    note: >
      Signing, seeds and logrotate checked on ch-prod-01, read-only. Karol's 0029 trial run
      (upstream 8827cf1) settled 18 payments from 11:07 to 11:19 UTC: 22 settled lines in
      x402@production's journal, three a pending answer and then success with the same hash on the
      client's repeat. OpenBao's audit log has 37 transit/sign/stellar-testnet responses that day,
      none with an error: a pair about 11 ms apart before each settlement (the channel's inner
      transaction and the fee bump), and one at 12:16:17, the deploy's signer check. On Horizon
      testnet, 17 of the 18 (c7b1bdfb… to 14ab0cc3…, ledgers 5570642 to 5570783; the first was cut
      from the log excerpt) are successful fee bumps with fee_account GAVE5V5I…KKRP and a different
      channel as each inner source. No Stellar secret (S and 55 base32 characters) in /srv, /etc,
      /home, /root, /opt or /usr/local, in our four containers' env or in the facilitator's
      journal; /var/lib/docker and the image weren't searched, and the key was made in OpenBao
      with exportable=false. logrotate hasn't rotated audit.log yet: its state file shows
      2026-11-05 00:00, the first sight of a config the playbook installed on 2026-11-04, so the
      first rotation is due after 00:00 UTC on 2026-11-06.
  - date: "2026-11-05"
    status: active
    who: okarcz
    note: >
      The backups' Storage Box access, set up and tested. Stan made two sub-accounts on BX21
      ch-prod-01-backup (SSH on port 23, ed25519 host key
      SHA256:XqONwb1S0zuj5A1CDxpOSuD2hnAArV1A3wKY7Z3sdgM): u595862-sub2 writes, home /x402,
      reachable only from ch-prod-01; u595862-sub3 reads only, home /x402/data, so its
      authorized_keys isn't the write account's. The data goes in /x402/data/pgbackrest and
      /x402/data/openbao. The write key was made on ch-prod-01 in /run and kept only as the
      host-encrypted credential /srv/x402/backup/creds/storage-box-ssh-key.cred
      (--name=storage-box-ssh-key, fingerprint SHA256:B7SozkS7mimbWA1OLyEdfRJ/Yp0i/T5pfTnWJB4bQU0).
      The restore key was made on okarcz's machine in /dev/shm and kept only in the backup
      secret, as storage_box_ro_ssh_key with storage_box_ro_user u595862-sub3 (fingerprint
      SHA256:cusjUd5fHX1CBCnAj1e7Fnn9E6iK9PUNgLN8aVxwgw0). It is version 2ce8bec6…; the
      original stays as AWSPREVIOUS 226d488f…, and no other field changed. Tests, with the host key
      pinned: from ch-prod-01, sub2 logged in with the credential's key and lists data/openbao
      and data/pgbackrest, both empty. From outside Hetzner, sub3 logged in with the key read from
      the secret and lists the same two, and its mkdir failed. Left open: data/.ssh, which holds
      sub3's keys, belongs to sub2, so a compromised server could change them, as it could delete
      the backups; Storage Box snapshots were asked about for that. pgBackRest runs on the host
      (okarcz), and Borg's key mode is still to decide.
  - date: "2026-11-05"
    status: active
    who: okarcz
    note: >
      Storage Box snapshots, which answer the data/.ssh point above. Stan turned on BX21's
      automatic snapshots: daily, 7 kept (BX21 has 20 slots), raised to 14 if space allows; he
      checks the space after the explorer's weekly Borg prune and compact on Monday. .zfs is
      read-only and only the Hetzner Console or API deletes a snapshot, so the write key on
      ch-prod-01 can't touch them: a server that is taken over can wipe the live repositories, not
      the last 7 days. A snapshot covers the whole box, the explorer's ClickHouse backups too, so
      a restore from one copies our files from .zfs/snapshot with the box's main account, never a
      Console rollback, which reverts the whole box. That path needs the main account; the normal
      restore reads the live repositories with u595862-sub3 and the backup secret. For ADR 0013,
      with the backups: this, and the read-only account's own directory (Stan).
  - date: "2026-11-05"
    status: active
    who: okarcz
    note: >
      Borg's key mode decided, after a question to Stan: repokey, with borg key export in the
      backup secret's borg_key_export. 0047's rule meant that the Storage Box alone must not
      decrypt a backup, and a key locked by the passphrase keeps that, as pgBackRest's cipher-pass
      does; the export covers a damaged key in the repository. Chosen over keyfile, whose only gain
      is against someone with the box and not the passphrase, already stopped by a long random
      passphrase and by OpenBao's own encryption of the Raft snapshot. From Stan: a passphrase
      change replaces borg_passphrase and borg_key_export in one put-secret-value, since the
      export is encrypted with it; and the restore drill imports the export into a local copy of
      the repository, since the read-only account can't write to it. Both are in ADR 0013 and
      this task's Implementation.
  - date: "2026-11-05"
    status: active
    who: okarcz
    note: >
      The backups split into two pull requests, OpenBao's snapshots first (okarcz): host only, no
      facilitator restart, and the signing key is the bigger loss. pgBackRest follows, its WAL
      copied by archive_command into a volume the host pushes from with a .path unit (okarcz,
      Stan's #24 pattern). Each is tested by a local round trip, not a CI job (okarcz). The first,
      on lore-0026-openbao-snapshots: x402-openbao-snapshot (bash, set -euo pipefail) logs in with
      the AppRole x402-snapshot (policy read on sys/storage/raft/snapshot, token_ttl 5m), the IDs
      as JSON over stdin; saves the snapshot in the container's /tmp, copies it to /run/x402/backup
      and checks it is a whole gzip before one borg create, so a failed save leaves no archive;
      prunes to 14 daily, compacts and touches /var/lib/x402/last-ok/openbao-snapshot, 0027's
      stamp. Its "borg ARGS" mode runs any Borg command for an admin with the same credentials.
      The timer runs daily at 03:15 UTC (15 min random delay, Persistent); the playbook installs
      borgbackup, the script, units, policy and the pinned known_hosts, and enables the timer
      without starting it. Logs stay in the journal. Local round trip on 2026-11-05, Ubuntu 24.04's
      Borg 1.2.8 in containers and a stand-in box over SSH on port 23: init and key export through
      the admin mode, a snapshot run, the snapshot token refused on the Transit key, a failed run
      with OpenBao stopped left the stamp unchanged, and a fresh OpenBao restored from a copy of
      the repository whose key was removed and imported from the export held the same Transit
      key. Deploy tests 92 (+7), each new one failed by a mutant. ch-prod-01 runs Ubuntu 24.04.3
      with borgbackup 1.2.8-1 already installed (the explorer's), the version tested and the
      box's borg-1.2; our job keeps its own BORG_BASE_DIR. The runbook's setup is still to run.
  - date: "2026-11-06"
    status: active
    who: okarcz
    note: >
      logrotate checked on ch-prod-01. The first rotation ran at 00:00:15 UTC: audit.log.1
      (587128 B, last entry 2026-11-05T15:22:07Z) and a new audit.log made by OpenBao on the
      postrotate SIGHUP (owner OpenBao's user, mode 0600, config nocreate), empty since nothing
      reached OpenBao overnight. systemctl restart x402@production at 08:16:02 (same digest
      e6bfaa1a…, nothing else restarted): audit.log's first entry 08:16:16.225, one AppRole login
      and one transit/sign each with request and response, the facilitator's signer_checked at
      08:16:16.279 and no signer_failed, /health ready, signer ok and listed at 08:16:19. The
      server's x402@ unit predates 0027 (journald, no stop hook) until the next playbook run.
  - date: "2026-11-06"
    status: active
    who: okarcz
    note: >
      Review of #140 (four reviewers, 5 decisions, 8 patches, 6 rejected), all applied. The script
      now holds a lock for the whole run, so an admin's borg call can't delete the night's files;
      sets its cleanup trap before the decrypt; and waits up to 5 minutes for OpenBao to be
      unsealed and active (bao status is_self, checked on OpenBao 2.7.2) before it logs in, for
      the run a timer catches up at boot. The service skips a run until the AppRole's credential
      exists, since an enabled timer starts after any reboot. New deploy/test/openbao-snapshot
      test runs the real script with fake docker, borg and sleep (the stamp only after create,
      prune and compact; none on an empty or partial snapshot or any failed step; the cleanup;
      the unseal wait; borg mode; the lock), each case failed by a mutant; deploy tests 108
      (+16). The runbook's passphrase change stores the new passphrase on the server before the
      repository changes, stops the timer, has setup's guards and says how to recover from each
      step; it also documents the read-only account's key and both keys' fingerprints. The box's
      owners know we depend on it: Stan, who holds its main account, made our two sub-accounts on
      2026-11-05. Left to the team: how the repository is checked between restore drills
      (Summary).
  - date: "2026-11-06"
    status: active
    who: okarcz
    note: >
      Stan's review of #140 (1 blocking, 6 non-blocking), all taken as he suggested. The runbook's
      first-run step ends by turning on the snapshots alarm group (check-series, the flag by pull
      request, deploy, fire-test), since production.json still has it off. Setup step 3 refuses
      when a passphrase is stored and removes the one it wrote if borg init finds a repository
      already there; the path for an existing repository comes with the restore drill. The
      passphrase change runs borg list before deleting the old passphrase. The service retries a
      failed run after 20 minutes (Restart=on-failure), and the timer runs at 03:15 UTC whatever the
      host's zone. Deploy tests 109 (+1), the retry and the UTC each failed by a mutant. The
      repository check was decided by the team on Slack (Summary), now backlog task 0118. A shared
      /run/x402/backup between this job and pgBackRest's is for the pgBackRest PR.
  - date: "2026-11-09"
    status: active
    who: okarcz
    note: "From 0027's decision 71: 0026 turns on the backups and snapshots alarm groups once their jobs run, fires each alarm once and records it (new criterion)."
  - date: "2026-11-12"
    status: active
    who: karolkow
    note: "From 0029, closed: 0026 turns on the upstream alarm group with the next production deploy, and reruns the conformance gate after the testnet reset of 2026-12-16 (two new criteria)."
---

# Public testnet deployment

## Summary

As a anyone integrating with or testing the facilitator, including the gate, I want the facilitator at a public HTTPS testnet URL, so that the e2e proxy and real resource servers can reach it.

**Story:** [M1 Story 2.5](../../../docs/planning/m1-epics.md#story-25-public-testnet-deployment) · **Lane:** Platform · **Covers:** FR21 prerequisite; NFR4, NFR9

**Decision (2026-11-06, the team on Slack):** how the Borg repository of OpenBao's snapshots is
checked between the quarterly restore drills. The daily job never reads old chunks back, and
deduplication makes every later archive reuse them, so a damaged chunk breaks each archive after it
while the stamp stays fresh. The options were: `borg check --verify-data` (decrypts every chunk,
seconds at our size) in the weekly review; `--repository-only` (on-disk checksums only) in the
weekly review; a weekly timer with its own stamp and a 0027 alarm; or nothing until the drill.
Chosen: the weekly timer with `--verify-data`, its own stamp and a 0027 alarm, done after the
CloudWatch change, as backlog task 0118.

## Context

- Needs [ADR 0011](../../../docs/adr/0011-facilitator-hosting.md) as revised in 0039 and 0077,
  the 0022 adapters and the OpenBao signer (0036).
- Related tasks: 0014, 0022, 0017, 0039, 0036, 0047.

## Implementation

- Dockerfile, image build and the deploy trigger from ADR 0011.
- Secrets and stores configured on the platform; runbook updated.
- From 0039 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md), revised; one facilitator
  for both networks in a `production` environment since 0077): Docker Compose on the company
  Hetzner server (x86_64), project `x402-production`, owned by its own Linux user `x402`, apart
  from ClickHouse's `app` project, in `/srv/x402` (the ClickHouse project's deploy overwrites its
  own directory). Production serves testnet for now.
  - `/srv/x402/production/` holds the compose file, `deploy.sh`, `digest` and the encrypted
    credentials; the Ansible playbook puts the first two there from a reviewed commit (below).
  - `facilitator`: memory limit 512 MiB, one CPU, no restart policy (systemd restarts it),
    `stop_grace_period` 180 s, healthcheck on `/health` every 10 s set in the compose service,
    not the image (a Node one-liner, 5 s timeout, 30 s `start_period`, 3 failures), no published
    port.
  - `migrate-testnet`: a one-off service of the facilitator image in the `migrate` profile, memory
    limit 512 MiB, with its healthcheck disabled,
    run only by `docker compose run --rm`, with its own statement and query timeouts instead of
    the app pool's 10 s and 15 s (`migrateMain` uses `createPool` today).
  - A systemd timer on the host restarts the `facilitator` container when it is `unhealthy`,
    every 30 s, with a 10 s stop timeout: found by its Compose project and service labels,
    skipping one-off containers, and only while `x402@production.service` is `active`.
  - `postgres-testnet`: PostgreSQL 18 pinned by digest, memory limit 1 GiB, `stop_grace_period`
    120 s, a set `shm_size`, data on a volume mounted at `/var/lib/postgresql` (the 18 image
    moved `PGDATA` to `/var/lib/postgresql/18/docker` and refuses the old `…/data` mount),
    reachable only from the facilitator and the migration service.
  - Networks `x402-production-edge` (`cloudflared` and the facilitator) and
    `x402-production-db` (`internal: true`, the facilitator, each network's Postgres and
    migration service), both part of the production compose project, on fixed subnets
    (`172.31.200.0/28` and `172.31.200.16/28`) since the server's Docker address pool is taken.
    Only the facilitator and `migrate-testnet` hold testnet's database password.
  - `cloudflared`: Cloudflare's tunnel connector pinned by digest, memory limit 128 MiB, under
    its own unit `x402-tunnel@production.service`, enabled at boot and untouched by deploys, so
    it keeps forwarding while the facilitator drains; `x402@production` runs after it. The unit
    decrypts the tunnel token, an encrypted systemd credential, and `cloudflared` reads it from a
    file (`--token-file`; check that the pinned version has it), never from `environment:`. The
    token file is mode 0400 for `nonroot` (uid 65532; check it on the pinned digest). The
    server must allow outbound connections on port 7844, UDP and TCP.
  - OpenBao (ADR 0013): one container for both networks in `/srv/x402/openbao/`, its own project
    `x402-openbao`, pinned by digest, memory limit 256 MiB and half a CPU, a listener socket per
    network in its own volume, mounted into the facilitator as an external volume, its own unit
    `x402-openbao.service` for the unseal credential. Its snapshots and restore drill follow
    ADR 0013 (task 0047).
  - Node `keepAliveTimeout` 125 s, above `cloudflared`'s 90 s idle keep-alive, with
    `headersTimeout` above it; the client IP from `CF-Connecting-IP` (0023). Sellers on Cloudflare
    Workers, or behind one NAT, share one rate-limit budget there: accepted on testnet (0060).
- From 0039, the image: `pnpm deploy --prod` with `injectWorkspacePackages: true`;
  `"files": ["dist"]` in `apps/facilitator/package.json` and a `.dockerignore` that excludes
  `.env*`; `node:22-slim` pinned by digest, `linux/amd64`, user `node`, read-only root filesystem.
  Images go to GHCR, tagged with the git SHA; the workflow builds on every deploy, only from
  `deploy/production`, and deploys the digest its build reports, never one read back from a tag.
  A successful deploy records its digest and SHA as a GitHub Deployment in the `production`
  environment, for rollback and the record; there is no promotion step (ADR 0011, 0038).
- From 0039, provisioning (ADR 0011): an Ansible playbook in `deploy/ansible/`, run by an admin
  from a reviewed commit, sets up x402's parts of the server: the `x402` user,
  `/srv/x402/production/`, the units and timers, the compose files, `deploy.sh`, the deploy
  user's `sudo` rule and forced command, `cloudflared`, and the pgBackRest config; 0027 adds the
  CloudWatch agent and its signing helper. It never touches the server's base setup (firewall, `daemon.json`, users), and CI
  never runs it.
- From 0039, the deploy:
  - GitHub Actions connects over SSH to the server's existing SSH port, with the server's host
    key pinned in the workflow's `known_hosts`, as a deploy user with one key per environment;
    the production key's `authorized_keys` entry fixes its environment
    (`command="/srv/x402/production/deploy.sh",restrict`), and the script accepts only an image
    digest (`sha256:` and 64 hex digits);
  - the deploy user isn't in the `docker` group: it may write only `digest.next` and run
    `sudo systemctl start x402-deploy@production`, its one `sudo` rule. `deploy.sh` holds a
    `flock` on `digest.next` while it writes it and starts the unit, which takes no lock of its
    own;
  - the `production` environment carries the protection rules from ADR 0011
    (`deploy/production` only);
  - `deploy/production` is a protected branch: a pull request from `develop` with an approving
    review, and no bypass, admins included;
  - `x402-deploy@production.service` (a oneshot, as root, `TimeoutStartSec` 60 min, the cap on a
    long migration from ADR 0011) sets a marker in `/run/x402/production/`, decrypts the
    credentials with `x402@production`'s script (the migrations need the database passwords),
    pulls the new image and runs each network's migration service (`migrate-testnet` today) from
    it while the old facilitator still serves;
    a failed migration fails the deploy and the old one keeps serving. Then it moves
    `digest.next` into `digest`, restarts `x402@production` and waits up to 120 s for
    `ready: true` and `listed: true` (`docker exec` with the healthcheck's one-liner); on both it
    writes `digest.good` and prunes all but the current and previous good images, and otherwise
    it puts `digest.good` back, restarts again and fails. The first deploy has no `digest.good`
    and fails into the alarms. `systemctl start` waits for it, so the job gets the result, and a
    dropped SSH session doesn't cut it;
  - `x402@production.service` decrypts the credentials to `/run/x402/production/` (tmpfs, 0700)
    and puts `digest.good` into `digest` unless the deploy's marker is there, then runs Compose
    in the foreground for the facilitator only (`--no-deps --exit-code-from facilitator`, since a
    plain `up` exits 0), without pulling or migrating, with `Restart=on-failure`, `RestartSec`
    5 s, a start limit of 5 in 300 s and `TimeoutStartSec` 60 s; `ExecStop` stops it. It wants
    and runs after `x402-db-testnet@production.service` (`Wants=`, not `Requires=`, so a
    database's restart never restarts the facilitator), which runs testnet's Postgres, decrypts
    its own credentials and has `TimeoutStopSec` 150 s, and it wants and runs after
    `x402-openbao.service`. All our units run Compose the same way, are `PartOf=docker.service`
    and run after it, the facilitator's with `TimeoutStopSec` 200 s, and they are enabled at
    boot;
  - it runs on a push to `deploy/production` unless only `lore/**`, `docs/**` or Markdown changed,
    and by hand, in a `concurrency` group with `cancel-in-progress: false`;
  - actions are pinned by commit SHA, with minimal token permissions, and the SSH key is an
    environment secret.
- From 0039, keys and secrets:
  - the facilitator signs through OpenBao Transit on the server (ADR 0013, 0036 a prerequisite);
  - the server's short-lived AWS credentials through IAM Roles Anywhere, for a role that only
    writes logs and metrics and is held only by the CloudWatch agent, come with 0027: the role,
    its profile, the agent, the certificate request and its renewal steps (0027 decision 6,
    agreed by Stan on 2026-11-03). The first deploy goes out without CloudWatch logs until 0027
    lands;
  - the database password and any keyed RPC URL are encrypted systemd credentials
    (`systemd-creds`), decrypted to `/run/x402/production/` and mounted as Compose `file:` secrets,
    never `environment:`. The files are named per network, so mainnet adds its own and renames
    none (ADR 0011): `database-url.testnet`, `rpc-urls.testnet`, `approle-role-id.testnet` and
    `approle-secret-id.testnet` by `node` (uid 1000), `postgres-password.testnet` by `postgres`
    (uid 999), and `tunnel-token` by `nonroot` (uid 65532), each mode 0400. Each unit decrypts
    the files its container reads;
  - the config reads `DATABASE_URL_FILE`, `RPC_URLS_FILE` and the OpenBao AppRole files when
    they are set, and the plain variables otherwise, for local runs; the deploy points them at
    testnet's files;
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
  `http://facilitator:4021`, anything else 404) and DNS record, both Terraform in
  `soroban-infrastructure`'s `cloudflare/` (stkrolikiewicz applies it for now). The Compose
  service is `facilitator`, one for both networks. The compose file keeps `PORT` at 4021, and
  changing it means changing `cloudflare/x402.tf` too.
  Bot Fight Mode, Browser Integrity Check and "I'm Under Attack" stay off on the zone. Nothing
  goes into the ClickHouse project's repo.
  - **Before the first deploy:** Browser Integrity Check was `on` on 2026-10-28 (Cloudflare's
    default; `cloudflare/zone.tf` doesn't set it). It answers clients whose headers don't look
    like a browser with error 1010 at the edge, so the facilitator never sees the request. Turn
    it off for `x402-facilitator.sorobanscan.com` with a configuration rule in
    `soroban-infrastructure` (the rest of the zone keeps it for sorobanscan's site), checking which
    token permission the ruleset needs. Bot Fight Mode couldn't be read (the token has no Bot
    Management permission): check its toggle in the dashboard, Security → Bots. Done: Bot Fight
    Mode is off (2026-10-29), and the rule is applied (soroban-infrastructure#2, 2026-10-30); a
    request with no `User-Agent` reaches the tunnel instead of answering 1010.
- From 0039: `GET /health` answers 200 and reports `ready` and `listed` in its body (`listed`
  since 0019, `05dcfae`: a sweep has listed the non-final records).
- From 0039, the runbook: running the playbook from a reviewed commit, deploy, rollback
  (automatic on a failed deploy; by hand, redeploy an earlier digest), long migrations outside
  the deploy, reboots, fetching the tunnel token from Cloudflare (dashboard, API or
  `terraform output`) into its systemd credential, rotating that token and checking the
  tunnel's connector count, key rotation as an on-chain signer change (0027 adds renewing the
  Roles Anywhere certificate), and restoring the service on another machine.
- From 0013 ([ADR 0012](../../../docs/adr/0012-facilitator-state-store.md)), the database, on the
  server (ADR 0011):
  - the `postgres-testnet` container above, its credentials a Compose secret file;
  - the upgrade policy and a restore drill in the runbook; there is no failover on one server.
- From 0039, migrations: the deploy unit runs `node dist/migrate.js` in a one-off container of
  the new image, before the old facilitator stops, since the runtime image has no pnpm. Locally it is
  `pnpm --filter @stellar-x402/facilitator migrate` after `pnpm build`; the root has no `migrate`
  script.
- From 0022: at startup the facilitator checks that the database is reachable and every migration
  it knows is applied (a database ahead of the code passes, see below). A schema behind the code
  stops the start (#82), so `ready` leaves the schema out.
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
  `x402-openbao.service`, and the facilitator under `x402@production` (ADR 0011, 0077), each
  unit passing in its own credentials. None gets the Docker socket. Swap and core dumps off for
  OpenBao.
- **Link:** a socket per network, each in its own volume, mounted into the one facilitator
  (ADR 0013 is updated in 0077), plus admin on a loopback listener inside OpenBao's container,
  which Raft needs for its cluster address (OpenBao takes that only from a TCP listener).
  OpenBao's compose service uses `network_mode: none`: it needs no network, nothing outside the
  container reaches the loopback listener, and on the server Docker's address pool has none to
  give, which fails a default network at start.
- **Keys:** one Transit key per network, generated inside OpenBao, `type=ed25519`,
  `exportable=false`, `allow_plaintext_backup=false`. One policy per network allowing only
  `transit/sign/<key>`, and one AppRole per network: `token_ttl` and `token_max_ttl` 1 h, a secret
  ID that doesn't expire, delivered as a Compose secret. User lockout off for AppRole (ADR 0013).
- **Unseal:** a static seal key as an encrypted systemd credential (`systemd-creds`, `host` mode).
  Note in the runbook whether the board has a TPM (ADR 0013's first upgrade); finding out before
  mainnet is 0100.
- **Init:** `bao operator init -recovery-shares=1 -recovery-threshold=1`. The static seal accepts
  these flags (OpenBao 2.7.2, 2026-11-02).
- **Backup secret** (ADR 0013): `x402/production/openbao-backup` in AWS Secrets Manager,
  `eu-central-1`, in the AWS account soroban-explorer and prices-api share; tags
  `Project=stellar-x402`, `Environment=production`; 30-day recovery window; default
  `aws/secretsmanager` key.
  - One JSON: `seal_key_hex`, `seal_key_id`, `seal_key_sha256`, `previous_seal_key_hex`,
    `previous_seal_key_id`, `recovery_key`, `borg_passphrase`, `borg_key_export`, `seal_config`,
    `openbao_version`, `storage_box_ro_user`, `storage_box_ro_ssh_key`, `updated`.
  - Made by hand from an admin's machine, never by CDK: the JSON goes over stdin to
    `aws secretsmanager create-secret`, so it never reaches a disk. Every change (a seal key
    rotation, a new Borg passphrase, an OpenBao upgrade) is a `put-secret-value` of the whole JSON;
    the old version stays as `AWSPREVIOUS`.
  - The server gets no AWS credentials that can read it: only the roles ADR 0011 names (today the
    logs-and-metrics role, ADR 0013). The runbook names the secret and its fields, never values.
- **Admin:** the root token revoked after setup, regenerated with the recovery key when needed
  through the legacy `/sys/generate-root/*` API (the 2.6+ CLI's `generate-root` needs a token);
  admin through SSH and `docker compose exec` on the loopback listener (with
  `disable_unauthed_generate_root_endpoints=false`); no UI.
- **Audit log:** a file on its own volume, rotated daily by the playbook's
  `/etc/logrotate.d/x402-openbao` (a year, compressed; SIGHUP makes OpenBao reopen it); alarm at
  90% disk, after the server's disk alarm at 80% (0027 decision 73).
- **Snapshots:** daily Raft snapshots to our own sub-account and Borg repository on the company's
  existing Hetzner Storage Box, keeping 14, set up like that box's other sub-account. Tell
  the team that owns the box that we depend on it. The job uses its own AppRole with a
  snapshot-only policy (`sys/storage/raft/snapshot`), its credential a systemd credential, over
  the admin listener. A second, read-only sub-account, its SSH key in the backup secret, is what
  a restore uses; its home is the repositories' directory, one below the write account's (ADR
  0013). Borg runs in **repokey** mode, and `borg key export` goes into the backup secret's
  `borg_key_export` anyway (okarcz with Stan, 2026-11-05): nothing on the Storage Box decrypts a
  backup by itself, since the key there is locked by the passphrase, as pgBackRest's
  `cipher-pass` is. The export is encrypted with the current passphrase, so a
  `borg key change-passphrase` replaces `borg_passphrase` and `borg_key_export` together, in one
  `put-secret-value`.
- **Fee float** (ADR 0013): refill to 100 XLM, alarms at 25 and 10 XLM, no upper limit, the same
  numbers on testnet for now. The alarms come from 0027's off-server check, which publishes the
  spendable balance, so `checkFacilitatorBalance`'s `minSpendableStroops` isn't set (0027
  decision 7).
- **Testnet on the OpenBao key:** nothing has run on another key, so nothing moves. An ordinary
  wallet funds the OpenBao key's account and creates its channels with `create-channels.ts`
  (0036 decision 15, #100); the facilitator starts in `openbao` signer mode with that account as
  its address (#102).
- **Runbook** in `docs/runbook.md`:
  - **restore drill:** on a throwaway machine with no route to production, using only the backup
    secret and the Storage Box: copy the Borg repository to the machine through the read-only
    account and `borg key import` the secret's export into that copy (the read-only account
    can't write to the repository, and this is the restore a damaged repository key needs),
    pull the newest snapshot from the copy, start OpenBao with the seal key and key
    ID, init, restore (first without `-force`, then with it), regenerate a root token with the
    recovery key (legacy API), issue an AppRole login, check that the Transit public key equals the on-chain
    signer, check the CloudTrail event history for reads that weren't drills, destroy the machine,
    log the result. First on testnet, before mainnet; then quarterly and after any seal key
    rotation, passphrase change or OpenBao upgrade;
  - **top-ups:** testnet with a short Friendbot script (Friendbot only creates accounts, so it
    funds a fresh account and merges it into the fee account); mainnet by a withdrawal from the
    company's exchange account to the fee account (no memo). **Who makes it, and a backup person:
    TBD before mainnet;**
  - **weekly review** (okarcz): from the first deploy, which alarms are in ALARM; after the
    mainnet deploy also the real fee spend (0027's `fee_charged_stroops` over 7 days, against the
    balance's change), the next refill amount, and whether ADR 0013's custody still fits the
    float;
  - a leaked token or secret ID: destroy the secret ID, revoke its tokens, issue a new one, and
    restart the facilitator, which reads it at start;
  - a restore of OpenBao from a snapshot: restart the facilitator, since a token newer than the
    snapshot answers 403 until its hour ends (0036). A new login worked after a restore in one run
    on OpenBao 2.7.2; the drill confirms it;
  - a suspected key theft: new Transit key, then one transaction signed by the old key: it creates
    the new key's own account, a `set_options` on each channel adds the new key and removes the
    old one, and an `accountMerge` moves the old fee account into it; check the theft alarm's
    history (its tool and rehearsal are 0099, before mainnet);
  - OpenBao upgrades and what `/settle` does meanwhile (it answers an error).

## Acceptance Criteria

- [x] Given the Hetzner server and Docker Compose of ADR 0011 (revised in 0039 and 0077), when a deploy runs, then a container image built from the repo is deployed to it as the ADR describes, and the service answers `/supported` at a public HTTPS URL
- [x] Given a running instance, when a new version is deployed, then the old process stops before the new one starts; the process is long-lived and never scaled to zero (2026-11-05, the second deploy, run 42021731996: the old container was gone at 12:15:59 before the new one started at 12:15:59.7, healthy at 12:16:17)
- [x] Given the facilitator key, when the service is deployed, then it signs through the testnet OpenBao Transit key, the raw key never reaches the facilitator's process, the image or the logs, and it is a testnet-only key (ADR 0013) (2026-11-05: 0029's 18 trial settlements signed through `transit/sign/stellar-testnet`, 0 errors in the audit log, fee bumps paid by `GAVE5V5I…KKRP` on testnet; no secret seed in the containers' env or the facilitator's journal; the key is `exportable=false`)
- [x] Given `DATABASE_URL_FILE` or `RPC_URLS_FILE`, when the service starts, then it reads the value from that file, and with neither set it falls back to `DATABASE_URL` and `RPC_URLS`
- [ ] Given the durable stores from 0022, when the service runs, then it uses them, and `docs/runbook.md` has the deploy and rollback steps
- [ ] Given the deployed facilitator, when it settles, then it signs through OpenBao Transit over the unix socket, no secret seed is on the server outside OpenBao, the backup secret exists in AWS, and a restore drill from it has passed (2026-11-05: signing over the socket, no seed in the server's files, and the backup secret since 2026-11-02 are shown; the restore drill is left, and it waits for the backups)
- [x] Given OpenBao's audit log on the server, when `logrotate` runs, then the file is renamed, OpenBao writes to a new `audit.log` and still signs, and old files past a year are removed (runbook, OpenBao) (2026-11-06: rotated at 00:00:15 UTC; OpenBao made the new `audit.log` on the SIGHUP (`nocreate`); after a facilitator restart at 08:16:02 its first entry is 08:16:16, the signer check's AppRole login and `transit/sign`, logged `signer_checked` at 08:16:16.279, and `/health` `signer: ok`; removal past a year rests on `rotate 365` and `maxage 365`)
- [ ] Given pgBackRest archiving WAL with a first backup made, and OpenBao's daily snapshot run once, when each is true, then `make check-series` passes for its alarm group (`backups`: `wal-failing`, `wal-stale`, `backup-age`; `snapshots`: `snapshot-age`), the group is turned on and deployed, each alarm has fired once on purpose, and `docs/monitoring.md` says how and when (moved from 0027, its decision 71)
- [ ] Given the next production deploy, when it deploys the Watch stack with the upstream section (#149) and a 08:00 UTC run has published, then `make check-series GROUP=upstream` passes in the 3 hours after it, `"upstream": true` goes in `infra/envs/production.json`, the Alarms stack is deployed, `make fire-test` runs, and `docs/monitoring.md` moves `upstream-changed` and `upstream-silent` out of the alarms that are off (moved from 0029, its decision 23)
- [ ] Given the testnet reset of 2026-12-16 (developers.stellar.org, Networks), when the facilitator settles again on the new network, then the conformance gate reruns against it, its results are committed, and `conformance/REPORT.md`'s settlements are refreshed: the reset removes the run's transactions from the network (moved from 0029)
