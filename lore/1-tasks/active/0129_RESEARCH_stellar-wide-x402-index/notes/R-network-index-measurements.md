---
title: "What a Stellar-wide x402 index finds on pubnet and testnet"
type: research
status: developing
spawns: []
tags: [bazaar, discovery, measurement]
links: []
history:
  - date: "2026-11-10"
    status: developing
    who: karolkow
    note: "Measurements of 2026-11-09 and 2026-11-10, read-only public data"
---

# What a Stellar-wide x402 index finds on pubnet and testnet

All numbers come from public Horizon, Stellar RPC and the public ledger data lake, read only, on
2026-11-09 and 2026-11-10. Nothing was paid; seller checks were single unpaid requests.

## The pipeline

1. **Index.** An x402 `exact` settlement is one `invokeHostFunction` calling `transfer(from, to,
amount)`, one auth entry signed by `from`, no sub-invocations, a submitter other than `from`, no
   memo. A smart-wallet relayer sends the same shape (5,914 transactions in 30 days), so a second
   rule is needed: the transaction time limit (time bounds max minus ledger close time) is at least
   30 s for every x402 settlement seen and at most 19 s for the relayer. 0 errors on 1,734 x402 and
   1,000 relayer transactions. This is one relayer only; the limit is a facilitator setting, not a
   fixed trait. A larger check on 2026-11-12 (below) found 4 exceptions.
2. **Attribution.** 4 of the 5 accounts that submitted settlements in 30 days were named from public
   sources: facilitators' `/supported` signer lists, a public registry, addresses in public code,
   and the account that created them. A facilitator that publishes nothing stays unnamed.
3. **Seller resolution.** For a payee missing from catalogs, search its account id in public code,
   routers' published service lists and its `home_domain`; accept a URL only when its unpaid 402
   names the same `payTo`.
4. **Listing.** The listing comes from the seller's own 402, as the catalog already does (task 0063).

## Pubnet, whole history (2026-02-27 to 2026-11-09)

Real payments exclude self-payments, payers funded by the payee, bursts of one-time payers, and pairs
whose payer and payee share a funder.

| Month            | Real payments | Payers | Payees | USDC  |
| ---------------- | ------------- | ------ | ------ | ----- |
| 2026-03          | 51            | 8      | 6      | 17.93 |
| 2026-04          | 50            | 13     | 6      | 61.13 |
| 2026-05          | 1,061         | 6      | 4      | 40.27 |
| 2026-06          | 338           | 2      | 1      | 4.10  |
| 2026-07          | 36            | 4      | 3      | 0.68  |
| 2026-08          | 85            | 9      | 6      | 36.35 |
| 2026-09          | 297           | 9      | 7      | 2.00  |
| 2026-10          | 561           | 15     | 12     | 4.98  |
| 2026-11 (to 9th) | 440           | 11     | 12     | 17.26 |

- Total: about 2,900 real payments, 59 payers, 30 payees, about 185 USDC. Of the USDC, 160.35 is 9
  payments to one payee through one submitter that no public source names; without them, about
  24 USDC. Payers are G accounts only: contract (C) payers are not counted.
- Distinct payers per payee: 13, 8, 8, 7, 5, 3, then eight payees with 2 and sixteen with 1.
- Method: full Horizon history of 80 accounts (300k transactions) plus 140 windows of the data lake
  (5.76M transactions); the lake sample found no settlement Horizon had missed.

## Larger check of the time-limit rule (2026-11-12)

Envelopes of 5,896 shaped pubnet transactions from Horizon: 3,481 from two facilitators named in
public sources (2026-03 to 2026-11), 2,281 from 15 unnamed submitters that pass the rules, 1,084 from
the relayer (2026-10-27 to 2026-11-09), and 33 from two unnamed submitters whose payers are all
contract accounts.

- 4 of the 3,481 named-facilitator settlements have a time limit under 30 s (18, 23, 25, 27 s; April
  to June). A cut at 20 s gave 1 miss and 0 relayer matches; the relayer's longest limit is 19 s.
- The 33 contract-payer transactions pass every time-limit cut; whether they are x402 is unknown.
- USDC alone matched no relayer or unknown transaction but misses 3.5% of x402 (XLM, USDT0).
- Fee bump, memo, fee level and channel accounts follow a facilitator's setup, not x402.
- No single trait decides; a curated list of submitter accounts is the only trait that follows the
  facilitator.
- 0 of 360 sampled single-transfer USDC transactions on the whole network (block explorer database,
  six windows of 20,000 ledgers) were direct `transfer` calls, so the shape rule alone excludes DeFi
  traffic.

## Seller resolution results

- Last 30 days: 4 of 14 payees missing from the CDP catalog resolved; they received about 90% of
  the payments to payees outside it (about 60% without one demo service).
- Whole history: 6 of 30 payees resolved, carrying 53% of real payments and 36% of payers.
- Routes that worked: routers' published service lists and public code search. `home_domain` and
  the MCP registry found nothing usable.
- One router account receives payments for 441 services, so an account does not always map to one
  listing.

## Testnet, 7 days to 2026-11-10

- About 2,260 USDC settlements (95% interval 2,040–2,490), estimated from a stratified sample of
  3,300 transactions; at least 100 payers, 84 payees and 27 submitters.
- Public `/supported` lists name 32 submitter accounts; 2 were active and carried about 12.5% of
  sampled payments.
- Seller resolution found 1 of the top 30 payees; most look like throwaway test wallets.

## Ranking signal

- 6 of the 10 CDP `payTo` accounts on Stellar have at least one real payer; the top host has 8.
- Hosts that share one `payTo` cannot be told apart by chain data.
- 50 of 99 real payers were funded, within 2 hops, by the payee or the payee's funder. Some of these
  are facilitators that create accounts for users, so funding history cannot separate washing from
  normal onboarding.
- Faking payers costs little: a fresh account's reserve returns when the account is merged, and the
  facilitator pays the fee.

## Limits

- One relayer tested for the time-limit rule; other periods and relayers are not covered.
- Submitters below about 5 settlements a day can fall between lake windows.
- Seller resolution finds only sellers whose account id appears in public code or lists.
