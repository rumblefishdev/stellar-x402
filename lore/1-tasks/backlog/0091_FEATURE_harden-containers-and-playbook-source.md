---
id: "0091"
title: "Drop the containers' capabilities and run the playbook from a protected branch before the signer lands"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011"]
related_tasks: ["0026", "0036"]
tags: [deploy, security, priority-medium, effort-small, platform]
links: []
history:
  - date: "2026-10-30"
    status: backlog
    who: stkrolikiewicz
    note: "Spawned from 0026: the two items Karol left for later in his review of #91."
---

# Drop the containers' capabilities and run the playbook from a protected branch before the signer lands

## Summary

Two gaps that are acceptable while the facilitator holds no signer, and not once 0036 lets it ask
OpenBao to sign. Its containers keep Docker's default capabilities, and the playbook, which
installs what root runs on the shared server, comes from `develop`, which has no protection.

## Context

- `deploy/production/compose.yaml` sets `read_only` and memory limits, but no `cap_drop` and no
  `no-new-privileges`.
- The runbook runs the playbook from `origin/develop` and calls that commit the boundary around
  production. Anyone with write access can push to `develop` without a review. Protecting it isn't
  free: lore status changes go straight to it.
- `deploy/production` doesn't exist yet. The runbook creates it before the first deploy, protected
  by a pull request with an approving review and no bypass, so CI's way to the server is reviewed
  and the admin's isn't.

## Implementation

- Compose: `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]` on `facilitator`,
  `migrate-testnet` and `cloudflared`. `postgres-testnet` starts as root and drops to `postgres`,
  so it keeps what its entrypoint needs, found by a run on a fresh volume, not guessed.
- 0036's OpenBao container gets the same treatment when it arrives.
- Playbook: the runbook and the playbook's header run it from `origin/deploy/production`.
- A change under `deploy/` merged to `deploy/production` also starts a deploy, since the workflow's
  `paths-ignore` doesn't cover it. The runbook says which comes first, the playbook or that merge.

## Acceptance Criteria

- [ ] Given the running services, when `docker inspect` reads them, then each shows its dropped
      capabilities and `no-new-privileges`
- [ ] Given those settings, when a fresh database starts, a migration runs, a deploy restarts the
      facilitator and the server reboots, then all of them still work
- [ ] Given the runbook, when an admin follows it, then the playbook comes from a commit on
      `deploy/production`
- [ ] Given a change under `deploy/`, when it ships, then the runbook gives the order of the
      playbook run and the deploy
