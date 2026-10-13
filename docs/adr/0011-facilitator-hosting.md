# ADR 0011: Host the facilitator on the company Hetzner server

- Status: accepted
- Date: 2026-10-09
- Revised: 2026-10-13. ECS Fargate became the company Hetzner server (task 0039); the first
  version is in git history and task 0014.

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
- **keep the facilitator key out of the image, the logs and the server** (AD-12);
- **offer a durable store** for the PostgreSQL schema of ADR 0012.

The company already runs a Hetzner dedicated server, `ch-prod-01`, which hosts ClickHouse. Read on
2026-10-12:

- x86_64, 24 cores at a load of about 2;
- 125 GiB RAM, about 120 GiB available. ClickHouse runs in a container limited to 108 GiB;
- 1.8 TB on RAID, 731 GB free;
- Docker Compose v5, and Caddy already terminates HTTPS in the same compose project as ClickHouse.

The facilitator with its database needs about 1 GiB of RAM and, on testnet, under 1 GB of disk. The
`rumblefish.dev` zone is on Route 53 in the company AWS account, which also holds sorobanscan and
the Stellar Prices API.

## Decision

### Platform and containers

- **Docker Compose on `ch-prod-01`,** for testnet and mainnet. The project is `x402`, separate
  from ClickHouse's `app` project, owned by its own Linux user.
- **Per network, two containers:**
  - `facilitator-<network>`, memory limit 512 MiB and one CPU;
  - `postgres-<network>`, PostgreSQL 18, memory limit 1 GiB, data on a volume on the server's
    RAID.
- **Testnet and mainnet never share a container,** a database, a key or a channel set (AD-12).
- **Neither container publishes a port on the host.** Caddy reaches the facilitator over a shared
  Docker network. Only the facilitator reaches its own Postgres.
- **`restart: unless-stopped`:** Docker restarts a facilitator that crashes.

### Deploys, liveness and readiness

- **Stop-before-start:** a deploy stops the old container and only then starts the new one.
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
- **The deploy's last step waits for `ready: true`** and fails the run otherwise. A "ready to
  settle" metric also has an alarm (0027).

### Timing

One request or one stop must never outlast the layer in front of it:

| Setting                   | Value | Why                                                         |
| ------------------------- | ----- | ----------------------------------------------------------- |
| `/settle` response budget | 90 s  | past it, answer `settlement_pending` with the hash (AD-6)   |
| `stop_grace_period`       | 180 s | in-flight `/settle` plus the background drain after SIGTERM |
| Node `keepAliveTimeout`   | 125 s | above Caddy's idle keep-alive (2 min), or Caddy sees 502s   |
| Container healthcheck     | 10 s  | liveness only                                               |
| `LEASE_TTL_MS`            | 30 s  | after a crash, a new process waits at most this long        |

- **The budget covers the wait for a channel.** The pool's own bounds (60 s + 30 s) start only
  once a channel is acquired, so the `/settle` handler passes the pool a deadline (0009).
- **On SIGTERM the facilitator stops taking `/settle` itself** (503), lets open requests finish and
  drains. Caddy has no deregistration step, so it keeps forwarding until the container is gone and
  answers 502 while it is down.

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
  build when the SHA is already there, and mainnet deploys the digest that ran on testnet.
- **GitHub Actions deploys over SSH:**
  - It logs in as a deploy user whose key runs one forced command: a deploy script that takes an
    image digest and a network.
  - The script pulls the image and runs the migration task (ADR 0012) as a one-off container. It
    then stops the old facilitator, starts the new one and waits for `ready: true`.
  - Testnet deploys on a push to `develop` unless only `lore/**`, `docs/**` or Markdown files
    changed, or by hand.
  - Mainnet deploys by hand from a tag, through the `mainnet` environment with required reviewers.
  - The SSH key is an environment secret, one per network.
  - One deploy runs at a time per network (a `concurrency` group).
  - Every action is pinned to a commit SHA, and the workflow sets `permissions: {}` and grants
    only what each job needs.
- **Rollback** redeploys an earlier digest through the same workflow.
- **The compose file and the deploy script live in `deploy/`.** The server keeps only the secret
  files and the data volumes.

### Network and URL

- **A `rumblefish.dev` subdomain is a prerequisite:** an A record in the company's Route 53 zone
  pointing at the server. The proposal is `testnet.x402.rumblefish.dev`.
- **Caddy terminates HTTPS** with an automatic Let's Encrypt certificate and proxies the subdomain
  to the facilitator. Its config belongs to the ClickHouse project, so adding the site block is
  agreed with that project's owner.
- **`TRUSTED_PROXY_HOPS=1`** (AD-11): Caddy is the one proxy that appends `X-Forwarded-For`. It
  is Express's numeric `trust proxy`, so the client IP is the rightmost entry (0023).
