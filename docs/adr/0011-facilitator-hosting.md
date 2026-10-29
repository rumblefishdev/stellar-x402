# ADR 0011: Host the facilitator on the company Hetzner server

- Status: accepted; key custody superseded by [ADR 0013](0013-facilitator-key-custody.md)
- Date: 2026-10-09, amended 2026-10-15 (task 0009: the `/settle` budget is 30 s, below the
  seller's own 90 s timeout), 2026-10-16 (task 0009: the checks are inside the budget; RPC
  endpoints are logged as `RPC_URLS[i]`) and 2026-10-20 (task 0009: `RPC_URLS[i]#<fingerprint>`
  and the fingerprint's limit; how far a repeat runs past the budget), 2026-10-21 (task 0009:
  bare RPC hosts in error messages), 2026-10-27 (task 0019: reconciliation runs in every
  process, independent of the lease; `/health` reports `listed` beside `ready`, and the deploy
  waits for both) and 2026-10-28 (task 0076: one hostname and one facilitator service for both
  networks)
- Revised: 2026-10-13. ECS Fargate became the company Hetzner server (task 0039); the first
  version is in git history and task 0014. 2026-10-21: the key moved to OpenBao (ADR 0013), and
  deploys, reboots, backups, alarms and downtime were worked out in the PR #24 review.
  2026-10-22: pgBackRest for Postgres, migrations before the old facilitator stops, mainnet
  promoted by a recorded digest, and the Hetzner Cloud VM weighed on its coupling (third round);
  the facilitator is reached through Cloudflare Tunnel on `sorobanscan.com` instead of the
  server's Caddy. 2026-10-23: the third round's last threads (units restart with Docker, the
  deploy lock, `digest.good`, the units' timeouts, secret file owners, encryption at rest), and
  an Ansible playbook that provisions x402's parts of the server. Round four: Compose's exit
  code, a crash loop at startup, the tunnel token's owner, and the VM left open for mainnet.
  2026-10-27: a long migration runs in the deploy as an online one, under the deploy unit's
  60-minute cap (task 0067).
  2026-10-28: one facilitator for both networks in one `production` environment, with a database
  per network (task 0077); the per-network layout before it is in git history.

## Context

`apps/facilitator` is the only deployable service (AD-1): one Node 22 process that serves every
network it is configured for, with a channel pool per network, and holds `/verify`, `/settle`,
`/supported` and `/discovery/resources`. The code still serves one network per process (`NETWORK`)
until 0077 changes it. The Tranche 1 gate needs it at a public HTTPS testnet URL (AD-15,
ADR 0009); mainnet follows in a later tranche, in the same process, with a 99% uptime target.

The host must:

- **keep the process running.** The pool does background work between requests, so no
  scale-to-zero and no idle CPU throttling;
- **stop the old process before the new one starts.** One process owns a channel set through a
  store lease, so deploys can't overlap (AD-17);
- **give 180 s after SIGTERM** (`stop_grace_period`). The process drains in-flight submissions
  for at most 150 s, leaving the rest for its store writes and the lease release. Since 0073 a
  sent one can stay valid until the payer's auth expires (`MAX_VALIDITY_LEDGERS`: 66 ledgers by default, about 5.5 minutes; at most 120, about 10 minutes). The pool waits for it until that bound's estimated time at 6 s a ledger plus
  `confirmGraceSeconds` 30, about 426 s by default and 750 s at 120, so it can outlast the drain. One still open at 150 s is finished by
  the next process's reconciliation, and until it lands or expires the next process's sends on
  its channel may fail with `txBadSeq` and rebuild, for minutes rather than about 60 s. Accepted
  for testnet; before pubnet the next process leaves such a channel out (0090);
- **keep the facilitator key out of the image, the logs and the facilitator's process** (AD-12);
- **offer a durable store** for the PostgreSQL schema of ADR 0012.

The company already runs a Hetzner dedicated server for its production ClickHouse:

- x86_64, with plenty of free CPU, RAM and disk, and ClickHouse held to a memory limit in its
  container;
- Docker Compose, and Caddy already terminates HTTPS for ClickHouse's mutual-TLS endpoint, in the
  same compose project as ClickHouse.

Our containers are limited to 1.875 GiB of RAM with OpenBao while production serves testnet, and
2.875 GiB once mainnet's database joins; on testnet they need about 2 GB of disk, WAL included.
The company bought `sorobanscan.com` for sorobanscan and the Stellar Prices API and moves it, as
a whole zone, to Cloudflare on the Free plan.

## Decision

### Platform and containers

- **Docker Compose on the company Hetzner server, in one environment, `production`,** which
  serves testnet now and mainnet later, in one facilitator. A staging environment may come later
  (0038); nothing below needs renaming for it.
  - Our files live in `/srv/x402`, outside the ClickHouse project's directory, which that
    project's deploy overwrites, and are owned by our own Linux user, `x402`.
  - Each environment has its own directory, `/srv/x402/<environment>/` (today
    `/srv/x402/production/`), with its compose file, deploy script, `digest` file and encrypted
    credentials, and is its own Compose project, `x402-<environment>`, separate from ClickHouse's
    `app` project. OpenBao has `/srv/x402/openbao/` and its own project, `x402-openbao`.
  - Nothing else is there apart from the data volumes.
- **Per environment, a facilitator, a tunnel connector, and a database and a migration service
  per network:**
  - `facilitator`, memory limit 512 MiB and one CPU while it serves testnet; mainnet's channel
    pool may need more (0038);
  - `cloudflared`, Cloudflare's tunnel connector pinned by digest, memory limit 128 MiB. It has a
    unit of its own (below), so a deploy never restarts it and it keeps forwarding while the
    facilitator drains;
  - `postgres-<network>` (today `postgres-testnet`), PostgreSQL 18 pinned by digest, memory limit
    1 GiB, data on a volume on the server's RAID. It has a unit of its own (below), so a
    facilitator deploy never restarts it;
  - `migrate-<network>`, a one-off service of the facilitator image that runs that network's
    migrations, with its healthcheck disabled and a 512 MiB limit, left out of the totals since
    it runs only during a deploy. It is in the `migrate` profile, so `docker compose up` never
    starts it.
- **One OpenBao container for both networks** (ADR 0013), pinned by digest, memory limit 256 MiB
  and half a CPU.
  - Each network keeps its own listener socket in its own volume, and its own key and policy.
    The facilitator mounts the socket of every network it serves, as external volumes from
    OpenBao's project, so one process can sign for both networks. ADR 0013's reasons for a
    socket per facilitator are revisited in 0077.
- **The limits add up to 1.625 GiB for production with testnet's database,** 1.875 GiB with
  OpenBao; mainnet's database adds 1 GiB. They are ceilings; testnet uses less.
- **Testnet and mainnet share the facilitator process and OpenBao,** never a database, a key or a
  channel set (AD-12).
- **No container publishes a port on the host,** and each environment gets two Docker networks
  of its own, both part of its compose project:
  - `x402-<environment>-edge`: `cloudflared` and the facilitator only. Both reach the internet
    through it: `cloudflared` to Cloudflare, the facilitator to its RPC URLs;
  - `x402-<environment>-db`: `internal: true`, the facilitator, the Postgres containers and the
    migration services only, with no route out. Only the facilitator and a network's migration
    service hold that network's database password. Once mainnet joins, every migration service
    reaches every Postgres, and only the password keeps `migrate-mainnet` out of testnet's
    database; a network per database would close that, at one more network per database
    (0077 decision 3).
  - The facilitator never joins the ClickHouse project's `app` network, so it can't reach
    ClickHouse. OpenBao is reached over unix sockets (ADR 0013), not a network.
  - Each network has a fixed /28 from `172.31.200.0/24`, set in the compose file, since the
    server's Docker address pool is taken whole by that `app` network. A second pool in
    `daemon.json` would also work, but it changes Docker for every project on the server, for the
    sake of two networks.
- **systemd restarts a facilitator that crashes, not Docker.** Its unit runs Compose in the
  foreground with `--exit-code-from <service>`, since a plain `docker compose up` exits 0
  whatever the container's code, and with `Restart=on-failure`, so the unit ends with the
  container's code and systemd starts it again after `RestartSec` 5 s. A start limit of 5 in
  300 s (`StartLimitBurst`, `StartLimitIntervalSec`) stops a crash loop in `failed`, which the
  alarms see. The containers have no restart policy, so nothing starts at boot except
  through the units (below). Neither acts on `unhealthy`, so a hung one needs a watcher:
  - a systemd timer on the host runs every 30 s and restarts the environment's `facilitator`
    container when it is `unhealthy`, with a 10 s stop timeout, since a hung process can't drain
    anyway. It finds the container by its Compose project and service labels and skips one-off
    containers;
  - it acts only while the environment's unit (`x402@<environment>.service`, below) is
    `active`. While a deploy, a reboot or an operator stops or starts the unit, it skips the
    pass, so it never restarts a facilitator that is draining;
  - it runs on the host, so no container gets the Docker socket.
- **The healthcheck is set on the facilitator service in the compose file,** not in the image. It
  is a Node one-liner (`node:22-slim` has no curl): it calls `/health` with a 5 s timeout, after
  a 30 s `start_period`, and three failures in a row make the container `unhealthy`. The
  migration service disables it, since `docker compose run` would inherit it.

### Deploys, liveness and readiness

- **Stop-before-start:** a deploy restarts the environment's facilitator unit, which stops the old
  container and only then starts the new one. Postgres keeps running, and the migrations have
  already run (Store).
  - Docker sends SIGTERM and waits `stop_grace_period` before SIGKILL.
  - The lease, not the ordering, guarantees one owner (AD-17). A process that finds the lease
    taken waits for it and never exits for lack of it.
- **`GET /health` is liveness only.** It answers 200 while the HTTP server is up and checks nothing
  else: not the lease, the RPC or the store. Its body reports `ready` and `listed`. The container
  healthcheck calls it every 10 s.
- **Ready to settle** (`ready`) means the process holds the lease outside a shutdown and not
  every RPC endpoint is frozen (0049). Until then, `/settle` answers 503 at once instead of
  hanging. The schema isn't part of it: a process starts only once every migration it knows is
  applied (0026), and a schema behind the code stops the start, as a wrong RPC or channel does,
  so a deploy that hasn't migrated gets no `ready` and rolls back. A store per network gives a lease per network: today, with one
  network, `ready` is its lease, and what readiness means with two (what the deploy, `/health`,
  the watchdog and 0027's "ready to settle" alarm wait for) is decided with the code in 0077.
  - A process without the lease keeps trying to take it.
  - A process whose lease renewal fails stops new submissions until it holds the lease again.
  - A process that froze past its TTL while another took the lease sends nothing new once it
    wakes: the store refuses its hash under the replaced fencing token (task 0071).
- **AD-16 reconciliation doesn't depend on the lease** (0019 decisions 27 and 37). It starts once
  the server listens and sweeps every 10 s beside `/settle`, in every process. It only reads the
  chain, and every write is a compare-and-set on the record's version, so a process waiting for
  the lease, for example after a crash, already finishes payments that landed.
- **`listed`** turns true once a sweep has listed the non-final records and stays true (0019
  decision 36). Listing is one query, so it comes fast even with a big backlog. An image whose
  sweeps can't list never turns it true.
- **The deploy's last step waits up to 120 s for `ready: true` and `listed: true`.** Without
  them, the deploy rolls back to the previous digest and fails the run (below). A "ready to
  settle" metric and a sweep counter also have alarms (0027).

### Timing

One request or one stop must never outlast the layer in front of it:

| Setting                               | Value              | Why                                                                |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| Seller's facilitator client           | 90 s               | `@x402/core`'s `HTTPFacilitatorClient`; started before the request |
| `/settle` response budget             | 30 s, at most 80 s | well below the seller's 90 s, so our answer reaches it             |
| `/settle` checks                      | see below          | inside the budget: past it, `…_timeout` and nothing is claimed     |
| Repeat wait (`SETTLE_TIMEOUT_MS`)     | 20 s, ≤ the budget | and never past the repeat's own budget                             |
| `stop_grace_period`                   | 180 s              | the 150 s drain plus 30 s for the store and the lease (0073)       |
| Cloudflare's response limit           | 100 s              | above the 80 s cap; past it Cloudflare answers 524                 |
| Node `keepAliveTimeout`               | 125 s              | above `cloudflared`'s idle keep-alive (90 s), or it sees 502s      |
| Container healthcheck                 | 10 s               | liveness only                                                      |
| `LEASE_TTL_MS`                        | 30 s               | after a crash, a new process waits at most this long               |
| Wait for `ready` and `listed`         | 120 s              | past it, the deploy rolls back to the previous digest              |
| Unit `TimeoutStopSec`                 | 200 s              | above `stop_grace_period`, so a reboot waits for the drain         |
| Unit `TimeoutStartSec`                | 60 s               | covers `ExecStartPre` only: credentials and the digest, no pull    |
| Postgres `stop_grace_period`          | 120 s              | a clean shutdown; the Compose default is 10 s                      |
| `x402-db-<network>@` `TimeoutStopSec` | 150 s              | above Postgres's 120 s, so a reboot doesn't kill it                |

- **Past the budget,** `/settle` answers `settlement_pending` with the hash if one was signed,
  and nothing new is signed after it. If nothing was signed, the record ends and the answer is
  `settle_exact_stellar_timeout`: the client repeats the same payment while `extra.retryable`
  says so, and signs a new one only after (0073). 30 s fits 97 % of the
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

- **"Nothing sent → `rejected`" reopens.** The resource is usually served before `/settle`.
  After a failure before anything was signed (no channel, the budget, the RPCs down, a restart,
  a deploy or a lost lease), the record ends, but the payer's auth entry can still land. Since task 0073 the
  identical payload reopens the record while that auth entry is valid, so whoever holds the
  payment (the seller's resource server, or the client) repeats it as it is and it settles once;
  the answer says so with `extra.retryable`. A refusal by the simulation, the fee or a spend
  limit still ends the payment: those need a new one (0073 decision 20 leaves their wording to a
  backlog task). During the deploy that brings this in, the previous release still answers these
  reasons as "sign a new payment", without `extra`, until it stops. That answer stays true: rows
  from before `0007_settlement_reopened`, and rows that release inserts after the migration ran,
  get `reopened` -1 and never reopen, so a payer who did sign again can't have the old payment
  land beside it through `/settle` (0073 decision 25). A rollback to a release before 0073 runs on
  the newer schema (its inserts get -1 too) but takes the promise back: it answers a repeat from
  the record, as "sign a new payment", without reopening it. Deploying this release again after
  that is an accepted gap: a record it claimed keeps `reopened` 0 through the rollback, so such a
  payment reopens, and it can land beside a newly signed one if both deploys fit inside the auth's
  life (0073 decision 28).
- **The budget covers the wait for a channel.** The pool's own bounds (until the payer's auth expiry ledger, then 30 s; 60 s + 30 s
  for a call without a ledger bound) start only
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
- **Images go to GitHub Container Registry,** tagged with the git SHA. The workflow builds on
  every deploy, only from `deploy/production`, and deploys the digest its own build reports: a
  tag can be overwritten by any workflow that may write packages, so it is never read back. The
  image is public, so the server needs no registry credential.
- **Production deploys the image built from `deploy/production`, with no promotion step.** A
  successful deploy records its digest and SHA as a GitHub Deployment in the `production`
  environment, for rollback and the record. With mainnet in the same process, every deploy will
  reach mainnet, so before it joins, 0038 decides between a staging environment ahead of
  production, whose recorded digest production would take (testnet → mainnet promotion, as this
  ADR had it until 2026-10-28), and stricter rules on production deploys.
- **GitHub Actions deploys over SSH:**
  - GitHub-hosted runners reach the server's SSH port, which the server's setup already opens to
    the internet, with key-only logins and fail2ban. There is no allowlist, since GitHub's address
    ranges change, and the workflow pins the server's host key in `known_hosts`. A self-hosted
    runner on the server would run workflow code next to ClickHouse and is rejected; a tunnel is
    a mainnet option (0038).
  - It logs in as a deploy user with one key per environment, and each key's `authorized_keys`
    entry fixes its environment: `command="/srv/x402/production/deploy.sh",restrict`. The script
    reads only an image digest from `SSH_ORIGINAL_COMMAND` and refuses anything but `sha256:` and
    64 hex digits.
  - The deploy user isn't in the `docker` group. It may write the environment's `digest.next`
    and run one command through `sudo`, `systemctl start x402-deploy@<environment>`. A second
    environment would share the user, the forced command keeping each key to its environment; a
    user per environment is a question for then (0038).
  - **The deploy itself is a unit, `x402-deploy@<environment>.service`** (a oneshot, as root), so a
    cancelled job or a dropped runner can't cut it between stopping the old facilitator and
    starting the new one. `deploy.sh` checks the digest, then, holding a `flock` on `digest.next`,
    writes it and starts the unit. `systemctl start` waits for the unit, so the job still gets
    the result, and a second deploy waits for the lock instead of joining the running job with
    another digest. The unit takes no lock of its own, which would deadlock, and a deploy by
    hand goes through `deploy.sh` too (runbook).
  - The deploy unit decrypts the environment's credentials with the script `x402@`'s
    `ExecStartPre` uses, since the migrations need the database passwords before `x402@` has ever
    run (the first deploy). It pulls the new image and runs each network's migration service from
    it while the old facilitator still serves (ADR 0012). A failed migration fails the deploy and
    leaves the old facilitator serving; nothing needs rolling back. Then it moves the new digest
    into `digest`, restarts `x402@<environment>` and waits up to 120 s for `ready: true` and
    `listed: true`, read with `docker exec` and the healthcheck's Node one-liner, so the check
    depends on neither the tunnel nor DNS.
  - Only after both does it write the digest to `digest.good` and remove images other
    than this one and the previous good one, since the disk is shared. If the restart fails or
    either doesn't come, it puts `digest.good` back into `digest`, restarts again and fails.
  - The first deploy has no `digest.good`, so it fails into the alarms. When `ready` fails
    because of a dependency, the previous image does no better: the deploy fails and the
    facilitator stays down. With the RPCs down it never even listens: since 0020, `main()`
    checks the RPC networks and the channels before it starts the HTTP server and exits with
    `startup_failed`, so the unit crash-loops until its start limit leaves it `failed`.
    `/health` then gives no data at all, so the readiness alarm treats missing data as
    breaching (0027), and the uptime alarm fires too.
  - Migrating before the stop and that rollback are both safe: a failed transactional migration
    leaves the schema as it was, a failed online one leaves the steps it finished, which the next
    deploy continues from (ADR 0012), and expand/contract keeps the older image working on a
    schema that did move forward. If a lock wait runs out of retries, the deploy fails before
    anything was stopped.
  - **`x402@<environment>.service` owns the facilitator.** Its `ExecStartPre` decrypts the
    environment's credentials (below) and, unless a deploy is running (a marker in
    `/run/x402/<environment>/`, which a reboot clears), puts `digest.good` into `digest`, so a
    reboot during a deploy starts the last image that was ready. It neither pulls nor migrates:
    `ExecStart` runs Compose in the foreground for the facilitator only (`--no-deps`), from the
    image the deploy pulled, with `Restart=on-failure`, and `ExecStop` stops it, which gives it
    its `stop_grace_period`. It wants and runs after `x402-openbao.service`, though it starts
    without OpenBao (ADR 0013).
  - **`x402-tunnel@<environment>.service` owns `cloudflared`.** It decrypts the tunnel token
    itself, as OpenBao's unit does, and is enabled at boot. `x402@` runs after it, so at a reboot
    the tunnel stops last and answers reach the clients while the facilitator drains.
  - **`x402-db-<network>@<environment>.service` owns that network's Postgres** (today
    `x402-db-testnet@production`: the network is in the template's name, a template per network,
    so `%i` is the environment as in every other unit). It decrypts its own credentials with the
    same script, since it starts first at boot, and its `TimeoutStopSec` of 150 s is above
    Postgres's 120 s grace. The facilitator's unit wants every one of them and runs after them
    (`Wants=` and `After=`, not `Requires=`), so at a reboot the facilitator drains while the
    databases are still up, and stopping, upgrading or failing to start one network's database
    never stops or restarts the facilitator: only that network stops settling, once the code
    serves both (0077). All are enabled at boot.
  - **Every unit that runs a container is `PartOf=docker.service`, runs after it, and runs
    Compose the same way** (`--exit-code-from`, `Restart=on-failure`, the start limit). A
    Docker restart, such as a `docker-ce` upgrade, first stops them through their own
    `ExecStop`, so the facilitator drains with its full grace instead of `dockerd`'s 15 s, and
    starts them again afterwards.
  - Production deploys on a push to `deploy/production` unless only `lore/**`, `docs/**` or
    Markdown files changed, or by hand. A deploy is a pull request from `develop` to
    `deploy/production`. `develop` stays open for direct pushes such as lore status changes.
  - The SSH key is a secret of the `production` GitHub environment, which carries the rules the
    OIDC trust policy used to: deployment branches limited to `deploy/production`, which is
    protected: a pull request with an approving review, and no bypass, admins included. The
    workflow runs as it is on that branch, so a change to it is reviewed too.
    - A job outside those rules never gets the key.
    - Before mainnet joins, 0038 weighs the rules the `mainnet` environment was to have: `v*`
      tags, required reviewers, and "Prevent self-review", so the person who starts a deploy
      can't approve it.
    - All four of us are repo admins, and an admin can switch the protection off. It stops
      unreviewed and accidental changes, not a deliberate admin, whose change stays in the
      repo's audit log.
  - One deploy runs at a time per environment: a `concurrency` group with
    `cancel-in-progress: false`, so a newer push waits instead of cancelling a deploy in progress.
  - Every action is pinned to a commit SHA, and the workflow sets `permissions: {}` and grants
    only what each job needs.
  - Before mainnet joins (0038): the deploy rules above or a staging environment, named
    reviewers, and who may edit the environments.
