---
id: "0070"
title: "Mark catalog listings whose seller proves its payTo with stellar.toml"
type: FEATURE
status: backlog
milestone: 1
related_adr: ["0008"]
related_tasks: ["0063"]
tags: [bazaar, discovery, security, priority-low, effort-small]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-10-27"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063: copying a listing from the seller's 402 stops a payer's text, not a
      page of the attacker's own that names someone else's payTo.
---

# Mark catalog listings whose seller proves its payTo with stellar.toml

## Summary

As a buyer browsing the Bazaar, I want to see which listings come from a seller that proved it
controls both the resource's domain and the `payTo` account, so that a page naming someone
else's account doesn't look as trusted as the real seller.

## Context

- After 0063 a listing is copied from whatever answers at its URL. Anyone can serve a 402 that
  names another seller's `payTo` from their own host; the money still reaches that account, but
  the listing misstates who runs the service.
- SEP-1 lets a domain list the accounts it controls in `/.well-known/stellar.toml`
  (`ACCOUNTS`), and an account point back with `home_domain`
  (github.com/stellar/stellar-protocol `ecosystem/sep-0001.md`). The seller's cost: one file and
  one `set_options` transaction; a contract (`C…`) account has no `home_domain`.
- The x402 spec has no ownership proof; a `/.well-known/x402` manifest is still under discussion
  upstream (x402-foundation/x402 PR #2646).

## Implementation

- When a listing's 402 check passes, read the `payTo` account's `home_domain` and the resource
  host's `stellar.toml`; mark the listing verified when both point at each other.
- Show the mark in `/discovery/resources`; a listing without it stays listed.

## Acceptance Criteria

- [ ] Given a seller whose `stellar.toml` lists its `payTo` and whose account's `home_domain` is
      the resource host, when its listing is checked, then the listing is marked verified
- [ ] Given a page that names another domain's `payTo`, when it is checked, then it is listed
      without the mark
