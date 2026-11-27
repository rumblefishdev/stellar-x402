---
id: "0070"
title: "Mark catalog listings whose seller proves its payTo with stellar.toml"
type: FEATURE
status: completed
owner: karolkow
milestone: 2
related_adr: ["0008", "0014"]
related_tasks: ["0063", "0154", "0135"]
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
  - date: "2026-11-27"
    status: completed
    who: karolkow
    note: >
      PR #279 merged. The two-way stellar.toml proof is checked on paid calls at most every 6 h,
      kept in catalog_curation (migration 0022), counted as 3 paying wallets in q, valid 30 days,
      and shown as `curated` in /discovery/resources, /discovery/search, the SDK and the MCP
      server. 5 new test files; facilitator suite 1,542 passed under load (1 migration test
      passes alone).
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

- [x] Given a seller whose `stellar.toml` lists its `payTo` and whose account's `home_domain` is
      the resource host, when its listing is checked, then the listing is curated
- [x] Given a page that names another domain's `payTo`, when it is checked, then it is listed
      with `curated: false`
- [x] Given a host checked less than 6 h ago, when another paid call comes, then it is not checked
      again
- [x] Given a check that fails, when the listing is read, then it is not curated and the failure
      is logged
- [x] `curated` is shown in `/discovery/resources`, `/discovery/search` and the MCP results
- [x] A curated listing's proof counts as 3 paying wallets in q, which stays below 1.2

## Implementation Notes

- `apps/facilitator/src/catalog/curation.ts`: `provesPayTo` (pure), `stellarTomlUrl`, and
  `createCuration().refresh`, which reads the file through the seller-fetch guard and the
  account's `home_domain` through the facilitator's RPC.
- `ports/curation-store.ts`, `adapters/postgres-curation.ts`, migration `0022_catalog_curation`:
  one row per network, host and `payTo`.
- `catalog/cataloger.ts`: after every paid call whose listing is in the catalog, apart from the
  seller check.
- `adapters/postgres-catalog.ts`: `curated` on list and search items; in both rankings the proof
  adds 3 to the payer count when it was checked in the last 30 days.
- `packages/sdk` (`CatalogEntry.curated`) and `apps/mcp-local` pass the field to agents.

## Issues Encountered

- **Curation read from the first offer**: after merging develop, a listing with no offer threw
  in list and search. Fixed by reading the listing's key columns.
- **A missing file was retried on every payment**: a 404 first counted as a failed check, so the
  6 h wait never started. Any answer from the host now finishes the check, an HTML page too.
- **Tests on a loaded machine**: each test file migrates a fresh schema within 1.5 s; with the
  default worker count, whole files failed at setup. Runs used 3 workers (see 0074).
- **Modified tests**: the migration lists in `postgres.test.ts`, the `get`/`list` comparison in
  `port-contracts.ts` (`list` adds `curated`) and the seller requests in `settle-pool.test.ts`
  (a listed resource also fetches its stellar.toml).

## Design Decisions

### From Plan

1. **Curated means the two-way SEP-1 proof, checked by the facilitator**: the host's file lists
   the `payTo` in `ACCOUNTS` and the account's `home_domain` is the host. A hand-kept list was
   rejected: it would have the operator vouch for sellers, like paid placement.
2. **The proof counts as 3 paying wallets in q**: about the x1.1 measured on CDP's catalog
   (median +3 places, 3,000 listings, 40 queries). A factor under the 1.2 cap was rejected: every
   curated listing with 2 wallets reached 1.2.
3. **Checked on paid calls, at most every 6 h per host and `payTo`**, apart from the seller check;
   a proof not checked for 30 days no longer counts.
4. **Its own table**: the proof is about a host and an account, which many listings share.
5. **`curated` is a top-level field** on each item, beside `lastUpdated`, in both endpoints, the
   SDK and the MCP server; upstream defines no such field.
6. **Only the exact host passes**, read at `https://<hostname>/.well-known/stellar.toml` as SEP-1
   places it; a free shared host (`*.vercel.app`) is treated like any other.
7. **Any answer from the host finishes the check**; only a host that cannot be reached, or the
   RPC, is retried on the next paid call, logged.

### Emerged

8. **A 200 whose body is not TOML is an answer**: many hosts answer every path with their own
   page, which would otherwise be fetched on every payment.
9. **A contract (`C…`) `payTo` is skipped** without a check or a log: it has no `home_domain`.
10. **Not the SDK's `StellarToml.Resolver`**: it has no deadline and no public-address guard; the
    seller-fetch guard is used, with SEP-1's 100 KiB cap and the seller check's 10 s deadline.

## Future Work

- Quality harm of the bonus is measured on 0135's set before mainnet (added to 0135).