- **Rollback** redeploys an earlier digest through the same workflow; a failed deploy rolls back
  by itself (above).
- **An Ansible playbook in `deploy/ansible/` provisions the server's x402 parts:** the `x402`
  user, `/srv/x402/<environment>/`, the systemd units and timers, the compose files,
  `deploy.sh`, the deploy user's one `sudo` rule and its `authorized_keys` forced command,
  `cloudflared`, and the pgBackRest and CloudWatch agent config. An admin runs it from a reviewed
  commit, as the explorer's own playbook is run. It touches only x402's parts, never the server's
  base setup (firewall, `daemon.json`, users), which the ClickHouse project owns. Whoever runs
  the playbook, and from which commit, is the real boundary around production.
- **Per-merge deploys stay a digest over SSH** (above), and CI never runs the playbook. Ansible
  needs a full shell and, through `become`, effectively root on the production ClickHouse
  server, which `sudo` rules can't narrow; the forced command lets the CI key pass only a
  digest.

### Network and URL

- **Cloudflare is the DNS and the edge, through Cloudflare Tunnel.** One hostname,
  `x402-facilitator.sorobanscan.com`, and one facilitator service, `facilitator`, serve both
  networks (decided with Marek at the 2026-10-26 daily; `soroban-infrastructure`'s
  `cloudflare/x402.tf`, 12cec25, routes it). It is one label under the zone, since the Free
  plan's certificate covers only one level of subdomain.
  - The client names the network in the request (`network` in the payment requirements:
    `stellar:testnet` or `stellar:pubnet`), and the facilitator settles through that network's
    channel pool, key and RPC endpoints. There is no testnet/mainnet service split. The hostname
    is the `production` environment's; a staging environment would get
    `x402-facilitator-staging.sorobanscan.com`.
  - Only testnet is served for now; mainnet joins the same process later (0038). The code still
    serves one `NETWORK` per process until 0077 changes it.
  - One tunnel, `x402`. Its `cloudflared` opens outbound connections to Cloudflare (port 7844,
    UDP for QUIC and TCP) and forwards the hostname to `http://facilitator:4021`, the Compose
    service; anything else gets 404. The server opens no port for it. The compose file keeps
    `PORT` at 4021; changing it means changing `cloudflare/x402.tf` too.
  - HTTPS ends at Cloudflare, so Cloudflare sees the requests in plain text. They carry signed
    payments, never keys.
  - The tunnel, its routing and the DNS record are Terraform in the `soroban-infrastructure`
    repo's `cloudflare/`, beside the `sorobanscan.com` zone, so routing changes are reviewed
    there. Task 0062 sets up the zone and the tunnel, the facilitator's prerequisite.
  - The tunnel token lives only in Cloudflare and that repo's Terraform state. An operator
    fetches it (the dashboard, the API or `terraform output`) into an encrypted systemd
    credential (runbook), also when the server is restored elsewhere. Anyone with it can run a
    second connector and receive part of the traffic, so the runbook covers rotating it and
    checking the tunnel's connector count.
  - Bot Fight Mode, Browser Integrity Check and "I'm Under Attack" stay off on the zone: they
    apply zone-wide and would challenge sellers' server-to-server requests and the uptime
    check.
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
    it; nothing can be signed or read. Per-network separation is for signing: each network has
    its own key and policy in OpenBao (ADR 0013), though one facilitator process holds both
    networks' sockets.
  - It is the only AWS credential on the server; ADR 0013 names it as the exception to "no AWS
    credentials".
