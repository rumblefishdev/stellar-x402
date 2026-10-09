---
id: "0026"
title: "Public testnet deployment"
type: FEATURE
status: backlog
milestone: 1
related_adr: []
related_tasks: ["0012", "0014", "0022", "0017"]
tags: [facilitator, deploy, priority-high, effort-medium, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 2.5 (Platform lane)."
---

# Public testnet deployment

## Summary

As a anyone integrating with or testing the facilitator, including the gate, I want the facilitator at a public HTTPS testnet URL, so that the e2e proxy and real resource servers can reach it.

**Story:** [M1 Story 2.5](../../../docs/planning/m1-epics.md#story-25-public-testnet-deployment) · **Lane:** Platform · **Covers:** FR21 prerequisite; NFR4, NFR9

## Context

- Needs the 0014 hosting ADR and the 0022 adapters.
- Related tasks: 0014, 0022, 0017.

## Implementation

- Dockerfile, image build and the deploy trigger from 0014.
- Secrets and stores configured on the platform; runbook updated.
- From 0014 ([ADR 0011](../../../docs/adr/0011-facilitator-hosting.md)): ECS on Fargate, one
  service with `desiredCount` 1, `minimumHealthyPercent` 0, `maximumPercent` 100 and
  `stopTimeout` 120, behind an ALB (idle timeout 120 s, deregistration delay 10 s,
  `TRUSTED_PROXY_HOPS=1`). ARM64 image built on `ubuntu-24.04-arm`, pushed to ECR by SHA,
  deployed through OIDC with `wait-for-service-stability`. Infrastructure as a CDK stack in
  `deploy/infra/`.
- From 0014: add `GET /health`, answering 200 while the HTTP server is up and checking nothing
  else; the ALB uses it.
- From 0014: `FACILITATOR_SECRET` as an SSM SecureString under `/x402/testnet/`, readable only by
  the task execution role.
- From 0014: the AWS account is the one that runs sorobanscan and the Prices API. Still open with
  the team: the region (eu-central-1 assumed), the `rumblefish.dev` subdomain (proposed `testnet.x402.rumblefish.dev`) and access to its Route 53
  zone. Without DNS, put CloudFront's default domain in front of the ALB.

## Acceptance Criteria

- [ ] Given the platform chosen in the 0014 ADR, when a deploy runs, then a container image built from the repo is deployed to it as the ADR describes, and the service answers `/supported` at a public HTTPS URL
- [ ] Given a running instance, when a new version is deployed, then the old process stops before the new one starts; the process is long-lived and never scaled to zero
- [ ] Given the facilitator key, when the service is deployed, then it comes from the platform's secret store, never from the image or the logs, and is a testnet-only key
- [ ] Given the durable stores from 0022, when the service runs, then it uses them, and `docs/runbook.md` has the deploy and rollback steps
