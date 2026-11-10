---
id: "0062"
title: "Create the sorobanscan.com Cloudflare zone and the facilitator's tunnel"
type: FEATURE
status: completed
milestone: 1
related_adr: ["0011"]
related_tasks: ["0039", "0026", "0023", "0027", "0038", "0076", "0077", "0079"]
tags: [facilitator, deploy, cloudflare, priority-high, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
  - https://github.com/rumblefishdev/soroban-infrastructure/pull/1
history:
  - date: "2026-10-23"
    status: backlog
    who: stkrolikiewicz
    note: >
      From 0039 (PR #24): the facilitator is reached through Cloudflare Tunnel on sorobanscan.com,
      confirmed by Marek; Marcin proposed the soroban-infrastructure repo. Stan starts the repo with
      only the zone and the x402 testnet tunnel.
  - date: "2026-10-23"
    status: active
    who: stkrolikiewicz
    note: "Started."
  - date: "2026-10-28"
    status: completed
    who: stkrolikiewicz
    note: >
      soroban-infrastructure PR #1 merged and applied (7 resources); Marcin turned DNSSEC off and
      moved the name servers at OVH; the zone is active and the hostname answers Cloudflare's
      530 / error 1033 until 0026 runs cloudflared. One hostname and one tunnel, x402, for both
      networks (0076). DNSSEC on Cloudflare's side spawned as 0079.
---

# Create the sorobanscan.com Cloudflare zone and the facilitator's tunnel

## Summary

ADR 0011, as revised in 0039 (PR #24), puts the facilitator behind Cloudflare Tunnel: Cloudflare
is the DNS and the edge, and `cloudflared` forwards the hostname to the facilitator. This task
started the `soroban-infrastructure` repo with the `sorobanscan.com` zone and the facilitator's
tunnel, so 0026 can deploy to `x402-facilitator.sorobanscan.com`.

## Context

- `sorobanscan.com` was registered at OVH, on OVH's name servers, with only OVH's default records.
  Marcin has the OVH access. The explorer and the Prices API move there later; that migration is
  Karol's and adds its own records to the same zone.
- The company Cloudflare account is on the Free plan, which takes only a whole domain as a zone
  (`dns-cloudformation` hit error 1116) and covers one level of subdomain with its certificate,
  hence one label. Since the 2026-10-26 daily that is one hostname for both networks,
  `x402-facilitator` (0076).
- Marcin proposed `rumblefishdev/soroban-infrastructure` with Terraform in `cloudflare/`. Stan
  applies it for now.
- Related tasks: 0039 (the decision), 0026 (runs `cloudflared` and fetches the token), 0023 (the
  client IP from `CF-Connecting-IP`), 0027 (the uptime check on this hostname), 0038 (mainnet),
  0076 and 0077 (one hostname and one facilitator for both networks).

## Acceptance Criteria

- [x] Given the repo, when `terraform plan` runs on a clean state, then it creates only the zone,
      its settings, the tunnel, its routing and its DNS record (7 resources, applied 2026-10-27)
- [x] Given the applied zone and the name servers changed at OVH, when the zone is checked in
      Cloudflare, then it is active and `dig NS sorobanscan.com` returns Cloudflare's servers
      (active 2026-10-28 12:37; `hadlee` and `tadeo.ns.cloudflare.com` in `.com`)
- [x] Given the tunnel, when `x402-facilitator.sorobanscan.com` is requested before 0026 deploys,
      then Cloudflare answers for it (HTTPS 530, `error code: 1033`, `server: cloudflare`, after
      the edge certificate went active at 12:40)
- [x] Given the tunnel, when 0026 needs its token, then it can be fetched from the Cloudflare API
      without a copy anywhere else (checked 2026-10-27)

## Implementation Notes

- **soroban-infrastructure PR #1** (merged 2026-10-26, `09bdd71`): `cloudflare/zone.tf` (the zone,
  SSL "Full (strict)", Always Use HTTPS, TLS 1.2 minimum), `cloudflare/x402.tf` (tunnel `x402`,
  `config_src = "cloudflare"`, `x402-facilitator.sorobanscan.com` → `http://facilitator:4021`,
  anything else 404, a proxied CNAME to the tunnel), outputs `zone_id` and `name_servers`.
- **State:** the shared Soroban bucket `production-soroban-explorer-cf-tfstate`, key
  `soroban-infrastructure/cloudflare.tfstate`, with `use_lockfile` (`41612c2`).
- **Token:** in AWS Secrets Manager, `soroban/cloudflare/infrastructure-api-token`
  (eu-central-1), read through an ephemeral resource so it stays out of the state (`7ef8c3d`,
  Terraform 1.10 or later). Since 2026-10-28: Zone Read and Zone Settings, SSL and DNS Edit on
  `sorobanscan.com` only, Cloudflare Tunnel Edit on the account, no expiry; `terraform plan` is
  clean with it, and the first token, which reached every zone on the account, is revoked.
- **Ids:** zone `326b5d1e58e3416773d540668517aece`, tunnel `889815e1-9144-423b-b8db-7f456f5cc71f`
  (`inactive` until 0026 runs `cloudflared`).
- **OVH (Marcin, 2026-10-28):** DNSSEC off, then the name servers. The DS was gone from `.com` the
  same day, and 1.1.1.1 and 8.8.8.8 answered NOERROR.

## Design Decisions

### Emerged

1. **One hostname and one tunnel, `x402`, for both networks** (the 2026-10-26 daily, `12cec25`):
   the tunnel routes to the Compose service `facilitator`, not `facilitator-testnet` (0076, 0077).
2. **State in the shared Soroban bucket** instead of a bucket of the repo's own (`41612c2`).
3. **The token stays out of the state** through an ephemeral Secrets Manager read (`7ef8c3d`).
4. **A new token instead of editing the old one:** Cloudflare's edit form wouldn't scope the old
   token to a specific zone, while the create form would. Zone Edit became Read, since the zone
   exists and `terraform plan` needs only to read it.

## Issues Encountered

- **DNSSEC was on at OVH** (a DS in `.com`, TTL 86400). Moving the name servers first would have
  made validating resolvers answer SERVFAIL, so Marcin turned it off first.
- **Browser Integrity Check is on** in the zone, Cloudflare's default, which `zone.tf` doesn't
  set; it answers non-browser clients with error 1010. Recorded in 0026 to fix before the first
  deploy (`55cb033`), with Bot Fight Mode, which the token can't read.
- **HTTPS failed for about three minutes after activation:** the Universal SSL certificate was
  `pending_validation` until 12:40; plain HTTP already got Cloudflare's redirect.

## Future Work

- 0079: DNSSEC on Cloudflare's side, with Cloudflare's DS entered at OVH.
- In 0026 already: Browser Integrity Check off for the hostname, Bot Fight Mode checked.
