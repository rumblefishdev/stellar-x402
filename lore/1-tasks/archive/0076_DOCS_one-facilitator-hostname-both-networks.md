---
id: "0076"
title: "Record one facilitator hostname for both networks in ADR 0011"
type: DOCS
status: completed
milestone: 1
related_adr: ["0011"]
related_tasks: ["0062", "0026", "0027", "0038", "0077"]
tags: [facilitator, deploy, cloudflare, docs, priority-medium, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
  - https://github.com/rumblefishdev/stellar-x402/pull/75
history:
  - date: "2026-10-27"
    status: active
    who: stkrolikiewicz
    note: >
      The 2026-10-26 daily with Marek settled on one hostname, x402-facilitator.sorobanscan.com,
      for testnet and mainnet; soroban-infrastructure PR #1 already routes it (12cec25).
  - date: "2026-10-28"
    status: completed
    who: stkrolikiewicz
    note: >
      PR #75 merged (0aea547), reviewed by Oskar and Karol: ADR 0011's Network and URL, 0026 and
      0027 name one hostname and one facilitator service, `facilitator`, for both networks, the
      network chosen per request. The rest of the per-network design moved to 0077.
---

# Record one facilitator hostname for both networks in ADR 0011

## Summary

ADR 0011 named two hostnames, `x402-facilitator-testnet.sorobanscan.com` and
`x402-facilitator.sorobanscan.com`, and one tunnel per network. The 2026-10-26 daily settled on
one hostname for both networks, and the Terraform applied for 0062 already has one tunnel, `x402`,
routing `x402-facilitator.sorobanscan.com`. This task brought the ADR and the tasks that quote the
hostname in line.

## Context

- Decided at the daily with Marek on 2026-10-26: one hostname, no staging/production split for now.
- `soroban-infrastructure` `cloudflare/x402.tf` (12cec25, applied 2026-10-27): tunnel `x402`,
  `x402-facilitator.sorobanscan.com` → `http://facilitator:4021`, anything else 404. Only testnet
  is behind it for now. A staging host, `x402-facilitator-staging.sorobanscan.com`, can be added if
  one is needed.
- 0062's own text still names the `-testnet` hostname; it is fixed when 0062 closes.

## Acceptance Criteria

- [x] ADR 0011's Network and URL section names one hostname, one tunnel and its routing target
- [x] 0026 and 0027 quote `x402-facilitator.sorobanscan.com`
- [x] Docs PR to develop (#75)

## Implementation Notes

- `docs/adr/0011-facilitator-hosting.md`: the Date line and Network and URL. One hostname and one
  service, the network named by the client (`stellar:testnet` or `stellar:pubnet`), one tunnel to
  `http://facilitator:4021`, `PORT` tied to `cloudflare/x402.tf`, who decided and where it is
  routed. The section says the per-network parts of the ADR follow in 0077.
- `lore/1-tasks/backlog/0026_FEATURE_public-testnet-deployment.md`: the public URL, and the
  Compose service built as `facilitator`, also where 0026 still says `facilitator-testnet`.
- `lore/1-tasks/backlog/0027_FEATURE_alerts-and-metrics.md`: the uptime check's hostname.

## Design Decisions

### Emerged

1. **One facilitator service, `facilitator`, for both networks** (Stan, after Oskar's review of
   #75): the client names the network in the request, so there is no testnet/mainnet service
   split. A network alias on a per-network service and "mainnet open until 0038" were tried in
   9147f8e and replaced in 653365f.
2. **This PR recorded the decision; 0077 does the rework:** the rest of ADR 0011 (about 150–200
   lines), ADR 0012, 0013, 0004, the spine, 0026 and the code assume one process per network.
   ADR 0011's Network and URL says so, and 0026 says to build the service as `facilitator`.

## Issues Encountered

- **0075 was taken overnight,** so this task is 0076, not the 0071 planned on 2026-10-26.
- **Oskar's review found a contradiction:** the tunnel's `facilitator` didn't match 0026's
  `--exit-code-from facilitator-testnet`, so a deploy built from 0026 would have answered 502.

## Future Work

- 0077: one facilitator service for both networks across the docs and the code (a database per
  network, decided 2026-10-28).
