---
id: "0054"
title: "Decide whether pubnet refuses loopback, private and IP resource URLs"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008"]
related_tasks: ["0053", "0023", "0024", "0025", "0044"]
tags: [bazaar, discovery, priority-low, effort-small]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-10-22"
    status: backlog
    who: claude
    note: >
      Spawned from 0053 Future Work at Oskar's request in the PR #55 review, so that something on
      the way to pubnet points at it. Linked from 0023.
---

# Decide whether pubnet refuses loopback, private and IP resource URLs

## Summary

As the operator of a pubnet facilitator, I want a decision on whether the catalog refuses
loopback, private and IP resource URLs on pubnet, so that the public catalog doesn't list entries
no buyer can reach, or so that we say on purpose that it does.

## Context

- 0053 dropped the host rules on `http(s)` resource URLs on every network: the facilitator never
  fetches them, and SSRF is checked by whoever does, at connection time (ADR 0008).
- On testnet that is needed: the upstream e2e suite and local sellers send `http://localhost:…`.
  On pubnet, such an entry is only noise for buyers.
- The rule would be about listing quality, not SSRF, as the MCP registry refuses `localhost`,
  `127.0.0.1` and `*.localhost`. The network is in `paymentRequirements`, so no config is needed.
- Pubnet is refused by the config until 0023, 0024 and 0025, so this has to be decided before
  that refusal goes.

## Acceptance Criteria

- [ ] Decided and written into ADR 0008: pubnet refuses loopback, private and IP resource URLs,
      or lists them as sent, and why
- [ ] If refused: given a pubnet payment with such a resource URL, when it is validated, then it
      is refused as `invalid_resource_url`, and testnet keeps accepting it