- **`FACILITATOR_SECRET` stays for local development and tests.** Deployed networks use the OpenBao
  signer instead.
- **Other secrets are encrypted systemd credentials,** as in ADR 0013: per network a database
  password and `RPC_URLS`, which may carry an API key, and per environment the tunnel token.
  - The files are named per network from the first deploy, so mainnet adds files and renames
    none: `database-url.<network>` and `rpc-urls.<network>` for the facilitator,
    `postgres-password.<network>` for each Postgres, `approle-role-id.<network>` and
    `approle-secret-id.<network>` for the signer (ADR 0013), and one `tunnel-token`.
  - `systemd-creds` keeps them encrypted on disk with the host key. Each unit decrypts the files
    its container reads, with one shared script, to `/run/x402/<environment>/` (tmpfs, mode
    0700): `x402@` the facilitator's (a database URL per network), each `x402-db-<network>@` its
    Postgres's password, `x402-tunnel@` the tunnel token, and the deploy unit what the
    migrations need. Compose mounts them as `file:`
    secrets, so they are plain only in memory. Outside swarm those are bind mounts that keep
    the host's owner and mode, so each file is written mode 0400 for the user of the container
    that reads it: `node` (uid 1000) for the facilitator's, `postgres` (uid 999) for
    Postgres's password, and `nonroot` (uid 65532, checked on the pinned digest) for
    `cloudflared`'s tunnel token.
    0026 lists them per file. OpenBao's unit (`x402-openbao.service`) does the same with its
    unseal credential.
  - They stay there until a reboot, so the unit's restart after a crash and the watchdog still
    find them.
    At boot the unit writes them again before it starts anything.
  - The app reads them from files: `DATABASE_URL_FILE` and `RPC_URLS_FILE` (0026), which point
    at testnet's; with both networks, 0077 gives each network its own. The AppRole files come
    with the OpenBao signer (0036).
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

