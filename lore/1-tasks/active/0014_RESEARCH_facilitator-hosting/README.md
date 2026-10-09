---
id: "0014"
title: "Choose where the facilitator is hosted and record it in an ADR"
type: RESEARCH
status: active
milestone: 1
related_adr: ["0006", "0009"]
related_tasks: ["0012", "0013"]
tags: [facilitator, deploy, hosting, operations, priority-high, effort-small, platform]
links:
  - ../../../../deploy/README.md
  - ../../../../docs/runbook.md
  - ../../../../docs/monitoring.md
  - ../../../../docs/planning/m1-epics.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Spawned from the 0012 M1 architecture session: the hosting choice needs its own research."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Added the deploy, observability and public-URL requirements from the final M1 spine."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Tagged Platform lane by 0012; decision task feeding M1 Epic 2."
  - date: "2026-10-08"
    status: active
    who: stkrolikiewicz
    note: "Started by the Platform lane owner."
---

# Choose where the facilitator is hosted and record it in an ADR

## Summary

Research where the facilitator service runs, pick a hosting platform and a container setup, and
record the choice in an ADR. The T1 gate needs a public testnet facilitator, so this can't wait
for the mainnet milestone as `deploy/README.md` currently says.

## Context

- **T1 gate:** the canonical x402 e2e client completes `exact` verify → settle against our testnet
  facilitator, through a proxy under `e2e/facilitators/external-proxies/` that forwards to our
  public URL.
- **What runs:** one Node 22 service (Express 5). It holds:
  - the channel pool (long-lived process, background confirmation, a ledger clock)
  - verify and settle
  - Bazaar `resources`
- **State:** the store is chosen in 0013. Hosting and store choices affect each other: a managed
  database, a persistent volume and a network path all depend on the host.
- **Secrets:** the facilitator key signs every settlement (channels and fee bumps). Testnet and
  mainnet never share keys (`deploy/README.md`).
- **Later needs:** mainnet, uptime target 99%+ (`docs/monitoring.md`), more than one instance
  possible, metrics and alerts from `onEvent`.
- **From the final M1 spine:**
  - one process owns a network's channel set through a lease, so deploys must stop the old
    process before the new one starts, with no rolling overlap (AD-17);
  - the logger, metrics and alert backend are chosen here;
  - the e2e gate proxy needs a public HTTPS URL (AD-15).

## Implementation Plan

### Step 1: Requirements

- Separate T1 needs (testnet, one instance, public HTTPS URL, cheap) from mainnet needs (uptime,
  more than one instance, key custody, monitoring).
- Long-lived process: the pool must not be scaled to zero or killed mid-settlement. Note what
  this rules out (e.g. serverless functions).
- Secret handling for the facilitator key: env secrets versus a KMS; the pool's
  `TransactionSigner` is already KMS-pluggable.
- Find out whether there is a team or company default platform or an existing account.
- From 0017: logs must not carry RPC URLs as they are, since an RPC URL can hold an API key.
  The platform's log pipeline also decides the logger backend: 0017's `jsonLogger` writes JSON
  lines to stdout by hand; switch to pino if transports or redaction need it.

### Step 2: Compare options

- At least three, for example:
  - a PaaS (Fly.io, Railway or Render)
  - a cloud container service (AWS ECS/Fargate or GCP Cloud Run with min instances)
  - a company Kubernetes cluster, if one exists
- Criteria:
  - fit for a long-lived process
  - managed database option (for 0013)
  - secrets and KMS support
  - TLS and a custom domain
  - logs and metrics
  - region
  - cost on testnet and mainnet
  - how much carries over unchanged from testnet to mainnet
  - effort for the team
- Check current pricing and features on the web.
- Record findings as R- and S- notes in `notes/`.

### Step 3: Decide and record

- Pick the platform and the container setup (Dockerfile, image registry, deploy trigger).
- Write the ADR in `docs/adr/` with the next free number. It must include:
  - context
  - options considered
  - the decision, with the reasons it beats the alternatives
  - consequences (cost, key handling, path to mainnet)
- Update `deploy/README.md` so it no longer says hosting is chosen in the mainnet milestone.

## Acceptance Criteria

- [ ] T1 and mainnet hosting requirements written down
- [ ] At least three options compared against the criteria above, with sources
- [ ] Platform and container setup chosen, including stop-before-start deploys
- [ ] Logger, metrics and alerting backend chosen
- [ ] ADR in `docs/adr/` documenting the decision and explaining why it was made over the
      alternatives, linked from this task's `related_adr`
- [ ] `deploy/README.md` and the 0012 architecture spine updated to reference the ADR
