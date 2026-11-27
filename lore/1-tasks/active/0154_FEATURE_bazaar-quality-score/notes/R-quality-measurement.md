# R: The measurements behind the search's quality score

The numbers ADR 0014's quality score rests on (task 0154), with how each was taken. Scripts ran
from a scratch folder and are not kept; each section says enough to run it again.

## A payer count added to the fused ranking (2026-11-19)

0134's set: 3,000 listings and 40 queries graded 0–3
([R-search-measurement](../../../archive/0134_RESEARCH_search-in-postgres/notes/R-search-measurement.md)),
ranked by granite fusion at k = 20, meaning 4 : words 1. To each listing's fused score we added
`weight × log(1 + payers) / max log(1 + payers)`, where `payers` is the listing's
`quality.l30DaysUniquePayers` in CDP's public catalog. The top fused score is 4/21 + 1/21 = 0.238,
so each weight is also a share of it.

| Weight | Share of the top fused score | nDCG@10 | Recall@20 |
| --- | --- | --- | --- |
| 0 | 0% | 0.726 | 0.721 |
| 0.05 | ~21% | 0.733 | 0.719 |
| 0.1 | ~42% | 0.731 | |
| 0.2 | ~84% | 0.719 | |
| 0.5 | ~210% | 0.632 | |

The grades judge relevance only, so the run shows how much a payer term can harm the order, not
what it gains. The term here was added; ADR 0014's q multiplies and is at most +20%.

## Payments on chain, 30 days to 2026-11-23

The whole population from 2026-10-24 00:00 UTC (pubnet ledger 65,102,844; testnet 5,355,283) to
2026-11-23 11:40 UTC, read from a Stellar block explorer's ClickHouse in one-day chunks. A payment
"shaped like an x402 settlement" is a successful transaction with one `invokeHostFunction`
operation and exactly one `transfer` of Circle USDC to a `G…` account, from a `G…` payer other than
the transaction's source, with no memo. This is a superset of x402 settlements: other single-transfer
contract calls pass too.

| Network | Payments | Payers | `payTo` | Paid by the `payTo` itself |
| --- | --- | --- | --- | --- |
| pubnet | 2,539 | 64 | 37 | 1,127 (44%), 1,121 of them one account |
| pubnet, without those | 1,412 | 61 | 34 | — |
| testnet | 12,136 | 1,644 | 916 | 1,137 |

- Pubnet `payTo` accounts by their distinct payers other than themselves: 1 payer 19, 2–9 payers 13,
  10 or more 2 (12 and 11).
- This facilitator on testnet (its fee-bump signer, as found through the transaction's
  participants): 155 payments from 2 payers to 2 `payTo` accounts.
- Who funded each payer was not measured here; task 0129 found 50 of 99 real pubnet payers funded
  within two hops by the payee or the payee's funder (`0129/notes/R-network-index-measurements.md`).

## CDP's public catalog (2026-11-23)

All of `GET /discovery/resources`, paged by 1,000: 39,579 items, 3,288 hosts.

- Tunnel hosts: `ts.net` 60 listings on 9 hosts, `serveousercontent.com` 21 on 1, `ngrok-free.dev` 2
  on 2, `trycloudflare.com` 1 on 1; 84 in all. None among the Stellar listings.
- Descriptions: 53 empty (after removing spaces), 100 shorter than 20 characters, mostly real short
  names such as "Search Reddit posts". None of either among the Stellar listings.
- Stellar pubnet: 1,292 distinct resource URLs on 20 hosts; 580 (44.9%) on `workers.dev`.
- Repeated words: 17 descriptions of 39,577 hold one word, stop words left out, 10 times or more,
  all real services ("depth" in a marine-depth API); 0 of the Stellar listings do, 41 hold one 5
  to 9 times.
- This facilitator's testnet catalog: 1 listing, on `trycloudflare.com`, with a 30-character
  description.

## The payer count at search time, or from a table (2026-11-23)

Local PostgreSQL in Docker (default settings), synthetic settlements of about 4.3 KB with a real
`bazaar` block: 65% plain GET, 15% POST, 20% route templates; 3 times as many older rows outside
the window. Median of 20 warm runs, in ms. The Mac was busy, so read every figure as within 2×.