- **PostgreSQL in a container per network, on the same server,** though one facilitator uses
  both (decided 2026-10-28, 0077). It holds the schema and adapter rules of
  [ADR 0012](0012-facilitator-state-store.md), which has no network column, so the facilitator
  opens one store per network beside that network's pool. A testnet reset wipes only testnet's
  database, and backups, restores and migrations stay per network.
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
  as a backfill or an index build on a big table, is an online migration and runs in the deploy
  too (task 0067):
  - the migration service's bounds are ADR 0012's;
  - it logs each step as it ends and every 50 backfill batches, and the deploy lock holds later
    deploys meanwhile. A step's start and the wait for another run's lock reach the journal only
    with task 0080, so until then a long index build, `VALIDATE` or that wait is quiet there:
    read `pg_stat_activity` before stopping a run;
  - `x402-deploy@` is a oneshot with a `TimeoutStartSec`, the cap on the whole run: cancelling the
    CI job doesn't stop the unit, so without it a stuck run, waiting up to 30 minutes for another
    run's lock and up to 30 more on each long step, would hold every later deploy, a hotfix's
    included, under the `flock`. systemd stops a run past it, the deploy fails before the old
    facilitator stops, and the next deploy continues the migration from its markers. 0026 sets
    the cap from testnet's size, 60 minutes to start (AC1 took 4 min 43 s at 1 000 000
    reservations), between two bounds:
    - above the longest single step, since a stopped backfill walks its table again and a
      stopped index build starts over, so a shorter cap never finishes them;
    - no longer than a hotfix may wait;
  - a backfill writes about 1.2 GiB of WAL per 2 million rows (a million reservations with the
    four default scopes is twice that), which pgBackRest ships as each segment closes, and the
    table grows about a third: check the disk's headroom first;
  - both networks' databases share the server's disks with the production ClickHouse, so an
    online migration runs on testnet first, outside mainnet's busy hours and away from 00:00 UTC,
    when ClickHouse writes the most. Mainnet's ceiling on
    a migration's length goes to 0038.
