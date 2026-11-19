---
id: "0143"
title: "Give the snapshot AppRole's secret-id an expiry and a network binding, with rotation steps"
type: FEATURE
status: backlog
related_adr: ["0013"]
related_tasks: ["0123", "0026"]
tags: [deploy, backups, security, priority-medium, effort-small, platform]
links:
  - ../../../docs/runbook.md
history:
  - date: "2026-11-12"
    status: backlog
    who: okarcz
    note: "Spawned from 0123's future work (the review of #137 and Stan's review of #178)."
---

# Give the snapshot AppRole's secret-id an expiry and a network binding, with rotation steps

## Summary

As the admin of the facilitator, I want the `x402-snapshot` AppRole's secret-id to expire and to
work only from the server, and the runbook to say how to rotate it and the Storage Box key, so
that a copied credential is of limited use and a rotation isn't worked out under pressure.

## Context

- The AppRole `x402-snapshot` may only take Raft snapshots, but its secret-id has no expiry and no
  CIDR binding, and the runbook has no rotation for it or for the Storage Box's SSH key (the
  review of #137, deferred in 0123 as a design point for the restore drill).
- The restore drill (0026) restores from the same backup secret and credentials, so the rotation
  steps and the drill should agree.

## Implementation

- Decide the secret-id's TTL and its `secret_id_bound_cidrs` / `token_bound_cidrs` (the address
  OpenBao sees the job's login from), and what renews it before it expires.
- Runbook steps: rotate the secret-id; rotate the Storage Box key (new key, the box's
  `authorized_keys`, the credential, the old key removed).
- An alarm or a check, if an expired secret-id is the failure the job would meet first.

## Acceptance Criteria

- [ ] The secret-id expires and is bound to the address the job logs in from; a login from
      elsewhere is refused (shown once on the server).
- [ ] The runbook has both rotations, and each was run once on the server.
- [ ] The nightly snapshot still runs after each rotation (its stamp is fresh the next morning).
