---
id: "0039"
title: "Move facilitator hosting to the company Hetzner server in ADR 0011"
type: DOCS
status: active
milestone: 1
related_adr: ["0011", "0012", "0013"]
related_tasks: ["0014", "0009", "0013", "0019", "0020", "0023", "0025", "0026", "0027", "0036", "0038", "0047"]
tags: [facilitator, deploy, hosting, operations, priority-high, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-12"
    status: active
    who: stkrolikiewicz
    note: >
      The team moves hosting from ECS Fargate to the company Hetzner server for
      testnet and mainnet. ADR 0011 is revised in place; the facilitator key moves into AWS KMS on
      both networks, and CloudWatch stays.
  - date: "2026-10-20"
    status: active
    who: stkrolikiewicz
    note: >
      The facilitator key lives in OpenBao Transit on the server (ADR 0013, task 0047) instead of
      AWS KMS; AWS stays for logs and metrics only.
  - date: "2026-10-21"
    status: active
    who: stkrolikiewicz
    note: >
      Second review round on PR #24 (Oskar and Adam): a directory and systemd units per network
      own deploys, Postgres and rollback, secrets sit in tmpfs and reach the app as files, reboots
      wait for the drain, backups leave from the host encrypted, logs go through the CloudWatch
      agent, the alarms follow ADR 0013, and testnet deploys from a protected deploy/testnet
      branch.
  - date: "2026-10-22"
    status: active
    who: stkrolikiewicz
    note: >
      Rebased onto #41 and #48. Third review round (Oskar): one OpenBao per server, pgBackRest
      for Postgres, migrations before the old facilitator stops, mainnet promoted by a recorded
      digest, and the Hetzner Cloud VM weighed on its coupling. Design Decisions added.
  - date: "2026-10-22"
    status: active
    who: stkrolikiewicz
    note: >
      The public URL moves to Cloudflare Tunnel on sorobanscan.com (Slack with Marek and Marcin):
      cloudflared per network, the tunnel and DNS in soroban-infrastructure, no Caddy site block.
---

# Move facilitator hosting to the company Hetzner server in ADR 0011

## Summary

ADR 0011 (task 0014) put the facilitator on ECS Fargate. The team decided to run it on the
company's existing Hetzner server, which already hosts ClickHouse and has plenty of free
resources, for both networks. This task revises ADR 0011 in place and updates the tasks that
build on it.

## Context

- **The server, as checked on 2026-10-12** (the specifics are kept out of this public repo):
  - x86_64, with plenty of free CPU, RAM and disk, and ClickHouse held to a memory limit in its
    container;
  - Docker Compose, with Caddy already terminating HTTPS in the same compose project as
    ClickHouse.
- **Decisions taken with Stan on 2026-10-12:**
  - edit ADR 0011 in place, not supersede it;
  - the facilitator key goes into AWS KMS on both networks. Changed on 2026-10-20: it lives in
    OpenBao Transit on the server (ADR 0013, task 0047), and AWS stays for logs and metrics;
  - CloudWatch stays, fed from the server;
  - deploys go through GitHub Actions over SSH with Docker Compose.

## Acceptance Criteria

- [x] ADR 0011 describes hosting on the Hetzner server: containers and limits, stop-before-start
      deploys, the public URL through Cloudflare Tunnel, the key in OpenBao (ADR 0013), Postgres on the server with off-server
      backups, CloudWatch from the server, and the consequences of a shared single server
- [x] The tasks that build on ADR 0011 (0009, 0013, 0019, 0023, 0025, 0026, 0027, 0038), the
      spine and `deploy/README.md` match the revised ADR; 0036 is reshaped by 0047 (ADR 0013)

## Design Decisions

### From Plan

1. **Revise ADR 0011 in place** rather than supersede it; the ECS Fargate version stays in git
   history and task 0014.
2. **CloudWatch stays,** fed from the server, and deploys go through GitHub Actions over SSH with
   Docker Compose (2026-10-12).

### Emerged

From the second review round (Oskar, 2026-10-20), agreed on 2026-10-21:

3. **A directory and systemd units per network** (`/srv/x402/<network>/`, `x402@`,
   `x402-db@`, `x402-deploy@`), so a deploy, a reboot and Postgres each have one owner.
4. **The deploy is a oneshot unit with an automatic rollback by digest,** so a dropped runner
   can't cut it between stop and start.
5. **Reboots wait for the drain:** the units run after `docker.service`, with `TimeoutStopSec`
   200 s.
6. **Testnet deploys from a protected `deploy/testnet` branch,** and `develop` stays open for
   lore status pushes.
7. **The ADR 0013 alarms, memory limits for every container, and a 7-minute uptime alarm.**

From Adam's review (2026-10-21, A1–A11):

8. **Secrets decrypted to tmpfs and read from files** (`*_FILE`, built in 0026), never
   `environment:`.
9. **`migrate-<network>` as its own one-off service,** and Postgres under its own unit.
10. **The CloudWatch agent ships logs,** not `dockerd`'s `awslogs`, so only the agent holds the
    logging role.
11. **Runners use the server's existing SSH port with a pinned host key;** the ClickHouse
    project's CA is the Roles Anywhere trust anchor.
12. **Merge order #41 → #48 → #24,** so this ADR builds on both.

From the third review round (Oskar, 2026-10-21), decided the same day and written on 2026-10-22:

13. **One OpenBao per server** (O1), as ADR 0013 decides; the open question left ADR 0011 and
    0038.
14. **pgBackRest instead of Borg for Postgres** (O2): the lease's WAL, about 23 GB a day at a 60 s
    `archive_timeout`, leaves compressed as each segment closes. Borg stays for OpenBao's
    snapshots. How the database reaches the Storage Box goes to 0026.
15. **Migrations before the old facilitator stops** (O3), in the deploy unit, safe under
    expand/contract; they leave the deploy's downtime.
16. **Mainnet is promoted by a digest testnet recorded** (O4) as a GitHub Deployment, never by
    SHA or tag.
17. **The shared server is kept knowingly** (O5): ADR 0011 weighs the Hetzner Cloud VM on what
    the shared server couples, at about €12–20 a month on testnet.

Taken while writing these, without a separate review:

18. **pgBackRest's passphrase and the Storage Box SSH key are systemd credentials,** with the
    passphrase also in AWS Secrets Manager, since the server's only AWS role can't read secrets
    (Oskar asked the same of Borg's passphrase).
19. **`x402@` neither pulls nor migrates;** it starts the image the deploy already pulled. It
    follows from 15.
20. **The VM is an explicit 0038 item,** the condition Oskar set for keeping the shared server.
21. **During the rebase onto #41 and #48:** the Timing table carries #41's rows, logs name RPC
    endpoints `RPC_URLS[i]#<fingerprint>`, and reading secrets from files moved from 0020
    (nearly done) to 0026.

From the Slack thread with Marek and Marcin (2026-10-22):

22. **Cloudflare Tunnel on `sorobanscan.com` instead of the server's Caddy.** Cloudflare is the
    DNS and the edge; a `cloudflared` per network forwards to its facilitator, with no inbound
    port and nothing in the ClickHouse project's repo. The tunnel, its routing and the DNS record
    are Terraform in `soroban-infrastructure`, beside the zone.
23. **One label under the zone:** `x402-facilitator-testnet.sorobanscan.com` and
    `x402-facilitator.sorobanscan.com`, since the Free plan's certificate covers one level.

Taken while writing the tunnel in:

24. **`cloudflared` gets its own unit (`x402-tunnel@`) and a 128 MiB limit,** so deploys never
    restart it and it stops after the facilitator at a reboot, while answers are still going
    out. The memory totals grow to 1.875 GiB on testnet and 3.5 GiB with both networks.
25. **The tunnel token reaches the server by hand,** fetched from Cloudflare into a systemd
    credential and kept nowhere else, since Cloudflare gives it back at any time (changed on
    2026-10-23 from a copy in AWS Secrets Manager).
26. **The client IP is `CF-Connecting-IP`,** replacing `TRUSTED_PROXY_HOPS` (0023, spine).

From Stan's review of these commits (2026-10-23):

27. **One WAL alarm, and a 26-hour alarm on the daily backup:** pgBackRest acknowledges a segment
    only once it is in the repository, so a separate "shipped" alarm repeated the archive one.
    The daily `pgbackrest backup` gets the 26 hours OpenBao's snapshots have.
28. **The deploy unit decrypts the credentials before it migrates,** with `x402@`'s script, since
    the first deploy migrates before `x402@` has ever run.
29. **The VM's hardware-fault row names a restore,** not an automatic move to a new host, which no
    source here backs.
30. **Marek confirmed the tunnel and the names; the repo is `soroban-infrastructure`,** and Stan
    applies it until an owner is named.

From the rest of round three (Stan, 2026-10-23):

31. **systemd restarts the containers, not Docker** (Oskar's proposal): every unit that runs a
    container is `PartOf=docker.service` and runs Compose in the foreground with
    `Restart=on-failure`, so a Docker restart drains the facilitator with its full grace and starts
    it again. `docker-ce` isn't held; that would be the ClickHouse team's call on a shared server.
32. **`migrate-<network>` sits in the `migrate` profile,** with a 512 MiB limit outside the totals.
33. **The deploy lock lives in `deploy.sh` only,** a `flock` on `digest.next` held through
    `systemctl start`; a second lock in the unit would deadlock.
34. **`digest.good` is written only after `ready`,** and `x402@` starts from it unless a deploy's
    marker in `/run` says otherwise. The first deploy, and a deploy whose dependency is down,
    fail into the alarms.
35. **The deploy reads `ready` with `docker exec`,** so the check depends on neither the tunnel nor
    DNS.
36. **`x402@` has a 60 s `TimeoutStartSec` and runs after OpenBao;** the deploy keeps the current
    and previous good images and prunes the rest.
37. **`x402-db@` decrypts its own credentials and stops within 150 s,** above Postgres's 120 s.
38. **Secret files are mode 0400 for the user that reads them** (`node` 1000, `postgres` 999),
    since Compose's `file:` secrets keep the host's owner outside swarm.
39. **The uptime alarm sits above the worst successful deploy;** a failed one should alarm.
40. **The database volume isn't encrypted at rest, and nothing relies on it:** the data is mostly
    public on chain, the secrets are encrypted on their own, and LUKS would be an extra layer.
41. **The Hetzner Cloud VM is rejected for mainnet too** (Stan, 2026-10-23), so 0038 no longer
    asks it; ADR 0011's Alternatives say why the shared server is kept.
42. **An Ansible playbook provisions x402's parts of the server** (Marek confirmed on Slack,
    2026-10-23): the user, directories, units and timers, compose files, `deploy.sh`, the deploy
    user's `sudo` rule and forced command, `cloudflared`, pgBackRest and the CloudWatch agent, run
    by an admin from a reviewed commit. Per-merge deploys stay a digest over SSH, since Ansible
    from CI would need effectively root on the production ClickHouse server.
