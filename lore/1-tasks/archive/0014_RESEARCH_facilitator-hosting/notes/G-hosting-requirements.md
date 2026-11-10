---
title: "Hosting requirements for T1 and mainnet"
type: generation
status: mature
spawned_from: README.md
spawns:
  - R-cloud-container-options.md
  - R-paas-and-vm-options.md
  - R-observability-backends.md
  - S-hosting-decision.md
tags: [hosting, requirements]
links:
  - ../../../../../docs/architecture/m1-spine.md
  - ../../../../../packages/signer-pool/src/submitter.ts
history:
  - date: "2026-10-08"
    status: developing
    who: stkrolikiewicz
    note: "Requirements written from the M1 spine, the signer-pool defaults and the company context."
  - date: "2026-10-09"
    status: mature
    who: stkrolikiewicz
    note: "Used for the comparison; the decision is ADR 0011."
---

# Hosting requirements for T1 and mainnet

## What runs

One Node 22 (Express 5) container per network: `apps/facilitator`. It holds the channel pool
(in-memory sequence tracking, background confirmation, a ledger clock), `/verify`, `/settle`,
`/supported` and `/discovery/resources`. It's the only deployable service (AD-1).

## Hard constraints (both T1 and mainnet)

- **Always on.** Long-lived process with background work between requests: no scale-to-zero, no
  sleeping, no per-request CPU throttling. This rules out serverless functions.
- **One process per channel set (AD-17).** Deploys stop the old process before the new one
  starts. No rolling overlap. The store lease enforces this too: a second process can't take it
  and doesn't serve `/settle`. The host must not deadlock on that: a new instance can't become
  "ready" by holding the lease while the old one still runs.
- **Graceful shutdown long enough to drain.** On SIGTERM the process refuses new `/settle` and
  waits until in-flight submissions are final or recorded as pending. With the pool defaults
  (`timeoutSeconds` 60 + `confirmGraceSeconds` 30), one submission can take up to ~90 s, so the
  host's stop grace period must be **at least 90–120 s**. If the host's limit is lower, we lower
  `timeoutSeconds` to fit.
- **Public HTTPS URL.** The e2e gate proxy and resource servers call it (AD-15). The platform's
  default URL is enough for T1. Whether we get a company subdomain is still open.
- **Secrets.** `FACILITATOR_SECRET` comes from the platform's secret store, never from the image
  or the logs (AD-12, 0026). Testnet and mainnet never share a key, a channel set or a deployment.
- **State.** The store is chosen in 0013 (Discovery). The likely candidates are managed Postgres
  or SQLite on a persistent volume, so the host must offer at least one of them.

## T1 (testnet, now)

- One small instance (≈0.25–1 vCPU, 512 MB–1 GB), low traffic.
- Cheap: a testnet service that runs only for the gate and early sellers.
- Logs and basic metrics visible to the team; alerts to Slack for the AD-18 conditions (0027).
- Deploys from GitHub Actions, built from the repo's Dockerfile (0026).

## Mainnet (later tranche)

- Uptime 99%+ (`docs/monitoring.md`), measured by an external check.
- Possibly more than one instance, each with its own channel set and lease.
- Key custody: the facilitator key is Ed25519. A KMS that signs Ed25519 can replace the
  in-memory key through the pool's `TransactionSigner`.
- Backups for the store, and a runbook for deploy, rollback and key rotation.
- Whatever we pick for T1 should carry over with config changes, not a re-platform.

## Company context

- **Rumble Fish's default cloud is AWS**, with an existing company account. Other options are
  still compared, but AWS needs a reason not to be used.
- **Same account as sorobanscan and the Stellar Prices API,** for testnet and mainnet alike.
- Domain for the public URL: open, being checked with the team.
