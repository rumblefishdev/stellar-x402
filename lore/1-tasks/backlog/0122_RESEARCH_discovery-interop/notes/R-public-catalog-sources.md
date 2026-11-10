---
title: "Which public sources a Stellar Bazaar can read without anyone adapting"
type: research
status: developing
spawns: []
tags: [bazaar, discovery, interop, measurement]
links: []
history:
  - date: "2026-11-10"
    status: developing
    who: karolkow
    note: "Measurements of 2026-11-06 to 2026-11-09, read-only public data"
---

# Which public sources a Stellar Bazaar can read without anyone adapting

Since task 0063 our catalog writes a listing only from the seller's own unpaid 402. A foreign
catalog is therefore only a list of URLs to check; its content need not be trusted.

## Sources

| Source                                       | What it gives on Stellar                                                                   | Measured                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------- |
| Coinbase CDP discovery list (public, no key) | 1,513 offers with a Stellar `accepts`, 10 `payTo` accounts, 20 hosts; all also accept Base | full pull, 2026-11-06               |
| Sellers' own `/.well-known/x402` lists       | 19 of the 20 Stellar hosts serve one, each in a different shape                            | one request per host, 2026-11-06    |
| Other public catalogs                        | 38 further URLs and 10 sellers, of them 7 URLs and 2 sellers on pubnet                     | pull of each, 2026-11-09            |
| Liveness of the Stellar offers               | 1,503 of 1,513 answer with a valid 402 (99%)                                               | one unpaid request each, 2026-11-09 |
| Liveness of the whole CDP list               | about 40 of a random 200 do not work (gone, no answer, or now free)                        | sample, 2026-11-09                  |

## A small interop step

1. Pull the public lists above on a schedule.
2. Send every URL through the existing seller check, with the per-host budget.
3. Let the MCP server query several catalogs and merge the results; the upstream client queries one
   facilitator per call (`@x402/extensions` `bazaar/facilitatorClient.ts`).

Estimate: 3–4 days. Limits: only sellers on some list are found (5 of the 16 payees with real
payments in the last 30 days are in the CDP list); CDP may close keyless access; the sellers' list
format is not standard yet (upstream x402-foundation/x402#2582).

The network-wide alternative, with its measurements, is task 0129.
