---
id: "0062"
title: "Create the sorobanscan.com Cloudflare zone and the facilitator's testnet tunnel"
type: FEATURE
status: active
milestone: 1
related_adr: ["0011"]
related_tasks: ["0039", "0026", "0023", "0027", "0038"]
tags: [facilitator, deploy, cloudflare, priority-high, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
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
---

# Create the sorobanscan.com Cloudflare zone and the facilitator's testnet tunnel

## Summary

ADR 0011, as revised in 0039 (PR #24), puts the facilitator behind Cloudflare Tunnel:
Cloudflare is the DNS and the edge, and a `cloudflared` per network forwards its hostname to the
facilitator. Nothing of that exists yet. This task starts the `soroban-infrastructure` repo with
the `sorobanscan.com` zone and the testnet tunnel, so 0026 can deploy to
`x402-facilitator-testnet.sorobanscan.com`.

## Context

- `sorobanscan.com` is registered at OVH, still on OVH's name servers, with no mail and no
  records. Marcin has the OVH access. The explorer and the Prices API move there later; that
  migration is Karol's and adds its own records to the same zone.
- The company Cloudflare account is on the Free plan, which takes only a whole domain as a zone
  (`dns-cloudformation` hit error 1116) and covers one level of subdomain with its certificate,
  hence one label: `x402-facilitator-testnet` and, for mainnet, `x402-facilitator`.
- Marcin proposed `rumblefishdev/soroban-infrastructure` with Terraform in `cloudflare/`, values
  from `dns-cloudformation` read through SSM when needed. Stan applies it for now.
- Follow `dns-cloudformation/cloudflare/` and the explorer's `infra/cloudflare/`: provider
  `cloudflare/cloudflare ~> 5.19`, an S3 backend with `use_lockfile`, the state bucket from
  `state-bucket.yaml`, and the API token only in `CLOUDFLARE_API_TOKEN`.
- Related tasks: 0039 (the decision), 0026 (runs `cloudflared` and fetches the token), 0023 (the
  client IP from `CF-Connecting-IP`), 0027 (the uptime check on this hostname), 0038 (the mainnet
  tunnel).

## Implementation

- **Repo:** `rumblefishdev/soroban-infrastructure`, private, with a README naming its scope (the
  zone and the x402 tunnels now; the explorer and Prices API records come with the migration).
- **State and token:** the state bucket in the Soroban AWS account; a Cloudflare API token that can
  create the zone and edit its DNS, settings and SSL, and edit tunnels on the account, kept in AWS
  Secrets Manager like `dns-cloudformation`'s.
- **Zone:** `cloudflare_zone` `sorobanscan.com` (`full`), and `cloudflare_zone_setting` for SSL
  "Full (strict)", Always Use HTTPS and TLS 1.2 minimum, as `dns-cloudformation` sets them. Output
  `name_servers`; Marcin sets them at OVH.
- **Zero Trust:** check in the dashboard that it is enabled on the account (Free plan); if not,
  agree the team name with Marek or Marcin first.
- **Testnet tunnel:** `cloudflare_zero_trust_tunnel_cloudflared` `x402-testnet` (`config_src =
  "cloudflare"`), its `_config` routing `x402-facilitator-testnet.sorobanscan.com` to
  `http://facilitator-testnet:4021` and anything else to `http_status:404`, and a proxied CNAME to
  `<tunnel id>.cfargotunnel.com`. The token is a sensitive output, fetched only when 0026 deploys
  (ADR 0011: kept nowhere else).
- **Out of scope:** the explorer's and the Prices API's records, WAF and rate-limit rules,
  Turnstile, and the mainnet tunnel (0038).
- **Review:** a pull request with the `terraform plan` output, reviewed by Marcin or Karol, before
  `terraform apply`.

## Acceptance Criteria

- [ ] Given the repo, when `terraform plan` runs on a clean state, then it creates only the zone,
      its settings, the testnet tunnel, its routing and its DNS record
- [ ] Given the applied zone and the name servers changed at OVH, when the zone is checked in
      Cloudflare, then it is active and `dig NS sorobanscan.com` returns Cloudflare's servers
- [ ] Given the tunnel, when `x402-facilitator-testnet.sorobanscan.com` is requested before 0026
      deploys, then Cloudflare answers for it (an error page, since no `cloudflared` runs yet)
- [ ] Given `terraform output`, when 0026 needs the tunnel token, then it can be fetched without
      a copy anywhere else
