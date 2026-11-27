---
id: "0070"
title: "Mark catalog listings whose seller proves its payTo with stellar.toml"
type: FEATURE
status: active
owner: karolkow
milestone: 2
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
  - date: "2026-11-26"
    status: active
    who: karolkow
    note: >
      Started: the stellar.toml proof is the search's curation, a bonus in the ranking.
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

- On every paid call whose listing is in the catalog, apart from the check of the seller's 402,
  at most once per 6 h per host and `payTo`, read the
  host's `stellar.toml` and the `payTo` account's `home_domain` on the facilitator's network. The
  listing is curated when `ACCOUNTS` lists the `payTo` and `home_domain` is the resource host.
- Keep the result per network, host and `payTo`, with when it was checked. Any answer from the
  host finishes the check (a status other than 200 is no proof) and starts the 6 h wait. A failed
  check (timeout, network error, the RPC) counts as no proof until a check passes, is logged, and
  does not start the 6 h wait.
- Show `curated: true|false` on each item of `/discovery/resources` and `/discovery/search`, and
  in the MCP server's list and search results; a listing without the proof stays listed.
- A curated listing's proof counts as 3 paying wallets in q (ADR 0014 "Curation"), once q
  from 0154 is on `develop`.
- Out of scope: a contract (`C…`) `payTo` has no `home_domain`, so it is never curated.

## Acceptance Criteria

- [ ] Given a seller whose `stellar.toml` lists its `payTo` and whose account's `home_domain` is
      the resource host, when its listing is checked, then the listing is curated
- [ ] Given a page that names another domain's `payTo`, when it is checked, then it is listed
      with `curated: false`
- [ ] Given a host checked less than 6 h ago, when another paid call comes, then it is not checked
      again
- [ ] Given a check that fails, when the listing is read, then it is not curated and the failure
      is logged
- [ ] `curated` is shown in `/discovery/resources`, `/discovery/search` and the MCP results
- [ ] A curated listing's proof counts as 3 paying wallets in q, which stays below 1.2
