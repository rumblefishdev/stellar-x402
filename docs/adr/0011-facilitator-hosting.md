# ADR 0011: Host the facilitator on the company Hetzner server

- Status: accepted; key custody superseded by [ADR 0013](0013-facilitator-key-custody.md)
- Date: 2026-10-09, amended 2026-10-15 (task 0009: the `/settle` budget is 30 s, below the
  seller's own 90 s timeout), 2026-10-16 (task 0009: the checks are inside the budget; RPC
  endpoints are logged as `RPC_URLS[i]`) and 2026-10-20 (task 0009: `RPC_URLS[i]#<fingerprint>`
  and the fingerprint's limit; how far a repeat runs past the budget) and 2026-10-21 (task 0009:
  bare RPC hosts in error messages)
- Revised: 2026-10-13. ECS Fargate became the company Hetzner server (task 0039); the first
  version is in git history and task 0014. 2026-10-21: the key moved to OpenBao (ADR 0013), and
  deploys, reboots, backups, alarms and downtime were worked out in the PR #24 review.
  2026-10-22: pgBackRest for Postgres, migrations before the old facilitator stops, mainnet
  promoted by a recorded digest, and the Hetzner Cloud VM weighed on its coupling (third round);
  the facilitator is reached through Cloudflare Tunnel on `sorobanscan.com` instead of the
  server's Caddy. 2026-10-23: the third round's last threads (units restart with Docker, the
  deploy lock, `digest.good`, the units' timeouts, secret file owners, encryption at rest), and
  the Hetzner Cloud VM rejected for mainnet too.

## Context

`apps/facilitator` is the only deployable service (AD-1): one Node 22 process per network that
holds the channel pool, `/verify`, `/settle`, `/supported` and `/discovery/resources`. The Tranche 1
gate needs it at a public HTTPS testnet URL (AD-15, ADR 0009); mainnet follows in a later tranche
with a 99% uptime target.

The host must:

- **keep the process running.** The pool does background work between requests, so no
  scale-to-zero and no idle CPU throttling;
- **stop the old process before the new one starts.** One process owns a channel set through a
  store lease, so deploys can't overlap (AD-17);
- **give at least 90–120 s after SIGTERM.** The process drains in-flight submissions, and with the
  pool's defaults (`timeoutSeconds` 60 + `confirmGraceSeconds` 30) a sent one can take ~90 s;
- **keep the facilitator key out of the image, the logs and the facilitator's process** (AD-12);
- **offer a durable store** for the PostgreSQL schema of ADR 0012.

The company already runs a Hetzner dedicated server for its production ClickHouse:

- x86_64, with plenty of free CPU, RAM and disk, and ClickHouse held to a memory limit in its
  container;
- Docker Compose, and Caddy already terminates HTTPS for ClickHouse's mutual-TLS endpoint, in the
  same compose project as ClickHouse.

Our containers are limited to 1.625 GiB of RAM per network, 1.875 GiB on testnet with OpenBao
and 3.5 GiB with both networks; on testnet they need about 2 GB of disk, WAL included. The company
bought `sorobanscan.com` for sorobanscan and the Stellar Prices API and moves it, as a whole zone,
to Cloudflare on the Free plan.

## Decision

### Platform and containers

- **Docker Compose on the company Hetzner server,** for testnet and mainnet. The project is
  `x402`, separate from ClickHouse's `app` project, owned by its own Linux user.
  - It lives in `/srv/x402`, outside the ClickHouse project's directory, which that project's
    deploy overwrites.
  - Each network has its own directory, `/srv/x402/<network>/`, with its compose file, deploy
    script, `digest` file and encrypted credentials. OpenBao, shared by both networks, has
    `/srv/x402/openbao/`.
  - Nothing else is there apart from the data volumes.
- **Per network, three long-running containers and a one-off one:**
  - `facilitator-<network>`, memory limit 512 MiB and one CPU;
  - `cloudflared-<network>`, Cloudflare's tunnel connector pinned by digest, memory limit
    128 MiB. It has a unit of its own (below), so a deploy never restarts it and it keeps
    forwarding while the facilitator drains;
  - `postgres-<network>`, PostgreSQL 18 pinned by digest, memory limit 1 GiB, data on a volume
    on the server's RAID. It has a unit of its own (below), so a facilitator deploy never
    restarts it;
  - `migrate-<network>`, a one-off service of the facilitator image that runs the migrations,
    with its healthcheck disabled and a 512 MiB limit, left out of the totals since it runs only
    during a deploy. It is in the `migrate` profile, so `docker compose up` never starts it.
- **One OpenBao container for both networks** (ADR 0013), pinned by digest, memory limit 256 MiB
  and half a CPU.
  - Each network gets its own listener socket in its own volume, mounted only into that
    network's facilitator, so neither facilitator can reach the other network's socket.
- **The limits add up to 1.625 GiB per network:** 1.875 GiB on testnet with OpenBao, 3.5 GiB
  with both networks. They are ceilings; testnet uses less.
- **Testnet and mainnet never share a facilitator,** a database, a key or a channel set (AD-12).
  OpenBao is the one shared container.
- **No container publishes a port on the host,** and each network gets two Docker networks of
  its own, both part of our compose project:
  - `x402-<network>-edge`: that network's `cloudflared` and facilitator only. Both reach the
    internet through it: `cloudflared` to Cloudflare, the facilitator to its RPC URLs;
  - `x402-<network>-db`: `internal: true`, the facilitator, its Postgres and the migration
    service only, with no route out.
  - No facilitator joins the ClickHouse project's `app` network, so neither reaches ClickHouse or
    the other network's facilitator. OpenBao is reached over a unix socket per network
    (ADR 0013), not a network.
- **systemd restarts a facilitator that crashes, not Docker.** Its unit runs Compose in the
  foreground with `Restart=on-failure`, so the unit ends when the container does and systemd
  starts it again. The containers have no restart policy, so nothing starts at boot except
  through the units (below). Neither acts on `unhealthy`, so a hung one needs a watcher:
  - a systemd timer on the host runs every 30 s and restarts the `facilitator-<network>`
    container when it is `unhealthy`, with a 10 s stop timeout, since a hung process can't drain
    anyway. It finds the container by its Compose service label and skips one-off containers;
  - it acts only while the network's unit (`x402@<network>.service`, below) is `active`. While a
    deploy, a reboot or an operator stops or starts the unit, it skips the pass, so it never
    restarts a facilitator that is draining;
  - it runs on the host, so no container gets the Docker socket.
- **The healthcheck is set on the facilitator service in the compose file,** not in the image. It
  is a Node one-liner (`node:22-slim` has no curl): it calls `/health` with a 5 s timeout, after
  a 30 s `start_period`, and three failures in a row make the container `unhealthy`. The
  migration service disables it, since `docker compose run` would inherit it.

### Deploys, liveness and readiness

- **Stop-before-start:** a deploy restarts the network's facilitator unit, which stops the old
  container and only then starts the new one. Postgres keeps running, and the migrations have
  already run (Store).
  - Docker sends SIGTERM and waits `stop_grace_period` before SIGKILL.
  - The lease, not the ordering, guarantees one owner (AD-17). A process that finds the lease
    taken waits for it and never exits for lack of it.
- **`GET /health` is liveness only.** It answers 200 while the HTTP server is up and checks nothing
  else: not the lease, the RPC or the store. Its body reports `ready`. The container healthcheck
  calls it every 10 s.
- **Ready to settle** means the process holds the lease and has finished the AD-16 startup
  reconciliation, which runs after the lease is taken.
  - Until then, `/settle` answers 503 at once instead of hanging.
  - A process without the lease keeps trying to take it.
  - A process whose lease renewal fails stops new submissions until it holds the lease again.
- **The deploy's last step waits up to 120 s for `ready: true`.** Without it, the deploy rolls
  back to the previous digest and fails the run (below). A "ready to settle" metric also has an
  alarm (0027).

### Timing

One request or one stop must never outlast the layer in front of it:

| Setting                           | Value              | Why                                                                |
| --------------------------------- | ------------------ | ------------------------------------------------------------------ |
| Seller's facilitator client       | 90 s               | `@x402/core`'s `HTTPFacilitatorClient`; started before the request |
| `/settle` response budget         | 30 s, at most 80 s | well below the seller's 90 s, so our answer reaches it             |
| `/settle` checks                  | see below          | inside the budget: past it, `…_timeout` and nothing is claimed     |
| Repeat wait (`SETTLE_TIMEOUT_MS`) | 20 s, ≤ the budget | and never past the repeat's own budget                             |
| `stop_grace_period`               | 180 s              | sent submissions (≤ 90 s) plus a 90 s margin                       |
| Cloudflare's response limit       | 100 s              | above the 80 s cap; past it Cloudflare answers 524                 |
| Node `keepAliveTimeout`           | 125 s              | above `cloudflared`'s idle keep-alive (90 s), or it sees 502s      |
| Container healthcheck             | 10 s               | liveness only                                                      |
| `LEASE_TTL_MS`                    | 30 s               | after a crash, a new process waits at most this long               |
| Wait for `ready: true`            | 120 s              | past it, the deploy rolls back to the previous digest              |
| Unit `TimeoutStopSec`             | 200 s              | above `stop_grace_period`, so a reboot waits for the drain         |
| Unit `TimeoutStartSec`            | 60 s               | covers `ExecStartPre` only: credentials and the digest, no pull    |
| Postgres `stop_grace_period`      | 120 s              | a clean shutdown; the Compose default is 10 s                      |
| `x402-db@` `TimeoutStopSec`       | 150 s              | above Postgres's 120 s, so a reboot doesn't kill it                |

- **Past the budget,** `/settle` answers `settlement_pending` with the hash if one was signed,
  and nothing new is signed after it. If nothing was signed, the record ends and the answer is
  `settle_exact_stellar_timeout`: the client signs a new payment. 30 s fits 97 % of the
  settlements measured in task 0043. Every store and hook call is bounded by what is left of it,
  plus the store's 1 s grace for each of the last store calls: a repeat's last poll read, its end
  of the record and its success mark, so up to the poll interval plus 3 s past the budget (3.46 s
  measured past a 1 s budget). Still below the seller's 90 s at the 80 s cap.
- **The checks run inside the budget.** They are upstream verify plus the AD-22 ledger read,
  which `FallbackRpc` bounds at 10 s per RPC URL. Their worst case:

  | `RPC_URLS`, bid                   | Upstream verify  | Ledger read  | Worst check            |
  | --------------------------------- | ---------------- | ------------ | ---------------------- |
  | before 0045, any                  | 10 s (first URL) | 10 s per URL | 20 s (1 URL), 30 s (2) |
  | 0045, 2 URLs, fixed bid           | 21 s             | 20 s         | 41 s                   |
  | 0045, 2 URLs, fee-stats bid       | 41 s             | 20 s         | 61 s                   |
  | 0045, 3 URLs (its cap), fee-stats | 61 s             | 30 s         | 91 s                   |

  Upstream verify after 0045 is 10 s per URL, twice that with a fee-stats bid (the read before
  the URLs), plus 1 s. Past the budget the answer is `…_timeout` before the claim, so the same
  payment may be sent again; a valid payment can still get it when the first URLs hang and the
  last one answers late. These worst cases need hung RPC URLs, not slow ones.

- **Known cost of "nothing sent → `rejected`".** The resource is usually served before `/settle`.
  After a failure before anything was signed (no channel, the budget, the simulation, the RPCs
  down), the record ends and the same payload can't be settled again: only the buyer can pay, by
  signing a new payment, and nothing makes them. Claiming such a record again by the same
  fingerprint would close it; it is not planned.
- **The budget covers the wait for a channel.** The pool's own bounds (60 s + 30 s) start only
  once a channel is acquired, so the `/settle` handler passes the pool a deadline (0009).
- **On SIGTERM the facilitator stops taking `/settle` itself** (503), refuses at once every call
  not yet signed and sent, lets only sent ones finish, and drains (0025). `cloudflared` has no
  deregistration step, so it keeps forwarding until the container is gone and answers 502 while
  it is down.

### Image and deploy workflow

- **`apps/facilitator/Dockerfile`**, multi-stage:
  - the build stage installs with pnpm, builds the workspace and runs `pnpm deploy --prod`. That
    needs `injectWorkspacePackages: true` in `pnpm-workspace.yaml` (pnpm 10 and later; checked
    with 11.5.2: workspace packages stay symlinked in dev, and the deploy output gets its own
    lockfile);
  - `pnpm deploy` copies the whole package directory, so `apps/facilitator/package.json` gets
    `"files": ["dist"]` and the repo a `.dockerignore` that excludes `.env*`;
  - the runtime stage is `node:22-slim` pinned by digest, `linux/amd64`, runs as `node`, with a
    read-only root filesystem and `CMD ["node", "dist/server.js"]`. Node is PID 1 and handles
    SIGTERM itself (`src/server.ts`).
- **Images go to GitHub Container Registry,** tagged with the git SHA. The workflow skips the
  build when the SHA is already there. The image is public, so the server needs no registry
  credential.
- **Mainnet is promoted by digest.** A successful testnet deploy records its digest and SHA as a
  GitHub Deployment in the `testnet` environment. The mainnet workflow takes a digest, never a
  SHA or a tag, and refuses one without a successful `testnet` deployment: a rebase merge into
  `deploy/testnet` gives new SHAs, and a tag can point at a commit whose image never ran on
  testnet.
- **GitHub Actions deploys over SSH:**
  - GitHub-hosted runners reach the server's SSH port, which the server's setup already opens to
    the internet, with key-only logins and fail2ban. There is no allowlist, since GitHub's address
    ranges change, and the workflow pins the server's host key in `known_hosts`. A self-hosted
    runner on the server would run workflow code next to ClickHouse and is rejected; a tunnel is
    a mainnet option (0038).
  - It logs in as a deploy user with one key per network, and each key's `authorized_keys` entry
    fixes its network: `command="/srv/x402/testnet/deploy.sh",restrict` for the testnet key,
    `/srv/x402/mainnet/deploy.sh` for the mainnet key. The script reads only an image digest from
    `SSH_ORIGINAL_COMMAND` and refuses anything but `sha256:` and 64 hex digits.
  - The deploy user isn't in the `docker` group. It may write the networks' `digest.next` files
    and run one command through `sudo`, `systemctl start x402-deploy@<network>`. Both networks
    share the user, so it can write either network's file: the forced command is what keeps each
    key to its network. A user per network is a mainnet option (0038).
  - **The deploy itself is a unit, `x402-deploy@<network>.service`** (a oneshot, as root), so a
    cancelled job or a dropped runner can't cut it between stopping the old facilitator and
    starting the new one. `deploy.sh` checks the digest, then, holding a `flock` on `digest.next`,
    writes it and starts the unit. `systemctl start` waits for the unit, so the job still gets
    the result, and a second deploy waits for the lock instead of joining the running job with
    another digest. The unit takes no lock of its own, which would deadlock, and a deploy by
    hand goes through `deploy.sh` too (runbook).
  - The deploy unit decrypts the network's credentials with the script `x402@`'s `ExecStartPre`
    uses, since the migration needs the database password before `x402@` has ever run (the
    first deploy). It pulls the new image and runs the migration service from it while the old
    facilitator still serves (ADR 0012). A failed migration fails the deploy and leaves the old
    facilitator serving; nothing needs rolling back. Then it moves the new digest into `digest`,
    restarts `x402@<network>` and waits up to 120 s for `ready: true`, read with `docker exec`
    and the healthcheck's Node one-liner, so the check depends on neither the tunnel nor DNS.
  - Only after `ready: true` does it write the digest to `digest.good` and remove images other
    than this one and the previous good one, since the disk is shared. If the restart fails or
    `ready` doesn't come, it puts `digest.good` back into `digest`, restarts again and fails.
  - The first deploy has no `digest.good`, so it fails into the alarms. When `ready` fails
    because of a dependency (OpenBao sealed, the RPCs down), the previous image isn't ready
    either: the deploy fails, the facilitator stays down, and the not-ready and uptime alarms
    fire.
  - Migrating before the stop and that rollback are both safe because `migrate()` applies all
    pending migrations in one transaction, so a failed run leaves the schema as it was, and
    expand/contract keeps the older image working on a schema that did move forward. If
    `lock_timeout` hits, the deploy fails before anything was stopped.
  - **`x402@<network>.service` owns the facilitator.** Its `ExecStartPre` decrypts the network's
    credentials (below) and, unless a deploy is running (a marker in `/run/x402/<network>/`,
    which a reboot clears), puts `digest.good` into `digest`, so a reboot during a deploy starts
    the last image that was ready. It neither pulls nor migrates: `ExecStart` runs Compose in
    the foreground for the facilitator only (`--no-deps`), from the image the deploy pulled, with
    `Restart=on-failure`, and `ExecStop` stops it, which gives it its `stop_grace_period`. It
    wants and runs after `x402-openbao.service`, though it starts without OpenBao (ADR 0013).
  - **`x402-tunnel@<network>.service` owns `cloudflared`.** It decrypts the tunnel token itself,
    as OpenBao's unit does, and is enabled at boot. `x402@` runs after it, so at a reboot the
    tunnel stops last and answers reach the clients while the facilitator drains.
  - **`x402-db@<network>.service` owns Postgres.** It decrypts its own credentials with the same
    script, since it starts first at boot, and its `TimeoutStopSec` of 150 s is above Postgres's
    120 s grace. The facilitator's unit requires it and runs after it, so at a reboot the
    facilitator drains while the database is still up. Both are enabled at boot.
  - **Every unit that runs a container is `PartOf=docker.service` and runs after it.** A
    Docker restart, such as a `docker-ce` upgrade, first stops them through their own
    `ExecStop`, so the facilitator drains with its full grace instead of `dockerd`'s 15 s, and
    starts them again afterwards.
  - Testnet deploys on a push to `deploy/testnet` unless only `lore/**`, `docs/**` or Markdown
    files changed, or by hand. A deploy is a pull request from `develop` to `deploy/testnet`.
    `develop` stays open for direct pushes such as lore status changes.
  - Mainnet deploys by hand from a `v*` tag, through the `mainnet` environment with required
    reviewers, with the digest testnet recorded (above).
  - The SSH key is an environment secret, one per network, and each environment carries the
    rules the OIDC trust policy used to:
    - `testnet`: deployment branches limited to `deploy/testnet`, which is protected: a pull
      request with an approving review, and no bypass, admins included. The workflow runs as it
      is on that branch, so a change to it is reviewed too;
    - `mainnet`: deployment tags limited to `v*`, required reviewers, and "Prevent self-review",
      so the person who starts a deploy can't approve it. Whether admins may bypass the
      reviewers is decided with 0038.
    - A job outside those rules never gets the key.
    - All four of us are repo admins, and an admin can switch the protection off. It stops
      unreviewed and accidental changes, not a deliberate admin, whose change stays in the
      repo's audit log.
  - One deploy runs at a time per network: a `concurrency` group with `cancel-in-progress: false`,
    so a newer push waits instead of cancelling a deploy in progress.
  - Every action is pinned to a commit SHA, and the workflow sets `permissions: {}` and grants
    only what each job needs.
  - Before mainnet (0038): a ruleset that protects `v*` tags, since the workflow at the tag runs
    with the mainnet key; a mainnet `deploy.sh` that itself refuses a digest without a testnet
    deployment, since today only the workflow checks it; named reviewers; and who may edit the
    environments.
- **Rollback** redeploys an earlier digest through the same workflow; a failed deploy rolls back
  by itself (above).
- **The compose files and the deploy scripts live in `deploy/`.** The SSH key can only send a
  digest, so an operator copies them to `/srv/x402/<network>/` by hand from a reviewed commit
  (runbook). Whoever writes these files is the real boundary between the networks.

### Network and URL

- **Cloudflare is the DNS and the edge, through Cloudflare Tunnel.** The hostnames are
  `x402-facilitator-testnet.sorobanscan.com` and `x402-facilitator.sorobanscan.com`, one label
  under the zone, since the Free plan's certificate covers only one level of subdomain.
  - Each network has its own tunnel. Its `cloudflared` opens outbound connections to Cloudflare
    (port 7844) and forwards its hostname to `http://facilitator-<network>:<port>`; anything
    else gets 404. The server opens no port for it.
  - HTTPS ends at Cloudflare, so Cloudflare sees the requests in plain text. They carry signed
    payments, never keys.
  - The tunnel, its routing and the DNS record are Terraform in the `soroban-infrastructure`
    repo's `cloudflare/`, beside the `sorobanscan.com` zone, so routing changes are reviewed
    there. The tunnel token is kept nowhere else: an operator fetches it from Cloudflare (the
    dashboard, the API or `terraform output`) into an encrypted systemd credential (runbook),
    also when the server is restored elsewhere.
  - Caddy and the ClickHouse project's repo are not involved.
- **The client IP is `CF-Connecting-IP`** (AD-11), which Cloudflare sets on every request. Only
  `cloudflared` reaches the facilitator, so a client can't forge it, and `X-Forwarded-For` is
  ignored (0023).
- **Edge rate limiting:** the Free plan allows one rate-limit rule per zone, shared with
  sorobanscan and the Prices API, so the in-app limits (AD-11, AD-18) carry the load. Mainnet
  revisits this (0038).

### Keys, secrets and access

- **The facilitator key lives in OpenBao Transit on this server,** as ADR 0013 decides (task
  0047). The facilitator signs through it behind the pool's `TransactionSigner`, so the raw key
  never reaches the facilitator's process, the image or the logs. The signer is 0036; the OpenBao
  container, its unseal, snapshots and restore drill are part of 0026.
- **The server reaches AWS only for logs and metrics, through IAM Roles Anywhere.**
  - A certificate on the server gets short-lived credentials, and no long-lived AWS keys are
    stored there.
  - The trust anchor is the ClickHouse project's existing client-certificate CA, so there is no
    CA of our own to run or pay for. The role's trust policy accepts only our server
    certificate's CN, which isn't on the ClickHouse site's allowlist, so the certificate opens
    nothing else. It is valid for a year and Platform renews it by hand; 0027 alarms 30 days
    before it expires. That project tells us when it rotates its CA, since our trust anchor
    changes with it. Anyone with that CA's key can issue our CN, which is accepted at a logging
    role's stakes.
  - The role may only write the facilitator's log groups and metrics, only from the server's IP.
    It can't sign or read secrets, the OpenBao backup secret included.
  - There is one logging role for both networks, and only the CloudWatch agent on the host holds
    its credentials: no container and not `dockerd`. Either network's logs can be written with
    it; nothing can be signed or read. Per-network separation is for signing, and OpenBao
    provides it (ADR 0013).
  - It is the only AWS credential on the server; ADR 0013 names it as the exception to "no AWS
    credentials".
- **`FACILITATOR_SECRET` stays for local development and tests.** Deployed networks use the OpenBao
  signer instead.
- **Other secrets are encrypted systemd credentials,** as in ADR 0013: the database password, an
  RPC URL that carries an API key, and the tunnel token.
  - `systemd-creds` keeps them encrypted on disk with the host key. Each network's units decrypt
    their own, in `x402@`'s `ExecStartPre` and in the deploy unit before it migrates, to
    `/run/x402/<network>/` (tmpfs, mode 0700), and Compose mounts them as `file:` secrets, so
    they are plain only in memory. Outside swarm those are bind mounts that keep the host's
    owner and mode, so each file is written mode 0400 for the user of the container that reads
    it: `node` (uid 1000) for the facilitator's, `postgres` (uid 999) for Postgres's password.
    0026 lists them per file. OpenBao's unit (`x402-openbao.service`) does the same with its
    unseal credential.
  - They stay there until a reboot, so Docker's crash restart and the watchdog still find them.
    At boot the unit writes them again before it starts anything.
  - The app reads them from files (`DATABASE_URL_FILE`, `RPC_URLS_FILE` and the AppRole files),
    a config change in 0026.
  - They never go into the image, the repo or the logs, and never into `environment:`, which
    `docker inspect` shows in plain text.
- **Rotating the key is an on-chain change.** AD-12 makes the facilitator key the only signer of
  every channel. Rotation means:
  1. stop the service;
  2. with the old key, create the new key's own account, make the new key the signer of every
     channel, and merge the old fee account into the new one (the pool pays from the signer's
     address, so the fee account is the key's own account);
  3. point the config at the new key;
  4. start the service.

  The runbook (0026) also covers the compromised-key case.

### Store

- **PostgreSQL in a container per network, on the same server.** It holds the schema and adapter
  rules of [ADR 0012](0012-facilitator-state-store.md).
- **Sizing:** about 2–4 KB per payment. That is under 1 GB on testnet and about 1 GB a month on
  mainnet at 10,000 payments a day. `pg_wal` stays small, since each segment leaves as it closes
  (below) and Postgres recycles it.
- **Backups leave the server with pgBackRest,** on testnet as on mainnet:
  - Postgres hands each WAL segment to pgBackRest (`archive_command`, `archive-async`), which
    compresses, encrypts and pushes it at once. `archive_timeout` stays 60 s, so a hardware fault
    loses about a minute. The lease writes WAL every few seconds, so a mostly empty 16 MB segment
    closes every minute; compressed, it costs little, and nothing piles up on the server's disk;
  - a systemd timer takes a daily backup (`pgbackrest backup`);
  - the repository is of type `sftp`, on our own sub-account on the company's existing Hetzner
    Storage Box, the box ADR 0013 uses for OpenBao's snapshots: `pgbackrest/` beside Borg's
    `openbao/`, kept 14 days;
  - it is encrypted. Its passphrase and the Storage Box SSH key are encrypted systemd
    credentials on the server, and the passphrase is also kept in AWS Secrets Manager beside
    ADR 0013's backup secret, since the box belongs to another project and the server's only AWS
    role can't read secrets;
  - how the database reaches the box, a second network for Postgres or pgBackRest on the host, is
    settled in 0026;
  - an S3 bucket in the company AWS account is the fallback. Using it needs its own named,
    write-only role, never the logging role;
  - a restore drill, with `pgbackrest check` and `pgbackrest verify`, runs on testnet before
    mainnet, and 0038 sets mainnet's targets for downtime and data loss.
- **The migrations** run from the new image before the old facilitator stops, in the deploy unit
  (ADR 0012), so they add nothing to the deploy's downtime. Every migration is expand/contract, so
  the running image, and a rollback to an earlier one, work on the newer schema. A long one, such
  as an index build on a big table,
  runs outside the deploy as a planned step (`CREATE INDEX CONCURRENTLY`), so a deploy's
  migrations stay short. The migration service gets its own bounds, longer than the app pool's
  10 s statement timeout (0026).
- **No TLS to the database.** The connection stays on the network's `internal` Docker network on
  one host, and anyone who could read it there could read the database files. PostgreSQL uses
  `scram-sha-256` passwords, never `trust`. TLS comes back if the database ever leaves the host.
- **ClickHouse is not the store.** It is an analytics database: no enforced unique keys, no
  conditional updates and no transactions, so it can't guarantee AD-6's exactly-once claim. It may
  later hold payment analytics fed from PostgreSQL.

### Logs, metrics and alerts

- **Logs:** the 0017 `jsonLogger` stays.
  - Its JSON lines go to stdout, and Docker keeps them on the host (`json-file`, rotated). The
    CloudWatch agent sends our containers' logs to CloudWatch Logs with the logging role's
    credentials, so `dockerd` stays untouched and an AWS outage never stops a container from
    starting. The log group uses the Standard class, with 30-day retention on testnet.
  - How the agent picks only our containers, and that EMF lines turn into metrics, is checked
    in 0027.
  - No pino: stdout is the only transport, and the logger already writes identifiers only.
- **RPC endpoints are logged as `RPC_URLS[i]#<fingerprint>`, never by URL or host.** An RPC URL
  can carry an API key, and a host can be an account's own endpoint name (some providers put one
  in the subdomain) or an internal one. The fingerprint is the first 8 hex digits of the entry's
  SHA-256, so a line written before `RPC_URLS` changed can't be read as today's `RPC_URLS[i]`;
  `printf %s "$url" | sha256sum | cut -c1-8` matches it to a URL. The hash is unsalted: it keeps
  a long API key out of the logs, but anyone holding a log can confirm a guessed URL with few
  unknowns, such as a provider host named after the company, in seconds. We accept that: the logs
  are ours, and an HMAC would need one more secret per deployment while key custody (0047) is
  open. Upstream verify's failover logs
  its switches with these names (0045). In an error message, the logger names a URL on an
  `RPC_URLS` entry the same way and reduces any other URL to its host; an entry's bare host, as
  Node's network errors give it (`getaddrinfo ENOTFOUND <host>`), is named too. signer-pool's `FallbackRpc.fromUrls` still names endpoints by the full URL and logs no
  switches (0049, 0027).
- **Metrics:** a metrics adapter (0027) writes CloudWatch Embedded Metric Format lines to stdout,
  which CloudWatch turns into metrics.
  - Namespace `x402-facilitator`.
  - Dimensions stay low-cardinality: `network`, route, outcome, event name.
  - Never payer or `payTo`: each dimension combination is a billed custom metric.
- **Host metrics:** the CloudWatch agent on the server reports memory, CPU and free disk, since
  ClickHouse shares the machine.
- **Alerts:** CloudWatch alarms go to an SNS topic, and Amazon Q Developer in chat applications
  (formerly AWS Chatbot) posts them to the team's Slack channel. 0027 defines them:
  - the five AD-18 conditions; the low-balance one fires below 25 XLM of spendable balance
    (ADR 0013);
  - not ready to settle (the counterpart of the lease-blind `/health`);
  - from ADR 0013: OpenBao sealed, down or failing to sign; theft (a transaction on the fee
    account or a channel that our submitter didn't send, or a signer or threshold change on them,
    read from Horizon off the server); and OpenBao's audit log disk at 80%;
  - WAL archiving failing (`pg_stat_archiver.failed_count` rising, or the last archived segment
    older than 10 minutes). pgBackRest acknowledges a segment only once it is in the
    repository, so this one alarm covers a stuck archive, which fills a disk ClickHouse shares,
    and WAL that doesn't leave the server;
  - the last `pgbackrest backup` or the last OpenBao snapshot older than 26 hours (both run
    daily);
  - the Roles Anywhere certificate expiring within 30 days;
  - low free disk and memory on the server.
- **Uptime:** a Route 53 HTTPS health check on the public URL.
  - Route 53 publishes its metrics only in us-east-1, so the alarm and its SNS topic live there.
  - It fires after 7 failing minutes in a row, above the worst successful deploy
    (Consequences). A failed deploy that rolls back can take longer and should alarm; it also
    fails the workflow.
  - It checks `/supported` once 0020 makes it real, and `/health` before that.
  - The 99% figure counts a minute as up only when the check passes and the facilitator is ready
    to settle.

## Rationale

- **The capacity is already paid for.** The server has a lot of free RAM and disk, and our
  containers are limited to 1.875 GiB on testnet and 3.5 GiB with both networks. Running there
  costs about €0 more, against about $60–70 a month on testnet and $150 on mainnet for ECS
  Fargate.
- **It meets both hard rules.** Compose stops the old container first, and the grace period has no
  platform cap, so 180 s covers the drain with room to spare.
- **The alerting design carries over:** the same logger, the same EMF metrics, CloudWatch alarms
  and Slack.
- **Docker is already on the server,** and the company already runs sorobanscan's API behind
  Cloudflare.
- **The tunnel needs nothing from the ClickHouse project:** no site block in its Caddy, no
  network created before its deploy, and no inbound port on the server.

## Alternatives considered

- **ECS Fargate in the company AWS account.** This was the first version of this ADR.
  - What it gives: managed patching and task replacement, managed PostgreSQL (RDS) with backups
    and failover, and a path to two tasks in two zones.
  - What it costs: about $60–70 a month on testnet and $150 on mainnet, and a 120 s cap on the
    drain.
  - Rejected because the company server already has the room.
  - It stays the migration path: the image, the stop-first design and CloudWatch move over
    unchanged.
- **A separate small Hetzner Cloud VM,** which would isolate the facilitator from the production
  ClickHouse server. What the shared server couples, and what a VM of our own would change:

  | On the shared server                                           | On a VM of our own                                           |
  | -------------------------------------------------------------- | ------------------------------------------------------------ |
  | one `dockerd`: restarting Docker touches ClickHouse            | our own `dockerd`                                            |
  | one disk: `pg_wal` growth and logs                             | our own disk                                                 |
  | reboots and patching are shared, and their owner is open       | we patch on our schedule                                     |
  | root on that server, for any project, can copy the OpenBao key | only the VM's root                                           |
  | testnet code runs on the production ClickHouse server          | it runs on the VM only                                       |
  | GitHub runners SSH into the production ClickHouse server       | they SSH into the VM only                                    |
  | a hardware fault waits for that server's repair                | a new VM is restored from a Hetzner Cloud backup or snapshot |
  - What it costs: about €12–20 a month on testnet (CPX12 to CPX22 after Hetzner's 2026 price
    rises, from task 0047's `notes/R-openbao-on-hetzner.md`), more with mainnet, and the VM's
    system, Docker and proxy are ours to run.
  - Not chosen, for testnet or mainnet (decided 2026-10-23): the shared server has the room,
    limits contain the contention, and the coupling above is accepted knowingly. It stays the
    first step if isolation becomes a concern.

- **Fly.io, Render, Railway, Google Cloud Run, AWS App Runner, ECS Express Mode, Lightsail, EKS,
  Lambda.** Compared in task 0014: they overlap deploys, cap the drain too low, cost more, or run
  no long-lived process.
- **Step Functions with Lambda:** a workflow per payment, with channel state in the database.
  Rejected:
  - `signer-pool` keeps each channel's sequence number, the queue and the next prepared
    transaction in one process's memory. Moving that into the database with a lock per payment
    means rewriting it, changes AD-2, AD-16, AD-17 and AD-22, and loses pipelining (50 → 64 per
    ledger at 90 channels, ADR 0003).
  - Lambdas need RDS Proxy, and every workflow step is billed.

  It still fits side jobs, such as topping up the fee balance and rebuilding channels after a
  testnet reset.

- **The server's Caddy, in the ClickHouse project,** as the edge and reverse proxy, with an
  A record in Route 53 (`testnet.x402.rumblefish.dev`). This was this section until 2026-10-22.
  Rejected: our site block would live in that project's repo and deploy, a deploy there that
  recreates Caddy without it takes the facilitator offline, and the edge networks would have to
  exist before that project's deploy. The company is also moving sorobanscan to Cloudflare.
- **Cloudflare's proxy in front of that Caddy:** Cloudflare as the edge, Caddy as the reverse
  proxy behind it. It keeps the Caddy coupling, and needs an origin lock (Authenticated Origin
  Pulls in our site block), since the server's address is already public under ClickHouse's own
  name.
- **ClickHouse as the store.** Rejected; see Store.
- **Key custody** (AWS KMS, a key file, OpenBao and others): compared in ADR 0013 (task 0047).
- **Grafana Cloud Free for metrics and alerts.** $0, but a second vendor whose alert rules sit
  outside our config. CloudWatch is kept.

## Consequences

- **The facilitator shares a production server with ClickHouse.**
  - Memory and CPU limits on our containers, and ClickHouse's own memory limit, keep them apart.
  - Maintenance couples them: a reboot for a kernel update restarts both. Our units run after
    `docker.service`, so systemd stops them first, the facilitator before Postgres, and the
    facilitator unit's `TimeoutStopSec` of 200 s covers the drain, where `docker.service` itself
    gets 90 s. The shared `daemon.json` stays as it is. A reboot takes up to about 3 minutes
    longer, and so does a Docker restart, such as a `docker-ce` upgrade, since our units drain
    first; ClickHouse's own downtime doesn't change.
  - Patching needs an owner and a schedule, which the team decides.
- **Cloudflare and `soroban-infrastructure` are dependencies instead.**
  - The tunnel, its routing and the DNS record live in another repo, applied with a Cloudflare API
    token by that repo's operator (stkrolikiewicz for now), so renaming the facilitator's service
    or port is a pull request there.
  - Cloudflare's Free plan has no uptime SLA, and an outage there takes the facilitator off the
    internet; the uptime alarm catches it. A paid plan is a mainnet question (0038).
  - The server must allow outbound connections to Cloudflare on port 7844.
- **It is one physical machine.** A hardware fault takes the facilitator down until the server is
  repaired or the service is restored elsewhere from the off-server backups, which can take hours.
  Restoring elsewhere is a runbook step (0026) and a mainnet risk (0038).
- **Operations are ours:** Docker and OS updates, PostgreSQL upgrades, backups and restore drills,
  and `cloudflared` upgrades.
- **Deploy downtime is usually under a minute:** a quick drain when idle, a container start, and
  reconciliation; the pull and the migrations run before the stop. At worst it is about 5
  minutes: a 180 s drain and up to 120 s for `ready: true`. The uptime alarm waits 7 failing
  minutes for that reason.
- **After a crash,** Docker restarts the container (`on-failure`). The new process waits up to
  30 s for the lease and reconciles. Records keep each transaction's time bound, so a hash that
  can't be found yet stays non-final until that bound passes (0019).
- **The OpenBao signer (0036, ADR 0013) blocks the testnet deploy (0026).**
- **ADR 0012's store moves from RDS to a container on the server.** Its schema, adapter rules and
  migrations are unchanged; managed backups and failover become ours (task 0013).
- **0026 builds:**
  - the Dockerfile, the compose files and the deploy script;
  - the systemd units: `x402@<network>`, `x402-db@<network>`, `x402-deploy@<network>`,
    `x402-tunnel@<network>`, `x402-openbao`, the restart timer and the backup timer;
  - the `cloudflared` container, with the tunnel token fetched from Cloudflare into a systemd
    credential. The tunnel, its routing and the DNS record come from
    `soroban-infrastructure`, after the `sorobanscan.com` zone is on Cloudflare;
  - the deploy user, its one `sudo` rule, the SSH forced command, the workflow with the pinned
    host key, and the `deploy/testnet` branch with its protection;
  - the OpenBao container (ADR 0013), the IAM Roles Anywhere logging role and its certificate,
    and the secret files;
  - the backups (pgBackRest to the Storage Box);
  - `GET /health` with `ready`, the Node keep-alive setting, and the migration bounds;
  - the config reading secrets from files (`*_FILE`), since nothing reads them today;
  - the runbook: deploy, rollback, key rotation, certificate renewal, restore on another machine.
- **0027 builds:** log shipping through the CloudWatch agent, the EMF adapter, the alarms above,
  the us-east-1 uptime stack and the Slack integration.
- **0023 keys the limiter on `CF-Connecting-IP`** as above.
- **Cost:**
  - The server adds nothing.
  - CloudWatch logs, metrics and alarms, and the health check, come to a few dollars.
  - Off-server backups go to the existing Storage Box and add nothing.
- **Mainnet availability is open** (0038). It needs to settle:
  - the targets for the longest downtime and the most data lost after a hardware fault;
  - two facilitator containers with separate channel sets on this server, which give deploys
    without downtime but no protection from hardware faults;
  - a second machine or a standby;
  - edge rate limiting, and whether mainnet needs a paid Cloudflare plan for its uptime SLA.
- **Slack is not a pager.** On mainnet, the alerts that cost money (breaker open, low balance,
  pending settlements) also need a phone or SMS route.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-1, AD-6, AD-11, AD-12, AD-15, AD-16,
  AD-17, AD-18
- [ADR 0009](0009-conformance-gate-harness.md): the gate needs the public URL
- [ADR 0012](0012-facilitator-state-store.md): the PostgreSQL store
- Task 0014 notes (`0014_RESEARCH_facilitator-hosting/notes/`): the requirements, the platform
  research and the comparison behind the first version
- Task 0039: the move to the Hetzner server
- ADR 0013 (task 0047, in review): the facilitator key in OpenBao Transit
- [IAM Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html),
  [CloudWatch agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html),
  [Compose `stop_grace_period`](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)