- **No edge rate limiting;** the in-app limits (AD-11, AD-18) apply. Mainnet revisits this
  (0038).

### Keys, secrets and access

- **The facilitator key lives in AWS KMS on both networks.** The facilitator signs through KMS
  behind the pool's `TransactionSigner`, and the key never reaches the server.
  - The key spec is `ECC_NIST_EDWARDS25519`, with algorithm `ED25519_SHA_512` and
    `MessageType: RAW`, over the 32-byte transaction hash. That is pure Ed25519, as Stellar signs.
    `ED25519_PH_SHA_512` is HashEdDSA and gives signatures Stellar rejects.
  - There is one key per network.
  - The key policy denies `kms:Sign` to everyone but that network's signing role. Key
    administrators can't sign, and only a break-glass role may disable the key or schedule its
    deletion.
  - A spike proves the signature first (0036). It is now a prerequisite of the testnet deploy.
- **The server reaches AWS through IAM Roles Anywhere.**
  - A certificate on the server gets short-lived credentials, and no long-lived AWS keys are
    stored there.
  - Each network's role may sign with its own key and write its own log group, only from the
    server's IP.
- **`FACILITATOR_SECRET` stays for local development and tests.** Deployed networks set the KMS key
  instead.
- **Other secrets are files on the server:** the database password, and an RPC URL that carries an
  API key.
  - They are mode 0600, owned by the project's user, and mounted as Compose secrets.
  - They never go into the image, the repo or the logs.
- **Rotating the key is an on-chain change.** AD-12 makes the facilitator key the only signer of
  every channel. Rotation means:
  1. stop the service;
  2. with the old key, make the new key the signer of every channel and the fee account;
  3. point the config at the new key;
  4. start the service.

  The runbook (0026) also covers the compromised-key case.

- **CloudTrail alarms on the keys:** use by another principal, a key-policy change, or a
  scheduled deletion (0027 for testnet, 0036 for mainnet).

### Store

- **PostgreSQL in a container per network, on the same server.** It holds the schema and adapter
  rules of ADR 0012 (task 0013, in review), which assumed RDS.
- **Sizing:** about 2–4 KB per payment. That is under 1 GB on testnet and about 1 GB a month on
  mainnet at 10,000 payments a day, plus up to about 1 GB of WAL.
- **Backups are ours:**
  - a daily base backup and a continuous WAL archive to storage off the server, either an S3
    bucket in the company AWS account or a Hetzner Storage Box;
  - a retention period, and a restore drill on testnet before mainnet.
- **The migration task** runs from the new image before each deploy (ADR 0012). The old process
  keeps serving while it runs, so every migration is expand/contract.
- **ClickHouse is not the store.** It is an analytics database: no enforced unique keys, no
  conditional updates and no transactions, so it can't guarantee AD-6's exactly-once claim. It may
  later hold payment analytics fed from PostgreSQL.

### Logs, metrics and alerts

- **Logs:** the 0017 `jsonLogger` stays.
  - Its JSON lines go from stdout to CloudWatch Logs through Docker's `awslogs` driver, with
    credentials from IAM Roles Anywhere. The log group uses the Standard class, with 30-day
    retention on testnet.
  - No pino: stdout is the only transport, and the logger already writes identifiers only.
- **RPC URLs are logged by host only.** An RPC URL can carry an API key, and signer-pool's
  `FallbackRpc.fromUrls` names endpoints by the full URL today (0027).
- **Metrics:** a metrics adapter (0027) writes CloudWatch Embedded Metric Format lines to stdout,
  which CloudWatch turns into metrics.
  - Namespace `x402-facilitator`.
  - Dimensions stay low-cardinality: `network`, route, outcome, event name.
  - Never payer or `payTo`: each dimension combination is a billed custom metric.
- **Host metrics:** the CloudWatch agent on the server reports memory, CPU and free disk, since
  ClickHouse shares the machine.
- **Alerts:** CloudWatch alarms go to an SNS topic, and Amazon Q Developer in chat applications
  (formerly AWS Chatbot) posts them to the team's Slack channel. 0027 defines them:
  - the five AD-18 conditions;
  - not ready to settle (the counterpart of the lease-blind `/health`);
  - the key events above;
  - low free disk and memory on the server.
- **Uptime:** a Route 53 HTTPS health check on the public URL.
  - Route 53 publishes its metrics only in us-east-1, so the alarm and its SNS topic live there.
  - It checks `/supported` once 0020 makes it real, and `/health` before that.
  - The 99% figure counts a minute as up only when the check passes and the facilitator is ready
    to settle.

## Rationale

- **The capacity is already paid for.** The server has about 120 GiB of free RAM and 731 GB of
  free disk, and the facilitator with its database needs about 1 GiB. Running there costs about
  €0 more, against about $60–70 a month on testnet and $150 on mainnet for ECS Fargate.