- **No TLS to the database.** The connection stays on the environment's `internal` Docker network on
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
  are ours, and an HMAC would need one more secret per deployment. Upstream verify's failover
  logs its switches with these names (0045). In an error message, the logger names a URL on an
  `RPC_URLS` entry the same way and reduces any other URL to its host; an entry's bare host, as
  Node's network errors give it (`getaddrinfo ENOTFOUND <host>`), is named too. Since 0045,
  `main()` names the shared `FallbackRpc`'s endpoints the same way and logs its switches
  (`rpc_failover`).
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
  - no sweep listing the records within the alarm window: since the deploy checks `listed` only
    once, this is the net for sweeps that start failing later (0019 decision 36);
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
  containers are limited to 1.875 GiB today and 2.875 GiB with mainnet's database. Running there
  costs about €0 more, against about $60–70 a month on testnet and $150 on mainnet for ECS
  Fargate.
- **It meets both hard rules.** Compose stops the old container first, and the grace period has no
  platform cap, so 180 s covers the 150 s drain. A submission still open then is finished by the
  next process (0073).
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
  - Not chosen for testnet: the shared server has the room, limits contain the contention, and
    the coupling above is accepted knowingly. For mainnet it stays an open question (0038),
    where the risk rows weigh most: root on that server reaching the OpenBao key, testnet code
    on the production server, and runners that SSH into it.

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

