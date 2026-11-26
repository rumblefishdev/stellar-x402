---
id: "0075"
title: "Seller guide to getting a service listed in the Bazaar"
type: FEATURE
status: backlog
milestone: 3
related_adr: ["0008"]
related_tasks: ["0063", "0085", "0102", "0163", "0094", "0164"]
tags: [docs, bazaar, dev-tools, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-27"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063: a listing enters only through a settled payment, so a new seller needs one
      paid call of its own to appear in the catalog.
  - date: "2026-10-28"
    status: backlog
    who: karolkow
    note: >
      Scope cut to a written guide, as the largest public catalog does; the helper command that
      pays for the seller is dropped. A no-payment check command stays a possible follow-up.
  - date: "2026-11-06"
    status: backlog
    who: karolkow
    note: >
      Takes in two RFP items no task held: the role-based developer guide and the "deploy in
      under an hour" goal, which the M1 plan leaves out of Tranche 1.
  - date: "2026-11-25"
    status: backlog
    who: akot
    note: >
      Noted under "Context" the two SDK helpers the guide can name: the catalog's answer (0102)
      and the no-payment check (0163).
  - date: "2026-11-26"
    status: backlog
    who: akot
    note: >
      Takes in 0094's recommendation: the guide's first step is checking that payTo can receive
      the asset, the only signal a seller can get before its first payment.
---

# Seller guide to getting a service listed in the Bazaar

## Summary

As a seller, I want a short guide that tells me how my service gets into the Bazaar and how to
check it did, so that a new service can be found without waiting for a buyer who already knows it.

## Context

- After 0063 a listing's content comes from the seller's own unpaid 402, and a settled payment only
  triggers that check (RFP 07 asks for cataloging on `PaymentPayload`; the architecture document
  rules out a separate registration process).
- The largest public x402 catalog documents the same path: the seller pays once for its own
  endpoint. The amount goes back to the seller's wallet; the facilitator pays the network fee.
- RFP 07's "seller-side helpers for discovery metadata" are covered by upstream's
  `declareDiscoveryExtension`, already used in `examples/http-api`.
- The TypeScript SDK adds two helpers a seller's guide can name. 0102 (M2): the catalog's answer
  after a settlement, listed or refused with the reason, which nothing in TypeScript reads today.
  0163 (M3): `validateListing`, the no-payment check this task left as a possible follow-up.
- The RFP also asks for a "Role-based developer guide for Stellar Developer Docs" and a "UX
  enabling developers to deploy discoverable endpoints in under an hour"
  (`docs/rfp/07-x402-facilitator-bazaar.md`). This guide is the seller's part of both;
  `docs/planning/m1-epics.md` puts both out of Tranche 1.
- A `payTo` that can't receive the asset (no account, no trustline, one not authorized) makes every
  buyer's client stop before signing, so the seller sees only unpaid requests and the catalog never
  gets a payment (0094, R-what-the-seller-sees). Nothing can tell the seller after the fact; a
  check before the first sale can. CDP's and Solana's seller docs open with the same step (0094,
  R-prior-art). A contract `payTo` needs a first balance of a SAC token instead (0107).
- Not measured yet: whether a settle whose payer is its own `payTo` passes on Stellar. If not, the
  guide says to pay from a second account.

## Open before starting (2026-11-18)

- **Where the guide lives.** `docs/README.md` says "The role-based developer guide is written as
  a PR to `stellar/stellar-docs`", while this task names `docs/` or the http-api example's README.
  Settle it with the owner and name the place here.
- **After 0085.** 0085 renames the seller-fetch codes (`unsafe_url` becomes `not_https`,
  `not_public`, `redirect`, …) that the guide explains: write the reasons after it, or update them
  when it lands.
- The agent part points at the MCP server in `apps/mcp-local` (its README's codes table).

## Implementation

- A seller guide (where: see "Open before starting"). First: make sure `payTo` exists and holds a
  trustline to each classic asset it is paid in, checked with `checkTrustline` from
  `@stellar-x402/sdk/seller`, or with the `stellar` CLI or Horizon for a seller outside TypeScript;
  for a contract `payTo`, send it a first amount (0107's `pay_to_balance_missing`). Name the
  refusal reader from 0164 for the seller's log. Then: declare the route with
  `declareDiscoveryExtension`; pay once for it with any x402 client; check
  `GET /discovery/resources?payTo=<account>`; what each listing refusal reason means and how to fix
  it (reasons from ADR 0008, and the codes in `apps/facilitator/src/catalog/seller-check.ts` and
  `cataloger.ts`: `not_402`, `unreadable_402`, `no_listing`, `other_pay_to`, `too_large` and the
  seller-fetch codes).
- Measure on testnet whether a self-payment settles and is cataloged; write the result into the
  guide.
- Then the other roles of the developer guide: a client paying from code and an agent through the
  MCP server, in the form Stellar's developer docs take.

## Out of scope

- A helper command that pays for the seller: dropped 2026-10-28.
- A `seller check <url>` command that tells, without paying, whether the 402 would be listed:
  possible follow-up if sellers ask.

## Acceptance Criteria

- [ ] Given the guide and a seller URL with a valid 402, when a seller follows it on testnet, then
      the listing appears
- [ ] The guide names every listing refusal reason a seller can fix, with the fix
- [ ] Whether a self-payment is cataloged is measured on testnet and stated in the guide
- [ ] Given a developer new to the project, when they follow the seller part on testnet, then
      their service is listed within an hour, timed and recorded
- [ ] The guide has a part for each role (seller, client, agent)
- [ ] The seller part starts with checking that `payTo` exists and can receive each asset it
      offers, for a G-account and a contract `payTo`, and a non-TypeScript way to check it
