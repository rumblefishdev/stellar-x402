---
id: "0076"
title: "Record one facilitator hostname for both networks in ADR 0011"
type: DOCS
status: active
milestone: 1
related_adr: ["0011"]
related_tasks: ["0062", "0026", "0027", "0038"]
tags: [facilitator, deploy, cloudflare, docs, priority-medium, effort-small, platform]
links:
  - ../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-10-27"
    status: active
    who: stkrolikiewicz
    note: >
      The 2026-10-26 daily with Marek settled on one hostname, x402-facilitator.sorobanscan.com,
      for testnet and mainnet; soroban-infrastructure PR #1 already routes it (12cec25).
---

# Record one facilitator hostname for both networks in ADR 0011

## Summary

ADR 0011 names two hostnames, `x402-facilitator-testnet.sorobanscan.com` and
`x402-facilitator.sorobanscan.com`, and one tunnel per network. The 2026-10-26 daily settled on
one hostname for both networks, and the Terraform applied for 0062 already has one tunnel, `x402`,
routing `x402-facilitator.sorobanscan.com`. This task brings the ADR and the tasks that quote the
hostname in line.

## Context

- Decided at the daily with Marek on 2026-10-26: one hostname, no staging/production split for now.
- `soroban-infrastructure` `cloudflare/x402.tf` (12cec25, applied 2026-10-27): tunnel `x402`,
  `x402-facilitator.sorobanscan.com` → `http://facilitator:4021`, anything else 404. Only testnet
  is behind it for now; mainnet most likely joins the same multi-network process (0038). A staging
  host, `x402-facilitator-staging.sorobanscan.com`, can be added if one is needed.
- 0062's own text still names the `-testnet` hostname; it is fixed when 0062 closes.

## Acceptance Criteria

- [x] ADR 0011's Network and URL section names one hostname, one tunnel and its routing target
- [x] 0026 and 0027 quote `x402-facilitator.sorobanscan.com`
- [ ] Docs PR to develop