- **Ansible from CI for every deploy.** Rejected: the CI key would need a full shell and
  effectively root on the production ClickHouse server. The playbook provisions the server, and
  a deploy stays a digest through the forced command.
- **The server's Caddy, in the ClickHouse project,** as the edge and reverse proxy, with an
  A record in Route 53 (`testnet.x402.rumblefish.dev`). This was this section until 2026-10-22.
  Rejected: our site block would live in that project's repo and deploy, a deploy there that
  recreates Caddy without it takes the facilitator offline, and the edge networks would have to
  exist before that project's deploy. The company is also moving sorobanscan to Cloudflare.
- **Cloudflare's proxy in front of that Caddy:** Cloudflare as the edge, Caddy as the reverse
  proxy behind it. It keeps the Caddy coupling, and needs an origin lock (Authenticated Origin
  Pulls in our site block), since the server's address is already public under ClickHouse's own
  name.
- **A facilitator per network,** each with its own directory, units, tunnel, hostname and deploy
  key, with mainnet promoted by a digest that ran on testnet. This was this ADR until
  2026-10-28. Replaced at the 2026-10-26 daily: one hostname and one service, the client naming
  the network in the request (tasks 0076, 0077).
- **A staging environment ahead of production now.** Not yet: while production serves only
  testnet, a deploy that breaks it costs testnet. It costs a second set of containers, a second
  testnet channel set and its own hostname, and 0038 weighs it before mainnet joins.
