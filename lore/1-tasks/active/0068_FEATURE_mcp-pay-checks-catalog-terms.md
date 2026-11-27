---
id: "0068"
title: "Refuse a paid call when the seller asks more than its catalog listing or names another payTo"
type: FEATURE
status: active
owner: bstruzyk
milestone: 2
related_adr: ["0008"]
related_tasks: ["0063", "0037", "0137", "0044", "0162"]
tags: [mcp, bazaar, security, before-pubnet, priority-medium, effort-small, dev-tools]
links:
  - ../../../docs/adr/0008-bazaar-catalog-integrity.md
history:
  - date: "2026-10-26"
    status: backlog
    who: karolkow
    note: >
      Spawned from 0063: the catalog will match the seller's 402 when an entry is written, but a
      seller can change its 402 afterwards.
  - date: "2026-11-04"
    status: backlog
    who: karolkow
    note: >
      Required before pubnet: the 0063 check doesn't prove who owns a listing's payTo, so a URL can
      name another seller's account and change its 402 later (ADR 0008).
  - date: "2026-11-27"
    status: active
    who: bstruzyk
    note: >
      Started: call_paid_http compares the live 402 with the chosen Bazaar listing before signing.
---

# Refuse a paid call when the seller asks more than its catalog listing or names another payTo

## Summary

As a buyer's agent, I want `call_paid_http` to refuse a payment when the seller's live 402 asks
more than the Bazaar listing the agent chose, or names a different `payTo`, so that a listing
can't lure an agent into paying a price it never saw.

## Context

- `call_paid_http` pays the live 402, never the catalog (`apps/mcp-local/src/server.ts`), within
  the per-call limit and the daily budget per asset (`apps/mcp-local/src/pay.ts:127-129`,
  `:147-160`). Nothing compares the live terms with the listing.
- 0063 makes the facilitator write a listing only when the payment's echo equals the seller's own
  402. The seller can still change its 402 after the listing is written.
- Upstream's `x402Client` caps the amount (spend controls, "$1" by default) and offers
  `onBeforePaymentCreation` hooks; it doesn't compare against a catalog
  (`typescript/packages/core/src/client/x402Client.ts:155-185` at `af6665b`).

## Implementation

- Find the listing for the called URL and method. 0037 learned that a lookup by URL must not scan
  the whole catalog: decide how the listing reaches the call (the agent passes it, or a keyed
  lookup). Facts for the choice (2026-11-18): `/discovery/resources` has no resource-URL filter
  (its params are `type`, `payTo`, `scheme`, `network`, `extensions`, `limit`, `offset`,
  `apps/facilitator/src/http/discovery.ts`), so a keyed lookup needs a route change; and ADR 0008
  keys a listing by network + payTo + method + URL, so one URL can have several listings, which a
  passed listing avoids. 0137's search results are meant to be passed to the paid-call tool.
- Before signing: refuse when the live `payTo` differs from the listing's, or when the live amount
  for the same scheme, network and asset is above the listed one. A lower price passes.
- A call with no listing keeps today's behaviour, or is refused: decide with the owner.

## Acceptance Criteria

- [x] Given a listing at price P, when the live 402 asks more than P in the same asset, then
      nothing is signed and the tool returns an error code naming the change (`price_raised`)
- [x] Given a listing with payTo S, when the live 402 names another payTo, then nothing is signed
      (`payto_changed`)
- [x] Given a live price at or below the listing's, when the agent calls, then it pays as today

## Design Decisions

### From Plan

1. **The agent passes the listing.** `call_paid_http` takes an optional `listing`, the
   `list_resources` / `search_resources` item as it came. No route change, and no doubt about which
   of a URL's listings (one per network + payTo, ADR 0008) the agent saw.
2. **No listing pays as today** (decided with the owner, 2026-11-27). Without a listing the agent
   saw no catalog price, so nothing lured it; the limits still hold, and refusing would make the tool
   useless for sellers that aren't in the Bazaar. The result's `listingCheck` says `passed` or
   `none`, so skipping the check is never silent.

### Emerged

3. **A listing for another call is refused** (`invalid_input`, the seller never called): another
   URL, another HTTP method, another network than the one this server pays on, or not `http`.
   Otherwise any cheap listing could stand in for the seller's. A listing for another network is
   `invalid_input`, not `terms_changed`: `search_resources` gives both networks' listings of a
   URL, and the choice is the agent's, not a change by the seller. A listing without its `type` or
   `input.method` is refused too (the catalog's items always carry both): without the method, a
   listing for one method could vouch for another's price, as ADR 0008 keys a listing by method.
   The URL is compared canonically, its query and fragment dropped before it is canonicalized, so
   a long query is not taken for another URL; a called URL the catalog could not list is refused
   with its own message. Only a segment that is exactly `:` (what `eraseParamNames` leaves) is a
   wildcard; `:x` in a concrete path matches itself.
4. **The check is in the SDK** (`BuyerConfig.quoted`), first in the offer policy, so it runs before
   the budget is counted and before signing. A seller offer is kept only with a quoted payTo for its
   network and the same scheme, network, asset at most at the quoted amount. Only the scheme,
   network, asset, `payTo` and amount are compared: the SDK caps `maxTimeoutSeconds` at 300 s, and
   the exact Stellar client refuses `extra.areFeesSponsored: false` on its own. An empty `quoted`
   refuses every offer: documented rather than thrown, since refusing all is the safe reading and
   MCP can't reach it (a listing has at least one offer).
5. **A third code, `terms_changed`**, for an offer whose scheme, network or asset the listing
   doesn't have. When offers fail for different reasons the code is the first of `payto_changed`,
   `price_raised`, `terms_changed`. It is only seen for offers the buyer's schemes can pay: upstream's
   `x402Client` drops the others before any policy runs, so a seller that now offers only another
   network or scheme gets `unsupported_payment`. Mapping that failure to `terms_changed` would
   mean telling it from other upstream failures by its message; nothing is paid either way, so the
   docs say it instead.
6. **The catalog tools tell the agent to pass the item.** `list_resources` and `search_resources`
   say "pass its item to call_paid_http as listing": without that an agent wouldn't know, and the
   check would rarely run. ADR 0008's note on the `payTo` attack now says how 0068 closes it.
7. **A refused agent is told not to call again without the listing.** An agent refused with
   `payto_changed`, `price_raised` or `terms_changed` would most often drop the parameter that
   failed and pay the very terms it was refused. The MCP message (not the SDK's, which has no agent)
   and the tool description say to choose another listing instead.

