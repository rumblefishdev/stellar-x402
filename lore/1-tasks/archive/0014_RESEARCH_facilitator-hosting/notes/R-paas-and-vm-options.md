---
title: "PaaS and single-VM hosting options"
type: research
status: mature
spawned_from: README.md
spawns:
  - S-hosting-decision.md
tags: [hosting, paas, vm]
links: []
history:
  - date: "2026-10-08"
    status: developing
    who: claude
    note: "Researched for 0014 (Fly.io, Railway, Render, Hetzner/DigitalOcean VM)."
  - date: "2026-10-09"
    status: mature
    who: stkrolikiewicz
    note: "Moved from an untracked checkout into the branch; feeds S-hosting-decision and ADR 0011."
---

# PaaS and single-VM hosting options

This note covers three PaaS options (Fly.io, Railway, Render) and a single VM (Hetzner Cloud or
DigitalOcean) running Docker with Kamal 2 or Docker Compose. AWS is Rumble Fish's default cloud
and is covered in its own note, so each option ends with a line on why we would pick it over AWS.
Prices and docs were checked on 2026-10-08. Prices are in USD unless marked EUR, and exclude VAT.

What the facilitator needs from a host (task README, spine AD-12, AD-15, AD-17, Deferred):

- **Always on.** It is one long-lived Node 22 process with the channel pool, a confirmation loop
  and a ledger clock. Scale-to-zero and auto-stop must be off.
- **Stop before start.** The old process must stop before the new one takes the channel-set lease
  (AD-17). A store-backed lease also enforces this: a process without the lease doesn't serve
  `/settle`.
- **Grace period.** One settlement can take about 90 s with the pool's defaults, so SIGTERM to
  SIGKILL must be at least 90–120 s. We would set 150 s where the platform allows it.
- **Public HTTPS URL** for the e2e gate proxy (AD-15). A custom domain is nice to have.
- **Size.** T1: one small instance (0.25–1 vCPU, 512 MB–1 GB) on testnet. Mainnet-ish: two
  instances of about 1 vCPU and 1–2 GB, each with its own channel set, plus a production Postgres
  with backups.

**The lease and the health check.** Every platform below except Docker Compose, and Fly with one
Machine, starts the new process before it stops the old one, and gates the cutover on a health
check. If the health check depended on holding the lease, the new process could never pass it,
because the old one still holds the lease. The deploy would then fail when the platform's
health-check timeout runs out. So the health check must report liveness only, and the lease
should gate only `/settle` (503 until the lease is held).