- **One database for both networks,** with the network in each record. Rejected: every table,
  key and query would need the network, and a testnet reset or restore would touch mainnet's
  records.
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
  - The server must allow outbound connections to Cloudflare on port 7844, UDP and TCP.
- **It is one physical machine.** A hardware fault takes the facilitator down until the server is
  repaired or the service is restored elsewhere from the off-server backups, which can take hours.
  Restoring elsewhere is a runbook step (0026) and a mainnet risk (0038).
- **Operations are ours:** Docker and OS updates, PostgreSQL upgrades, backups and restore drills,
  `cloudflared` upgrades, and keeping the playbook in step with the server.
- **Deploy downtime is usually under a minute:** a quick drain when idle and a container start;
  reconciliation runs beside `/settle`, and the pull and the migrations run before the stop. At
  worst it is about 5 minutes: a 180 s drain and up to 120 s for `ready` and `listed`. The uptime alarm waits 7 failing
  minutes for that reason.
- **After a crash,** systemd restarts the container (`Restart=on-failure`). The new process
  reconciles at once and waits up to 30 s for the lease before it settles new payments. Records keep each transaction's ledger bound, so a hash
  that can't be found yet stays non-final until that bound passes (0019).
- **The OpenBao signer (0036, ADR 0013) blocks the testnet deploy (0026).**
- **ADR 0012's store moves from RDS to a container on the server.** Its schema, adapter rules and
  migrations are unchanged; managed backups and failover become ours (task 0013).
