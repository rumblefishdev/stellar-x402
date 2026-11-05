---
id: "0115"
title: "Reboot ch-prod-01 in an agreed window and check that x402 comes back by itself"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0011", "0013"]
related_tasks: ["0091", "0026"]
tags: [deploy, operations, priority-medium, effort-small, platform]
links:
  - ../../../docs/runbook.md
history:
  - date: "2026-11-05"
    status: backlog
    who: okarcz
    note: "Spawned from 0091: the reboot in criterion 2 (decision 3), deferred so ch-prod-01 isn't disturbed now."
---

# Reboot ch-prod-01 in an agreed window and check that x402 comes back by itself

## Summary

As the admin of the facilitator, I want one planned reboot of `ch-prod-01`, so that we know the
hardened services start by themselves in the right order before an unplanned reboot (a kernel
update, a hardware repair) shows it.

## Context

- 0091's criterion 2 asks that a fresh database, a migration, a deploy and a reboot all still work
  with the dropped capabilities. Everything but the reboot passed on the server on 2026-11-05 (0091,
  the second deploy). okarcz deferred the reboot here (0091 decision 3): the server is shared with
  soroban-explorer and prices-api, so a reboot stops their services too, and it wasn't a good time.
- At boot, systemd starts Docker, then `x402-openbao` (it unseals with the seal key, a systemd
  credential), `x402-db-testnet@production`, `x402-tunnel@production` and `x402@production`, which
  needs OpenBao's signature and Postgres. Single unit restarts are tested; this order isn't.
- **Don't reboot without the window agreed** with the team that runs soroban-explorer and
  prices-api.

## Implementation

- Agree a window with the explorer and prices-api team, and tell ours.
- Before: note `/health`, `digest` and `digest.good`, and the units' state.
- `sudo systemctl reboot`.
- After: the four x402 units active with no manual step, OpenBao unsealed, `/health` ready, signer
  ok and listed, `/supported` 200, and the runbook's `docker inspect` loop as in 0091.
- If a unit doesn't come back: its journal, and a pull request for the fix, never an edit on the
  server.

## Acceptance Criteria

- [ ] Given an agreed window, when `ch-prod-01` reboots, then `x402-openbao`,
      `x402-db-testnet@production`, `x402-tunnel@production` and `x402@production` are active with
      no manual step, and `/health` answers ready, signer ok and listed
- [ ] Given the reboot, when the runbook's `docker inspect` loop runs, then every container still
      shows `drop=[ALL]`, `add=[]` and `no-new-privileges:true`
- [ ] The reboot's time and result are recorded in this task and 0091 is linked