**Key custody, for every option.** AWS KMS has supported Ed25519 keys (`ECC_NIST_EDWARDS25519`)
for signing since 2025-11-07
([AWS What's New](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/),
[key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html)).
So a KMS-backed `TransactionSigner` can keep the key in the company AWS account whatever the host.
What differs between hosts is how they authenticate to AWS: through OIDC with no stored keys, or
with static IAM keys kept as a secret.

## 1. Fly.io

- **Always on:** `auto_stop_machines` defaults to `"off"`, and `min_machines_running` only applies
  when autostop is on ([config reference](https://docs.fly.io/reference/configuration)). Set
  `auto_stop_machines = "off"` explicitly. The first `fly deploy` creates two Machines per process
  group that has services. Use `--ha=false` or `fly scale count 1` to keep one, and later deploys
  keep that count ([app availability](https://fly.io/docs/reference/app-availability)).
- **Stop before start:**
  - Strategies are `rolling` (the default), `immediate`, `canary` and `bluegreen`.
  - `canary` and `bluegreen` boot new Machines next to the old ones, so they overlap. Avoid them.
    Neither is allowed when a Machine has a volume
    ([config reference](https://docs.fly.io/reference/configuration)).
  - `rolling` replaces Machines one at a time, and `max_unavailable` caps how many are down at once.
    Updating a running Machine reboots that same Machine
    ([Machines API](https://docs.fly.io/machines/api/machines-resource)). So with one Machine, the
    old process should exit before the new one boots, which is true stop-before-start.
  - That ordering is inferred, not stated in the deploy docs
    ([deploy docs](https://docs.fly.io/launch/deploy)). Verify it with a test deploy: the Machine
    ID should stay the same, and the logs should show the old process exiting before the new one
    boots. `immediate` also skips health checks.
  - Knobs: `[deploy] strategy = "rolling"` and `max_unavailable = 1`.
- **Grace period:** `kill_signal` defaults to SIGINT, so set it to `"SIGTERM"`. `kill_timeout`
  defaults to 5 s, and the **maximum is 300 s**. The docs call it best-effort
  ([config reference](https://docs.fly.io/reference/configuration)). Set 150 s.
- **Postgres, volumes, Redis:**
  - Managed Postgres (MPG) plans: Basic at $38/mo (shared-2x, 1 GB), Starter at $72 (2 GB) and
    Launch at $282 (performance-2x, 8 GB). Storage is $0.28/GB-month.
  - Every MPG plan includes high availability (HA), backups and connection pooling. The docs list
    customer-facing alerting and security patches and version upgrades as not yet available, and
    don't give a backup retention period ([MPG docs](https://docs.fly.io/mpg/)).
  - The EU regions that can host MPG are ams, fra and lhr
    ([regions](https://docs.fly.io/reference/regions)).
  - Volumes are $0.15/GB-month ([pricing](https://docs.fly.io/about/pricing)). A volume belongs to
    one Machine and isn't replicated.
  - Redis is Upstash via `fly redis create`: pay-as-you-go at $0.20 per 100k requests, or fixed
    plans from $10/mo. Fly's docs may lag Upstash's own prices
    ([Fly Redis docs](https://fly.io/docs/reference/redis/)).
- **Secrets and KMS:**
  - Each app has an encrypted vault. The API servers can encrypt but not decrypt, and secrets are
    injected as environment variables at boot. `fly secrets set` restarts Machines, while `--stage`
    defers the change ([secrets](https://docs.fly.io/apps/secrets/)).
  - There is no KMS. Machines get OIDC tokens from `oidc.fly.io` that AWS STS accepts through
    `AssumeRoleWithWebIdentity`. So AWS KMS works with no stored AWS keys
    ([Fly OIDC](https://fly.io/docs/security/openid-connect/)).
- **TLS and domain:** Apps get a `*.fly.dev` hostname, and `fly certs add` adds a custom domain.
  The first 10 single-hostname certificates per organization are free. Shared IPv4 and IPv6 are
  free, and a dedicated IPv4 is $2/mo ([pricing](https://docs.fly.io/about/pricing)).
- **Logs and metrics:**
  - Fly runs a managed Prometheus-compatible store (VictoriaMetrics) and Grafana at fly-metrics.net,
    free for now. Retention is about 15 days.
  - Fly scrapes the app's `/metrics` every 15 s through `[metrics]` in `fly.toml`. A PromQL API and
    federation are available ([metrics](https://docs.fly.io/monitoring/metrics/)).
  - Log search keeps logs for 7 days (beta, free). Export goes through the Fly Log Shipper to Loki,
    Datadog, S3 and others, and only covers logs from the moment it connects. There is no native
    OpenTelemetry (OTel) ([logging](https://docs.fly.io/monitoring/logging-overview),
    [search](https://fly.io/docs/monitoring/search-logs/)).
- **Regions:** In Europe: ams, arn, cdg, fra and lhr. Warsaw (`waw`) is not on the current list
  ([regions](https://docs.fly.io/reference/regions)). European regions cost slightly more than the
  US base price: about 1.04x in ams and arn, about 1.15x in fra
  ([pricing](https://docs.fly.io/about/pricing)).
- **Pricing**, after the 2026-10-01 memory price rise of +20% to $6/GB-month
  ([superfly/docs PR #2507](https://github.com/superfly/docs/pull/2507),
  [Layerbase](https://layerbase.com/blog/fly-io-memory-price-increase)):
  - Machine prices at the US base rate: shared-cpu-1x is $3.69 with 512 MB and $6.70 with 1 GB.
    performance-1x with 2 GB is $33.
  - There is no free tier for new organizations. Standard support is $29/mo
    ([pricing](https://docs.fly.io/about/pricing)).
  - **T1:** in ams, 512 MB is about $3.84 (3.69 × 1.04). Add MPG Basic at $38 and 1 GB of storage
    at $0.28, for **about $42/mo**, or about $45 with 1 GB of RAM. With SQLite on a 1 GB volume
    instead, it is **about $4–7/mo**.
  - **Mainnet-ish:** 2 × performance-1x 2 GB costs about $69 in ams or $76 in fra. Add MPG Starter
    at $72 and 10 GB at $2.80, for **about $145–150/mo**, plus $29 if we want Standard support.
    Whether the regional markup also applies to MPG is unverified.
- **Testnet to mainnet:**
  - Unchanged: the same Dockerfile and `fly.toml`, with one Fly app per network, so each network
    has its own secrets.
  - Changed for mainnet: the Machine size and the MPG plan, plus a log shipper.
- **Team effort:** Low: a Dockerfile, `fly.toml` and `flyctl`, with deploys from GitHub Actions
  using a deploy token.
- **Reliability:**
  - Fly's infra log describes a February 2025 IAD connectivity incident that took down part of the
    Machines API ([infra log](https://fly.io/infra-log/)).
  - Third-party trackers list several 2026 incidents: registry and deploy problems in February, an
    hour-long Machines API outage on 2026-06-15, a secrets-service outage and a capacity shortfall
    in arn in August ([StatusGator](https://statusgator.com/services/flyio/deployments),
    [Kuberns](https://kuberns.com/blogs/is-fly-io-good-for-production/)). These are third-party
    accounts, not Fly's own.
- **Versus AWS:** Pick Fly if we want the least setup and a stop-then-start deploy with a few lines
  of config, while still signing with AWS KMS through OIDC. Against: the 2025–2026 incident record,
  and MPG lacks customer-facing alerting.

## 2. Railway

- **Always on:**
  - Railway's "Serverless" mode (`sleepApplication` in `railway.json`) stops a service after 5–10
    min without outbound packets ([app sleeping](https://docs.railway.com/reference/app-sleeping),
    [schema](https://railway.com/railway.schema.json)). Our ledger clock polls the RPC, so the
    service would stay awake anyway.
  - The default value isn't stated in the docs we read (unverified), so set
    `sleepApplication: false` explicitly.
  - The restart policy can be `ON_FAILURE`, `ALWAYS` or `NEVER` (schema).
- **Stop before start:** not by default. The default sequence:
  - The new deployment starts while the old one still runs. With a health check set, it becomes
    Active only after a 2xx response. The check runs only at deploy time, with a default timeout of
    300 s ([health checks](https://docs.railway.com/reference/healthchecks)).
  - Once it is Active, the old deployment gets SIGTERM after `overlapSeconds`, then SIGKILL after
    `drainingSeconds` ([deployments](https://docs.railway.com/reference/deployments)).
  - If the health check depended on the lease, the deploy would fail after 300 s and, as the docs
    imply, the old deployment would keep running.

  To get stop-before-start, **attach a volume**. Railway won't let two deployments with the same
  volume be active, so a redeploy has a short downtime instead of an overlap
  ([volumes](https://docs.railway.com/reference/volumes)). Whether `drainingSeconds` is honoured
  on that path is unverified, so test it.
- **Grace period:** `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, or `drainingSeconds` in
  `railway.json`.
  - The default is **0**, which means an immediate SIGKILL
    ([variables](https://docs.railway.com/reference/variables)).
  - The config schema sets a minimum of 0 and **no maximum**
    ([schema](https://railway.com/railway.schema.json)). Railway sends only SIGTERM, then SIGKILL.
  - Set 150 s, and confirm with a test that values of 120 s or more are honoured.
- **Postgres, volumes, Redis:**
  - Postgres is a Railway-maintained template: the official Postgres image running as a service
    with a volume. It can be converted into an HA cluster (Patroni, etcd and HAProxy), and supports
    in-place major upgrades and native volume backups
    ([PostgreSQL guide](https://docs.railway.com/guides/postgresql)).
  - Volumes cost $0.15/GB-month. The default size is 5 GB on Hobby and 50 GB on Pro
    ([volumes](https://docs.railway.com/reference/volumes)).
  - Redis is also a template. We didn't check its details (unverified).
- **Secrets and KMS:**
  - Values are stored as service variables. Sealed variables are never shown in the UI or returned
    by the API, and are not copied to PR or duplicated environments. Railway can sync secrets from
    Doppler ([variables guide](https://docs.railway.com/guides/variables)).
  - We found no KMS and no OIDC to AWS (unverified), so using AWS KMS needs static IAM keys stored
    as sealed variables.
- **TLS and domain:** Apps get a Railway-provided domain. Custom domains are added with a CNAME and
  a TXT record, and certificates are free and auto-renewed
  ([public networking](https://docs.railway.com/guides/public-networking)).
- **Logs and metrics:**
  - Railway has built-in logs and metrics. Log history is 7 days on Hobby and 30 days on Pro
    ([pricing](https://railway.com/pricing)).
  - There is no native log drain. Railway staff suggest running a logging agent, and the
    third-party Locomotive template forwards logs to Datadog, Loki, OTel HTTP and others
    ([Station](https://station.railway.com/questions/i-want-to-export-my-railway-logs-e83ac979),
    [Locomotive](https://railway.com/deploy/locomotive)).
  - For OTel, the app exports to an external backend itself
    ([observability guide](https://docs.railway.com/guides/third-party-observability.md)).
- **Regions:** Railway's only EU region is EU West in Amsterdam (`europe-west4-drams3a`)
  ([regions](https://docs.railway.com/reference/deployment-regions)).
- **Pricing** ([pricing](https://railway.com/pricing)):
  - Hobby costs $5/mo and includes $5 of usage. Pro costs $20 per workspace and includes $20 of
    usage, with unlimited seats.
  - Usage is billed per second: $20 per vCPU-month, $10 per GB-month of RAM, $0.15 per GB-month of
    volume and $0.05 per GB of egress.
  - Only Enterprise has a contractual SLA.
  - **T1 (estimate):** assume the app uses about 0.05 vCPU and 0.25 GB on average, and Postgres
    about 0.02 vCPU and 0.2 GB. That comes to about $6 of usage, so **about $5–10/mo** on Hobby.
  - **Mainnet-ish (estimate):** Pro at $20, plus two app services at 1 vCPU and 2 GB (up to $80 if
    fully used), plus an HA Postgres cluster (roughly $40–70 at small sizes), plus volumes. That is
    **about $60–155/mo**, and the upper end assumes full use.
- **Testnet to mainnet:**
  - Unchanged: the same Dockerfile and `railway.json`, with a separate environment or project per
    network.
  - Changed for mainnet: the Pro plan, HA Postgres and a log forwarder.
- **Team effort:** Lowest of the four: Git auto-deploy, a dashboard, a CLI and config-as-code.
- **Reliability**, from Railway's own postmortems:
  - **2026-05-19/20:** an outage of about 8 h across the whole platform, after Google Cloud
    suspended Railway's account
    ([report](https://blog.railway.com/p/incident-report-may-19-2026-gcp-account-outage)).
  - **2026-02-18 to 21:** sporadic outages from DDoS attacks, plus errors on about 2,700 endpoints
    from a WAF rollout ([report](https://blog.railway.com/p/incident-report-february-19-2026)).
  - **2026-03-30:** the CDN cached authenticated responses for 52 minutes
    ([report](https://blog.railway.com/p/incident-report-march-30-2026-accidental-cdn-caching)).
  - **2026-09-30:** routing returned 404s for about 5 minutes
    ([report](https://blog.railway.com/p/incident-report-sept-30-2026-routing-disruption)).
  - **October and November 2025:** deploys were paused platform-wide more than once
    ([status](https://status.railway.com/cmgr25aqh003srs2sbr3p8kew)).
- **Versus AWS:** Pick Railway only to stand up the T1 testnet fastest. For mainnet, the incident
  record, a single EU region and no keyless AWS access favour AWS.

## 3. Render

- **Always on:** Free web services spin down after 15 minutes without inbound traffic
  ([free tier](https://render.com/docs/free)). Use a paid instance type, and a web service so it
  has a public URL.
- **Stop before start:** not by default.
  - **Default sequence:**
    - Render starts a new instance and switches traffic to it once it is up.
    - 60 s later, the old instance gets SIGTERM, then SIGKILL after the shutdown delay
      ([deploys](https://render.com/docs/deploys)). So there is at least 60 s of overlap.
    - Render waits up to 15 minutes for the new instance's health check, then cancels the deploy
      and keeps the old instance ([health checks](https://render.com/docs/health-checks)).
  - **A running instance** whose health check keeps failing loses traffic after 15 s and is
    restarted after 60 s. That is one more reason to keep the check to liveness only.
  - **Stop-before-start:** attach a persistent disk. Zero-downtime deploys are then off, and Render
    stops the existing instance before bringing up the new one, with a few seconds of downtime
    ([disks](https://render.com/docs/disks)).
  - **Cost of the disk route:** a service with a disk can't scale beyond one instance. That fits
    one service per channel set. Whether the shutdown delay applies on the disk path is unverified.
- **Grace period:** `maxShutdownDelaySeconds`, set in the API or `render.yaml`. The default is 30 s
  and the **maximum is 300 s**; for more, contact support
  ([deploys](https://render.com/docs/deploys)).
- **Postgres, volumes, Redis** ([pricing](https://render.com/pricing)):
  - Render Postgres is fully managed. Plans include 0.1c-256mb at $6/mo, 0.5c-1g at $19, 1c-2g at
    $40 and 1c-4g at $55, with storage at $0.30/GB.
  - The point-in-time recovery (PITR) window is 3 days on Hobby and 7 days on Pro and above.
  - HA needs at least 1 CPU, and the standby is billed like the primary. Replication is
    asynchronous, so a failover can lose a few seconds of writes
    ([HA](https://render.com/docs/postgresql-high-availability)).
  - Key Value (Redis-compatible) costs $10/mo for 256 MB or $20 for 1 GB.
  - Disks cost $0.25/GB-month, with a daily snapshot kept at least 7 days
    ([disks](https://render.com/docs/disks)).
- **Secrets and KMS:** Secrets are environment variables and secret files, with no KMS. OIDC to AWS
  became generally available in July 2026 for Pro workspaces and above, so AWS KMS works with no
  stored keys ([OIDC docs](https://render.com/docs/oidc),
  [changelog](https://render.com/changelog/render-to-aws-oidc-authentication-now-generally-available)).
- **TLS and domain:** TLS is automatic. Hobby includes 2 custom domains and Pro includes 15, then
  each extra domain is $0.25/mo ([pricing](https://render.com/pricing)).
- **Logs and metrics:** Render has service metrics and log streams. Log retention is 7 days on
  Hobby, 14 on Pro and 30 on Scale. An OpenTelemetry metrics stream is available on Pro and above
  ([pricing](https://render.com/pricing)).
- **Regions:** Oregon, Ohio, Virginia, Frankfurt and Singapore, so Frankfurt is the only EU region.
  A service's region can't be changed later ([regions](https://render.com/docs/regions)).
- **Pricing** ([pricing](https://render.com/pricing)):
  - Workspace plans: Hobby is $0 with 1 seat, Pro is $25/mo with unlimited seats, Scale is
    $499/mo. Bandwidth beyond the included amount is $0.15/GB.
  - Compute: 0.5c-512mb is $7/mo, 1c-2g is $25 and 2c-4g is $85.
  - **T1:** $7 for compute, plus Postgres 0.1c-256mb at $6, about $0.30 of storage and a $0.25
    disk, for **about $14/mo** on Hobby. Hobby has one seat; a Pro workspace for the team and OIDC
    makes it **about $39/mo**.
  - **Mainnet-ish:** Pro at $25, plus 2 × 1c-2g at $50, plus two disks at $0.50, plus Postgres
    1c-2g with an HA standby at $80, plus 10 GB × 2 of storage at $6. That is **about $160/mo**.
- **Testnet to mainnet:**
  - Unchanged: one `render.yaml` Blueprint, with a second service and database for mainnet.
  - Changed for mainnet: the Postgres plan, HA and the instance size.
- **Team effort:** Low: a Dockerfile and `render.yaml`, with Git auto-deploy.
- **Reliability:** We found no Render-authored postmortem for 2026. Trackers list these incidents:
  - 2026-06-11: stuck deploys.
  - 2026-06-18: slow certificate issuance, tied to a Let's Encrypt incident.
  - 2026-08-20: deploy problems.
  - 2026-09-27: instability caused by AWS in the Oregon region.

  Sources: [IncidentHub](https://incidenthub.cloud/status/render),
  [IsDown](https://isdown.app/status/render). A contractual SLA comes only with Enterprise.
- **Versus AWS:** Pick Render if we want a Frankfurt PaaS with managed Postgres (PITR, HA) and
  keyless AWS KMS through OIDC, with far less setup than ECS plus RDS. Against: the disk workaround
  for stop-first deploys, and the 300 s grace cap.

## 4. Single VM: Hetzner Cloud or DigitalOcean, with Kamal 2 or Docker Compose

- **Always on:** Yes; it is a VM. Docker restart policies keep the container up. A single VM has no
  automatic host failover.
- **Stop before start:**
  - **Kamal 2:** never stops first. It always boots the new container and waits until it is
    healthy, then stops the old one ([`boot.rb`](https://github.com/basecamp/kamal/blob/main/lib/kamal/cli/app/boot.rb)).
    kamal-proxy checks `GET /up` once per second until `deploy_timeout`, which defaults to 30 s
    ([proxy](https://kamal-deploy.org/docs/configuration/proxy/),
    [overview](https://kamal-deploy.org/docs/configuration/overview/)).
    - **If `/up` depended on the lease,** the new container would be stopped and the deploy would
      fail.
    - **Ways round it:** keep `/up` to liveness only, or run `kamal app stop` before
      `kamal deploy`. That second route isn't a documented deploy mode, so it is unverified as a
      workflow.
  - **Docker Compose:** `docker compose up -d` recreates a changed container in this order:
    1. It creates the new container with a temporary name, without starting it.
    2. It stops the old container.
    3. It removes the old container.
    4. It renames the new container and starts it.

    That is stop-before-start by default
    ([`reconcile.go`](https://github.com/docker/compose/blob/main/pkg/compose/reconcile.go)).
- **Grace period:** no platform cap.
  - Compose's `stop_grace_period` defaults to 10 s, with no stated maximum
    ([Compose spec](https://docs.docker.com/reference/compose-file/services/)).
  - In Kamal, `drain_timeout` defaults to 30 s. For proxied roles `stop_timeout` falls back to
    Docker's 10 s, because kamal-proxy drains requests first
    ([`role.rb`](https://github.com/basecamp/kamal/blob/main/lib/kamal/configuration/role.rb)).
    Set both to 150 s.
- **Postgres, volumes, Redis:**
  - **Hetzner:** no managed database. Options:
    - Postgres in Docker on the VM disk, with backups to Object Storage or a Storage Box as our job.
    - SQLite on the disk.
    - An external managed Postgres. Ubicloud runs managed Postgres in Hetzner Germany from about
      $19/mo ([Ubicloud](https://www.ubicloud.com/use-cases/postgres-and-k8s-on-hetzner)). Neon
      and Supabase are alternatives; their prices weren't checked (unverified).
  - **DigitalOcean (DO):** managed PostgreSQL costs $15.15/mo for 1 GiB and $30.45 for 2 GiB, with
    storage at $0.215/GiB ([pricing](https://www.digitalocean.com/pricing/managed-databases)). It
    takes daily backups, offers PITR over 7 days, and has standby nodes with automatic failover
    ([features](https://docs.digitalocean.com/products/databases/postgresql/details/features/)).
    Managed Valkey (Redis-compatible) is also offered.
- **Secrets and KMS:**
  - `kamal secrets` reads from 1Password, Bitwarden, AWS Secrets Manager, Doppler, GCP and others
    ([secrets](https://kamal-deploy.org/docs/commands/secrets/)). Kamal uploads them to an env file
    on the host with mode 0600
    ([`boot.rb`](https://github.com/basecamp/kamal/blob/main/lib/kamal/cli/app/boot.rb)).
  - Neither Hetzner nor DO has a KMS. AWS KMS needs static IAM keys on the VM, or IAM Roles Anywhere
    with an X.509 certificate
    ([Roles Anywhere](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html)).
- **TLS and domain:** kamal-proxy gets Let's Encrypt certificates with `ssl: true`. That works for a
  single server only and needs port 443 open
  ([proxy](https://kamal-deploy.org/docs/configuration/proxy/)). With Compose, we would run Caddy
  or Traefik.
- **Logs and metrics:** We run all of it ourselves: ship to a hosted backend, or run Prometheus and
  Grafana. See `R-observability-backends.md`.
- **Regions:**
  - Hetzner: Falkenstein and Nuremberg in Germany, Helsinki in Finland; also the US and Singapore
    ([Hetzner Cloud](https://www.hetzner.com/cloud)).
  - DO: FRA1, AMS3 and LON1
    ([regional availability](https://docs.digitalocean.com/platform/regional-availability/)).
- **Pricing, Hetzner** (EUR, excluding VAT):
  - From 2026-06-15: CX23 (2 vCPU, 4 GB) is €5.49 and CX33 is €8.49, CAX11 is €5.99, and CPX22 is
    €19.49, all excluding IPv4
    ([price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)).
  - A primary IPv4 is €0.50/mo
    ([IP prices](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing)).
    Backups cost about 20% of the server price (per a
    [third-party review](https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/)).
  - **Ordering is restricted.** The cheap CX and CAX lines show as not available. Hetzner's status
    notice "Limited availability of cloud instances" restricts new servers for new customers and
    some randomly chosen existing ones
    ([Schmalbach, 2026-09-09](https://www.vincentschmalbach.com/hetzner-cheap-cloud-unavailable-price-increases/),
    [Pulsetic mirror](https://pulsetic.com/status/hetzner/incidents/3687/)).
  - CPX12 (1 vCPU, 2 GB) at €11.99 including IPv4 was orderable, according to a third-party reading
    of Hetzner's price API on 2026-10-07 ([AgentDeals](https://agentdeals.dev/hetzner-pricing-2026)).
  - **T1:** with Postgres or SQLite on the same VM, a CX23 with IPv4 and backups is **about €7/mo**
    if we can order it. Otherwise a CPX12 with backups is **about €14/mo**.
  - **Mainnet-ish:** two CPX22 at about €40, plus a database VM (CPX22) at about €20, plus backups
    at about €12. That is **about €72–85/mo**, plus a load balancer if both instances sit behind
    one URL (price unverified), plus our own operations time.
- **Pricing, DigitalOcean**
  ([Droplets](https://www.digitalocean.com/pricing/droplets),
  [databases](https://www.digitalocean.com/pricing/managed-databases)):
  - Basic Droplets: 1 vCPU and 1 GiB is $6, 1 vCPU and 2 GiB is $12, 2 vCPU and 2 GiB is $18, and
    2 vCPU and 4 GiB is $24.
  - **T1:** a $6 Droplet plus managed Postgres at $15.15 comes to **about $21/mo**. A $12 Droplet
    running Postgres in Docker comes to about $12.
  - **Mainnet-ish:** two Droplets at $18 are $36. Managed Postgres with 2 GiB is $30.45, plus a
    standby billed at the same price (per a third-party source), so about $61. That is
    **about $97/mo**, plus a load balancer (price unverified).
- **Testnet to mainnet:**
  - Unchanged: the same image and deploy file. Kamal destinations or a second Compose file cover the
    second network.
  - Changed for mainnet: more VMs, probably a move to a managed database, and the monitoring stack.
- **Team effort:** Highest. We own provisioning, OS patching, the firewall, backups and restores,
  TLS, monitoring, and recovery when a host fails.
- **Reliability:**
  - Hetzner raised prices on 2026-04-01 and again on 2026-06-15 (CPX22 went from €7.99 to €19.49),
    and capacity is still restricted.
  - DO's 2026 incidents in FRA1 were minor: provisioning on 2026-01-28, DNS between Kubernetes and
    databases on 2026-07-01, and block storage on 2026-08-13
    ([OpenStatus FRA1](https://www.openstatus.dev/status/digitalocean/fra1-2),
    [IsDown](https://isdown.app/status/digitalocean/incidents/615693-dns-lookup-failures-for-managed-database)).
- **Versus AWS:** Pick a VM only on cost, and only if we accept doing the operations ourselves. The
  same Compose or Kamal setup on EC2 would keep the simple stop-then-start deploy, and add IAM roles
  and KMS in the company account. So a VM approach points to EC2 more than to Hetzner or DO.

## Comparison

All prices are monthly and rough. The sources are in the sections above.

| Option | Always on | Stop-before-start | Max SIGTERM grace | Managed Postgres | Keyless AWS KMS | EU region | T1 / month | Mainnet-ish / month | Effort |
|---|---|---|---|---|---|---|---|---|---|
| Fly.io | `auto_stop_machines="off"` (default off) | Yes with 1 Machine and `rolling` (in-place reboot; verify). Avoid `canary` and `bluegreen` | 300 s (`kill_timeout`, best-effort) | MPG from $38, HA included | Yes (OIDC) | ams, fra (no waw) | ~$42 (MPG); ~$4–7 (SQLite on volume) | ~$145–150 | Low |
| Railway | `sleepApplication: false` | Only with a volume attached; otherwise new and old overlap | No documented max (`drainingSeconds`, default 0) | Template plus volume; HA via Patroni template | No (static keys) | Amsterdam only | ~$5–10 (usage estimate) | ~$60–155 (usage estimate) | Lowest |
| Render | Any paid instance | Only with a disk attached; otherwise ≥60 s overlap | 300 s (`maxShutdownDelaySeconds`) | Yes; PITR 3–7 days; HA needs ≥1 CPU | Yes (OIDC, Pro) | Frankfurt only | ~$14 (Hobby, 1 seat); ~$39 (Pro) | ~$160 | Low |
| Hetzner VM + Compose/Kamal | Yes | Compose: yes by default. Kamal: no (new first) | No cap; we set it | None (self-run or external) | No (static keys or Roles Anywhere) | DE, FI | ~€7–14 | ~€72–85 + LB + our ops | High |
| DO VM + Compose/Kamal | Yes | Same as Hetzner | No cap; we set it | Yes, $15.15+; PITR 7 days | No (static keys or Roles Anywhere) | FRA1, AMS3, LON1 | ~$12–21 | ~$97 + LB + our ops | High |

## Caveats and open questions

- **Health checks are liveness only, everywhere.** On Railway, Render and Kamal, a health check
  that depends on the lease makes every deploy fail: Railway after 300 s, Render after 15 min,
  Kamal after 30 s. On Render it would also restart running instances after 60 s of failed checks.
  `/settle` should answer 503 until the lease is held.
- **The lease after a crash.** If a process is SIGKILLed or its host dies, it never releases the
  lease. The next process then waits for the lease TTL to expire. The TTL must be shorter than
  each platform's deploy wait: Fly `wait_timeout` (5 min by default), Railway health-check timeout
  (300 s by default), Kamal `deploy_timeout` (30 s by default).
- **The grace period is not guaranteed.** Every platform gives at least 120 s if configured, but
  Railway's default is 0 and Compose and Kamal default to 10–30 s. Host failures, out-of-memory
  kills and platform maintenance skip the grace period entirely. Fly calls `kill_timeout`
  best-effort. Recovery from a settlement interrupted mid-flight (AD-6 replay, pending records)
  has to work regardless.
- **Two instances on mainnet.** Replicas of one service share one configuration, so they can't
  each have their own `CHANNELS`. Two ways to give each instance its own channel set:
  - one service or app per channel set, with a load balancer in front if they share one URL;
  - each process claims a free lease among N channel sets at startup.

  The second way works on every platform. Deciding between them is an open design question for
  AD-17.
- **Verify by test before the ADR:**
  - Fly: that a one-Machine `rolling` deploy really stops before it starts.
  - Railway: that `drainingSeconds` is honoured when a volume is attached, and what
    `sleepApplication` defaults to.
  - Render: that the shutdown delay applies on the disk path.
- **Unverified:** Railway OIDC (none found), the Fly MPG regional markup, Hetzner and DO
  load-balancer prices, whether Hetzner CX servers can be ordered on our account, and Neon and
  Supabase prices.
- **Prices are moving.** Fly raised memory prices by 20% on 2026-10-01. Hetzner raised prices twice
  in 2026. Recheck before the ADR.
- **AWS is the company default.** OIDC makes keyless AWS KMS signing possible from Fly and Render,
  but not from Railway or a plain VM. If key custody must stay in AWS on mainnet, that favours
  Fly, Render or AWS itself.