- **0026 builds:**
  - the Dockerfile, the compose files, the deploy script, and the Ansible playbook that puts
    them, the units and the deploy user on the server;
  - the systemd units: `x402@production`, `x402-db-testnet@production`,
    `x402-deploy@production`, `x402-tunnel@production`, `x402-openbao`, the restart timer and
    the backup timer;
  - the `cloudflared` container, with the tunnel token fetched from Cloudflare into a systemd
    credential. The tunnel, its routing and the DNS record come from
    `soroban-infrastructure`, after the `sorobanscan.com` zone is on Cloudflare;
  - the deploy user, its one `sudo` rule, the SSH forced command, the workflow with the pinned
    host key, and the `deploy/production` branch with its protection;
  - the OpenBao container (ADR 0013), the IAM Roles Anywhere logging role and its certificate,
    and the secret files;
  - the backups (pgBackRest to the Storage Box);
  - `GET /health` with `ready` and `listed`, the Node keep-alive setting, and the migration bounds;
  - the config reading `DATABASE_URL` and `RPC_URLS` from files (`*_FILE`);
  - the runbook: running the playbook, deploy, rollback, key rotation, certificate renewal,
    restore on another machine.
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
  - edge rate limiting, and whether mainnet needs a paid Cloudflare plan for its uptime SLA;
  - once every production deploy reaches mainnet: a staging environment ahead of it or
    stricter deploy rules (above), and the facilitator's memory limit with two channel pools;
  - one uptime check, the 99% figure, the zone's rate limit and its analytics then cover both
    networks at once;
  - what one process costs once both networks run in it: the watchdog's 10 s restart of a hung
    facilitator, a crash and every deploy cut both networks' submissions in flight, and rotating
    one network's key (Keys, secrets and access: "stop the service") stops both.
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
- [ADR 0013](0013-facilitator-key-custody.md): the facilitator key in OpenBao Transit
- [IAM Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html),
  [CloudWatch agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html),
  [Compose `stop_grace_period`](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)