- **It meets both hard rules.** Compose stops the old container first, and the grace period has no
  platform cap, so 180 s covers the drain with room to spare.
- **Key custody matches the AWS option.** With KMS the key never leaves AWS, wherever the process
  runs.
- **The alerting design carries over:** the same logger, the same EMF metrics, CloudWatch alarms
  and Slack.
- **Caddy and Docker are already on the server.**

## Alternatives considered

- **ECS Fargate in the company AWS account.** This was the first version of this ADR.
  - What it gives: managed patching and task replacement, managed PostgreSQL (RDS) with backups
    and failover, and a path to two tasks in two zones.
  - What it costs: about $60–70 a month on testnet and $150 on mainnet, and a 120 s cap on the
    drain.
  - Rejected because the company server already has the room.
  - It stays the migration path: the image, the stop-first design, KMS and CloudWatch move over
    unchanged.
- **A separate small Hetzner Cloud VM** (about €7–14 a month), which would isolate the
  facilitator from the production ClickHouse server. Not chosen, because the shared server has the
  room and limits contain the contention. It is the first step if isolation becomes a concern.
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

- **ClickHouse as the store.** Rejected; see Store.
- **The key in a file on the server,** encrypted at rest. The cheapest option, but anyone who
  takes the server takes the key. Rejected for both networks.
- **Grafana Cloud Free for metrics and alerts.** $0, but a second vendor whose alert rules sit
  outside our config. CloudWatch is kept.

## Consequences

- **The facilitator shares a production server with ClickHouse.**
  - Memory and CPU limits on our containers, and ClickHouse's own 108 GiB limit, keep them apart.
  - Maintenance couples them: a reboot for a kernel update restarts both.
  - The server has run 150 days without a restart, so patching needs an owner and a schedule.
- **It is one physical machine.** A hardware fault takes the facilitator down until the server is
  repaired or the service is restored elsewhere from the off-server backups, which can take hours.
  Restoring elsewhere is a runbook step (0026) and a mainnet risk (0038).
- **Operations are ours:** Docker and OS updates, PostgreSQL upgrades, backups and restore drills,
  and the Caddy site block.
- **Deploy downtime is shorter than on Fargate,** usually under a minute: a quick drain when idle,
  a container start, and reconciliation. Up to about 3 minutes when a request and a submission are
  in flight.
- **After a crash,** Docker restarts the container. The new process waits up to 30 s for the lease
  and reconciles. Records keep each transaction's time bound, so a hash that can't be found yet
  stays non-final until that bound passes (0019).
- **0036 (KMS signer) now blocks the testnet deploy (0026),** because testnet signs through KMS too.
- **ADR 0012's store moves from RDS to a container on the server.** Its schema, adapter rules and
  migrations are unchanged; managed backups and failover become ours (task 0013).
- **0026 builds:**
  - the Dockerfile, the compose file and the deploy script;
  - the deploy user, the SSH forced command and the workflow;
  - the IAM Roles Anywhere setup and the secret files;
  - the backups, the Caddy site block and the DNS record;
  - `GET /health` with `ready`, and the Node keep-alive setting;
  - the runbook: deploy, rollback, key rotation, restore on another machine.
- **0027 builds:** log shipping and the CloudWatch agent, the EMF adapter, the alarms above, the
  us-east-1 uptime stack and the Slack integration.
- **0009 gives `/settle` its response budget;** 0023 implements `TRUSTED_PROXY_HOPS` as above.
- **Cost:**
  - The server adds nothing.
  - KMS is about $1 a key per month plus $0.15 per 10,000 signatures.
  - CloudWatch logs, metrics and alarms, and the health check, come to a few dollars.
  - Off-server backup storage is a few dollars.
- **Mainnet availability is open** (0038). It needs to settle:
  - two facilitator containers with separate channel sets on this server, which give deploys
    without downtime but no protection from hardware faults;
  - a second machine or a standby;
  - edge rate limiting.
- **Slack is not a pager.** On mainnet, the alerts that cost money (breaker open, low balance,
  pending settlements) also need a phone or SMS route.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-1, AD-6, AD-11, AD-12, AD-15, AD-16,
  AD-17, AD-18
- [ADR 0009](0009-conformance-gate-harness.md): the gate needs the public URL
- ADR 0012 (task 0013, in review): the PostgreSQL store
- Task 0014 notes (`0014_RESEARCH_facilitator-hosting/notes/`): the requirements, the platform
  research and the comparison behind the first version
- Task 0039: the move to the Hetzner server
- [AWS KMS Ed25519](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html),
  [IAM Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html),
  [Docker `awslogs` driver](https://docs.docker.com/engine/logging/drivers/awslogs/),
  [Compose `stop_grace_period`](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)