| Payments in 30 days | From `settlements`, keys derived in TypeScript | From a table |
| --- | --- | --- |
| 155 | 36 | 0.9 |
| 2,539 | 219 | 6.5 |
| 25,000 | 2,197 | 7.8 |
| 250,000 | tens of seconds, 1.6 GB | 79 |

- The table ran with an index on all its columns, counting first and joining the catalog after.
  Without that index, one run at 25,000 chose a sequential scan with a sort, 46–68 ms. The table
  ships with its key only; an index comes when a measurement of the shipped search query needs it.
- Both ways gave the same count for every listing at every size.
- Writing one row took 0.3–0.4 ms.

## The payer count from listing columns on `settlements` (2026-11-25)

The table above was not built: the listing's method and URL went onto the settlement's row instead.
Same setup on PostgreSQL 18.6, a page of 20 listings, median in ms. Counted from `settlements` by the
two listing columns, with network, `payTo` and asset from the row's `payment_requirements` (about
260 bytes, stored inline).

| Payments in 30 days | No index | Index on the listing columns |
| --- | --- | --- |
| 155 | 0.46 | 0.57 |
| 2,539 | 1.39 | 0.70 |
| 25,000 | 15.1 | 1.55 |
| 250,000 | 226 | 27.7 |

- The count matched the derived one for every listing at every size.
- Writing the two columns took 0.3–0.4 ms; adding them took 0.4–16.5 ms under the table's lock up
  to 600,000 rows, a change to the table's metadata only.

## The search query with q in it (2026-11-26)

The whole search query by words, with a payment counted only on one of the listing's offers
(scheme, network, `payTo`, asset and amount). Local PostgreSQL 18.6, 39,578 synthetic listings, a
machine at load 7–13, median in ms. Differences under about 30% are within the noise of that load.

| Query | Today, no q | q counted in the query | q from a table of payers per listing |
| --- | --- | --- | --- |
| 4 words, 2,539 payments in 30 days | 143–170 | 324 | 294 |
| 4 words, 25,000 payments in 30 days | 143–170 | 392 | 263 |

- Counted in the query: the matches are found first, then joined to the settlements and grouped
  per listing. Other shapes (payers counted first, then joined) took 1.2–2.4 s, because the
  planner guessed too few matches and chose a nested loop.
- The table needs a second write at each payment (about 1 ms) and a job that drops pairs older
  than 30 days; 11 MB at 25,000 payments.
- A 32-word query took 2,400–4,800 ms in every variant: over the discovery pool's 2 s timeout
  even today.

## The fused search query with q in it (2026-11-27)

The fused query of develop and the one with q, 39,578 synthetic listings, 25,000 successful payments
in 30 days, local PostgreSQL in Docker with default memory, a machine at load 6–13. Median of 20
runs after 2 discarded, the two queries interleaved, in ms. `resource` was padded so it is stored
out of line: 5.9 KB is the 95th percentile of CDP's catalog on 2026-11-27 (88,935 items), 36 KiB
the cap of ADR 0008.

| Listings with cosine ≥ 0.60 | `resource` | develop | with q |
| --- | --- | --- | --- |
| 329 (0.8%) | 5.9 KB | 106 | 137 |
| 329 (0.8%) | 36 KiB | 101 | 127 |
| 3,957 (10%) | 5.9 KB | 121 | 198 |
| 3,957 (10%) | 36 KiB | 180 | 420 |
| 39,578 (100%) | 5.9 KB | 1,090 | 2,071 |
| 39,578 (100%) | 36 KiB | 1,318 | 4,303 |

- Most of the added time is reading each match's `resource->'accepts'` out of line; the join to
  the settlements took 170–230 ms at 100%.
- With granite, a query matched a median of 5.3% of the 3,000 listings of task 0134, at most 25%
  (0134, "Matches and the cut"). Past the 2 s timeout means nearly every listing matching one query.
- Not shown: real vectors at this catalog size; a database with production memory settings.
