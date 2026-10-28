---
id: "0079"
title: "Turn on DNSSEC for sorobanscan.com in Cloudflare"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0011"]
related_tasks: ["0062"]
tags: [cloudflare, dns, priority-low, effort-small, platform]
links: []
history:
  - date: "2026-10-28"
    status: backlog
    who: stkrolikiewicz
    note: "Spawned from 0062 future work: DNSSEC was turned off at OVH for the move to Cloudflare."
---

# Turn on DNSSEC for sorobanscan.com in Cloudflare

## Summary

DNSSEC was on at OVH and was turned off so the name servers could move to Cloudflare (0062). The
zone has been active in Cloudflare since 2026-10-28 and is unsigned. This task signs it again,
now with Cloudflare's key.

## Context

- The chain of trust needs a DS record for the zone in `.com`, which only the registrar can set:
  Marcin, at OVH.
- Nothing serves on `sorobanscan.com` yet apart from the facilitator's tunnel hostname, so a
  mistake costs little now; it costs more once sorobanscan and the Prices API move in.

## Implementation

- Terraform in `soroban-infrastructure`'s `cloudflare/`: enable DNSSEC on the zone (the
  provider's `cloudflare_zone_dnssec`) and output the DS record. Check which token permission it
  needs; the token is scoped to `sorobanscan.com`.
- Ask Marcin to enter the DS record at OVH.
- Check: `dig +short DS sorobanscan.com` returns it, `dig +dnssec` answers carry signatures, and
  1.1.1.1 and 8.8.8.8 answer NOERROR (a mismatch shows as SERVFAIL).

## Acceptance Criteria

- [ ] Given the zone, when DNSSEC is checked in Cloudflare, then it is active, from Terraform
- [ ] Given the DS at OVH, when `x402-facilitator.sorobanscan.com` is resolved through validating
      resolvers, then they answer NOERROR with signed records
