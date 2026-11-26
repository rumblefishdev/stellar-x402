---
title: "Decision: check before the first payment, read refusals after it, nothing in the facilitator"
type: synthesis
status: mature
tags: [facilitator, sdk, payments, trustline, decision]
history:
  - date: "2026-11-26"
    status: mature
    who: akot
    note: "Recommendation from R-what-the-seller-sees and R-prior-art; for the owner to confirm."
    spawned_from: [notes/R-what-the-seller-sees.md, notes/R-prior-art.md]
    spawns:
      - ../../../active/0164_FEATURE_seller-verify-refusal-reader.md
  - date: "2026-11-26"
    status: mature
    who: akot
    note: >
      The seed check (conclusion 3) dropped by the owner: no catalog does it, and the case is rare.
---

# Decision: check before the first payment, read refusals after it, nothing in the facilitator

Built on [R-what-the-seller-sees](R-what-the-seller-sees.md) (**A**) and
[R-prior-art](R-prior-art.md) (**B**).

## Conclusion

1. **The signal has to come before the first payment, from the seller's own side.** With every
   client we know of, a missing `payTo` trustline stops the buyer before it signs: nothing reaches
   the seller or the facilitator (A). No later hook can fire. Sellers do the same on every other
   chain: Solana's docs, CDP and PayAI tell the seller to set the account up before advertising,
   and nobody checks for them (B). We already have the check (`checkTrustline`, 0102) and an
   example that runs it at start. What is missing is the guide that tells a seller to run it.
   **Do:** add the step to the seller guide (0075). No new task.
2. **A refusal that does reach `/verify` should reach the seller's log.** Today the seller's server
   answers the buyer with the bare reason and drops the message that tells the seller what to do
   (A). This is rare for a trustline. It is not rare for `pay_to_balance_missing` (0107): a
   contract `payTo` without a first balance, which upstream's client signs and our `/verify`
   refuses. **Do:** a reader for `onAfterVerify` in `/seller`, on the model of `readCatalogAnswer`,
   used by the example. **0164.**
3. **No `payTo` check at catalog seed.** The seed is the one path where we read a seller's 402
   without a payment first, so it could list an offer nobody can pay. A check there would protect
   buyers, not tell the seller. No catalog we found does it (B), and the case is rare. **Not now**
   (dropped by the owner, 2026-11-26).
4. **No facilitator route to check an offer, and no portal check, for now.** Both duplicate a check
   the seller runs locally against any public RPC, at the cost of a new public surface on our
   service.
5. **A `payTo` that doesn't exist needs nothing of its own.** `checkTrustline` says `missing`, "the
   account does not exist". `/verify` has one reason for both (0078 decision 4). The SDK and MCP
   have one code (0092). The guide's wording must say "the account must exist and hold the
   trustline".

## What `checkTrustline` and the example already do, and what they miss

What they do:

- Two ledger reads, no signing. They tell `ok`, `missing` (no trustline, not authorized, no
  account) and `unknown`.
- `examples/http-api` stops its start on `missing` and warns on `unknown`.

What they miss:

- **Nobody tells a seller to run it.** It appears in the SDK README and one example. 0075's guide
  is where sellers will look. → conclusion 1.
- **One check per `(payTo, asset, network)`, by hand.** A route's `payTo` can be a function,
  resolved per request (upstream `core:1180`), so no start check sees every `payTo`. Not worth a
  helper over the route config: it would only cover static routes.
- **Start-up only.** A trustline removed or deauthorized later shows up as buyers' failures only.
  This is rare. The reader (0164) covers the case where a payment reaches `/verify`.
- **A contract `payTo` is `unknown`.** Its problem is a missing balance (0107), which `/verify`
  catches. → 0164.
- **The example's comment and README say the wrong thing.** They say a missing trustline is
  refused "at settlement, after the buyer signed". It is refused before signing, or at `/verify`
  for a payment that gets there. → fixed in 0164.

## Options and their cost

| Option                                                                                    | Value                                                                                                           | Cost                                                                                                                                       | Verdict                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| What exists: `checkTrustline` + the example's start check                                 | the only check that works with every client                                                                     | done (0102)                                                                                                                                | keep                        |
| A step in the seller onboarding docs                                                      | what CDP, Solana and PayAI do; reaches sellers who never read the SDK                                           | a paragraph in 0075's guide: `checkTrustline`, or `stellar` CLI / Horizon for non-TypeScript sellers; the contract `payTo` note from 0107 | **do**, in 0075             |
| A refusal reader for `onAfterVerify` in `/seller`                                         | the seller's log names the account and what to do, for every refusal that reaches `/verify`                     | about a day: one function and its tests, the example logs it, README rows, the example's wrong sentence fixed                             | **do**, 0164                |
| A facilitator route that checks an offer                                                  | language-agnostic, one `curl`                                                                                   | a public route: rate limit, pubnet key policy (0105), docs, two ledger reads per call on our shared RPC, a free ledger-read proxy to guard | **no**: a local check does the same |
| Checking `payTo` from the 402 at seller check / cataloging                                | keeps unpayable Stellar offers out of the catalog                                                               | catalog after a payment: none needed, the payment proved `payTo` could receive. At seed: two reads per `payTo`, a refusal reason, tests, about a day | **not now**: rare, no one else does it |
| A portal page that checks the seller's `payTo` (PayAI-like)                               | onboarding help for pubnet sellers with a key                                                                   | the portal (0106) has no notion of `payTo` today: a form, the check, its copy                                                              | not now; revisit with a seller page in the portal |
| Logging refusals in upstream's resource server, or passing `invalidMessage` to the buyer | every seller would see it; the buyer could relay it                                                             | an upstream PR in `@x402/core` that we don't control                                                                                       | not now; the reader covers our sellers |

## Why not a facilitator route

- **Every check it could make, the seller can make without us:** two `getLedgerEntries` reads
  against a public RPC (`checkTrustline`), or `GET /accounts/{id}` on Horizon.
- **It adds a public surface:**
  - a route that reads the ledger for anyone is a free proxy to our RPC;
  - the public routes that take no key (`/supported`, `/discovery/*`) read only our own data;
  - it needs its own rate limit and docs.
- **The case for it:** a non-TypeScript seller with no Stellar library. The guide (0075) can give
  that seller a `stellar` CLI or Horizon one-liner instead.
- **The Rust seller crate (0136) has no `checkTrustline`.** It does hand the seller `/verify`'s
  `invalid_message` directly, so it doesn't need 0164's reader. A Rust trustline check, if anyone
  asks, belongs in 0140, the crate's part 2.

## Risks and limits

- **The reader logs facilitator text.** `invalidMessage` comes from whatever facilitator the seller
  configured. 0164 has to bound its length and keep it printable, as `readCatalogAnswer` does with
  its reason.
- **A seller who ignores the start check stays silent until buyers complain.** This is the same on
  every chain (B). No facilitator can contact a seller it never hears from.
- **Upstream may change.** If `@x402/stellar` gains sponsored trustline handling or a `/verify`
  diagnosis of its own, revisit this. Stellar has nothing like Solana's `ataCreationRequired`
  today, and a trustline can only be added by the account's own signature, so the facilitator
  can't do it.
