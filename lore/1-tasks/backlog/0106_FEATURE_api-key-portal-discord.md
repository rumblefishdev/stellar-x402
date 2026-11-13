---
id: "0106"
title: "Issue API keys from our portal after Discord sign-in"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0007"]
related_tasks: ["0024", "0105", "0107"]
tags: [facilitator, portal, security, before-pubnet, priority-high, effort-large, platform]
links:
  - ../../../docs/adr/0007-fee-abuse-containment.md
history:
  - date: "2026-11-03"
    status: backlog
    who: akot
    note: "Spawned from 0024: keys on pubnet come from our portal, as in stellar-prices-api."
---

# Issue API keys from our portal after Discord sign-in

## Summary

A seller gets the pubnet API key (0105) from our own portal, after signing in with Discord, the
way stellar-prices-api issues its keys (decided by akot, 2026-11-03). That project's
`docs/epics/self-service-onboarding.md` and its ADR 0010 record the flow and why each gate is
there; most of its portal (`web/portal/`) can be reused. A key must cost something, or the Sybil
attack from 0024 moves from addresses to keys: here it costs a Discord account in the Stellar
Developers server.

## Implementation

- Discord OAuth with `identify` and `guilds.members.read`: the account must be a member of
  Stellar Developers (`897514728459468821`) with its Membership Screening cleared (not `pending`),
  and at least 5 minutes old (from its snowflake). Checked when a key is issued.
- One active key per Discord account. Rotating or revoking takes effect at once, and the usage
  stays with the account, not the key: our registry can sum per account, unlike AWS usage plans,
  so prices-api's once-a-month rotation limit isn't needed.
- A dashboard: the key's state and the account's use of its free quota (0107).
- A privacy policy for the Discord IDs we keep, as prices-api has.
- From 0105: the portal writes the registry through `ApiKeyStore` (`issue`, `revoke`), with the
  owner `discord:<snowflake>`. `issue` refuses an owner that has an active key, and a revocation
  holds from the next request. The registry keeps only a key's SHA-256, so a key can be shown
  once: that settles the third decision below unless the portal keeps keys itself.

## Decisions to make here

- Where the portal and its backend run: the facilitator is on the Hetzner server (ADR 0011), and
  prices-api's backend is AWS Lambda and API Gateway. In the facilitator, or a service of its own?
- One Discord application with prices-api (one sign-in for both products) or our own.
- The key shown once (we keep only its hash, 0105) or viewable again, as in prices-api.
- How much of prices-api's portal to copy, and how its fixes reach both.

## Acceptance Criteria

- [ ] Given a Discord account that meets the gates, when it signs in, then it gets one pubnet key
- [ ] Given an account outside Stellar Developers, still pending screening, or younger than 5
      minutes, when it asks for a key, then it is refused and told why
- [ ] Given an account with a key, when it rotates or revokes it, then the old key stops working
      and the account's quota use carries over
- [ ] Given the portal, when it is live, then its privacy policy says which Discord data we keep
