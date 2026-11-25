---
title: "Prior art: per-key free quotas and fee budgets"
type: research
status: mature
tags: [facilitator, fees, budgets, prior-art]
history:
  - date: "2026-11-23"
    status: mature
    who: akot
    note: "Web research (agent report), every source read 2026-11-23."
---

# Prior art: per-key free quotas and fee budgets

Research for 0107. Every source was read on **2026-11-23** (the list is at the end). **[unverified]** means
no first-party source confirmed it; **[3rd party]** means a blog or news site, not the service itself;
**[inferred]** means it is my reading, not the source's words.

## 1. Coinbase CDP x402 facilitator

- **Free tier: 1,000 a month, then $0.001 each. Verified.** "The first 1,000 onchain Facilitator
  transactions each month are free, then each additional onchain transaction costs $0.001." Billing has
  been on since 2026-01-01 (changelog, 2026-01-15). A $0.001 minimum per x402 payment has applied since
  2025-12-03.
- **What counts: successful on-chain transactions only.** FAQ: "A settle call that returns a 2xx status
  counts as one transaction"; "verification is free, and so is a settle call that fails with a 4xx or
  5xx". `/supported` and discovery are free. A batch claim, deposit, refund or withdrawal counts as one each.
- **Who pays gas: the facilitator.** "The facilitator submits the settlement transaction and pays the
  gas, which is what the per-transaction price covers."
- **Period: "each month", not defined further.** No page says whether it is a calendar month or which
  time zone resets it **[unverified]**. Billing started on Jan 1 and the first bill was due Feb 1
  [3rd party, KuCoin], which suggests calendar months **[inferred]**. CDP's sibling product, CDP Node,
  says its free tier "resets on the first day of each calendar month".
- **Past the free tier: billing, with no documented cap.** A seller quoted this CDP email: "Your
  organization has reached the monthly free tier limit for settled x402 payments… Additional settled
  payments will require a payment method on file". Adding a payment method required KYC, and the post
  calls CDP "Free tier, then unbounded" [3rd party, dev.to]. What `/settle` answers for an organization
  with no payment method is **[unverified]**: no CDP error code covers it.
- **Scope: the organization, not the key** **[inferred]** from the email. Authentication is "your CDP
  API key ID and secret". **Usage shown:** the email above; no x402 page documents a dashboard or usage
  headers **[unverified]**.
- **Rate limits:** "standard CDP API rate limiting… rejected with `429`". The v2 API allows 500 writes and
  600 reads per rolling 10 s, with `{"errorType":"rate_limit_exceeded",…}`. The scope is not stated.

## 2. Other x402 facilitators, and the spec

- **PayAI.** "Start with 1,000 free credits"; a credit is $0.001, and a settled payment costs "gas cost
  plus 30%" (testnets free). No key to start; a key to buy credits. "Free credits are tracked per receiving
  wallet, and per account when you use an API key"; "Very high-volume shared hosts may be asked to use an
  API key sooner." Out of credits, it "stops settling new payments for that wallet", with a top-up link in
  the message (no code documented). `GET /free-credits?payTo=…&network=…` says only `available`, `low`
  (≤20% left) or `exhausted`; exact numbers are in the merchant portal. A guide [3rd party, Stablecoin
  Insider, 2026-10-01] says the credits are "lifetime… not a monthly reset", cost-plus since 2026-09-21,
  and exhaustion is 403 with `errorReason` `free_tier_exhausted…`: not on PayAI's page **[unverified]**.
  An older snippet's "10,000 settlements/month" is not on today's page.
- **OpenZeppelin "Built on Stellar" (Relayer + x402 plugin, usually through Channels).** A "Free, public
  x402 facilitator for Stellar… sponsored fees". Keys: testnet "no authentication required"; mainnet
  "requires GitHub OAuth"; a key "cannot be retrieved after creation". Hosted Channels: "Each API key has a
  fee consumption limit (measured in stroops)"; "The limit resets automatically 24 hours after your first
  transaction"; past it, "requests return `FEE_LIMIT_EXCEEDED` until the reset" ("Wait for 24-hour reset or
  contact support"). The value is not published **[unverified]**. The x402 plugin's README tells operators
  to "use the Channels per-API-key fee limit to bound total spend".
- **How Channels enforces it** (`relayer-plugin-channels`, `src/plugin/fee-tracking.ts`, `submit.ts`, last
  changed 2025-12-04). Before submitting it checks `consumed + maxFee > limit`; if over, **HTTP 429**
  `FEE_LIMIT_EXCEEDED`, "Transaction fee (X stroops) exceeds remaining budget (Y stroops). Consumed: C/L
  stroops.", `details: {consumed, fee, remaining, limit}`. After submitting it records `maxFee` (not the fee
  charged), on success and on an on-chain failure ("transaction was still submitted and consumed fees").
  The window is fixed from the key's first recorded fee. Check and record are separate steps, so concurrent
  calls can overshoot **[inferred]**. No key: 400 `API_KEY_REQUIRED`. An admin API sets, reads and deletes
  a per-key limit; `Get Fee Usage` returns `consumed`, `limit`, `remaining`, `periodStartAt`, `periodEndsAt`.
- **Launchtube (SDF, archived; "superseded by" OZ Relayer + Channels).** Each JWT token carried an XLM
  budget and a TTL; mainnet tokens were requested in `#launchtube` on the Stellar Discord. Credits were
  charged in steps (100,000 held at submission, swapped for the bid fee after simulation, then for the
  final fee): "This ensures a fair and predictable system without restrictive rate limits." Responses
  carried `X-Credits-Remaining`; `GET /info` returned the remaining credits.
- **The rest.** thirdweb settles through "your own server wallet" (EIP-7702), so the seller pays gas; fees
  and limits undocumented **[unverified]**. Heurist: "no API key needed", it handles "gas fees and
  confirmation", no limits documented. x402.org: testnet only, free, no keys. x402-rs: self-hosted, no keys
  or limits. Corbits/Faremeter, Daydreams, Mogami, OpenFacilitator: no first-party pages found **[unverified]**.
- **x402 spec** (now `github.com/x402-foundation/x402`; `coinbase/x402` resolves there). v2 §9 has no code
  for a quota, rate limit, key or account (only `insufficient_funds`, `invalid_*`, `unsupported_scheme`,
  `invalid_transaction_state`, `unexpected_{verify,settle}_error`, `settlement_pending`). §7 puts no auth
  or throttling on `/verify`, `/settle`, `/supported`; `auth-hints` is server↔client only ("The Facilitator
  is not involved in authentication"). A quota refusal is therefore facilitator-specific, not a spec code.
- **x402 Stellar `exact`:** `areFeesSponsored` is "Currently always true". `maxTransactionFeeStroops`
  (default 50,000) is a per-transaction ceiling, error `invalid_exact_stellar_payload_fee_exceeds_maximum`.
  "This is not a per-transaction budget knob."
- **Solana `exact` ATA fields** (`scheme_exact_svm.md` §5.4–5.5, added with multi-payee splits, 2026-10-26).
  `extra.ataCreationRequired` (and `splits[].ataCreationRequired`, default `false`) marks a recipient whose
  token account "may not exist yet"; setting it "authorizes the `feePayer` to fund that creation", so **the
  facilitator pays the rent** (≈0.002 SOL). `ataCreationSponsored` in `/supported` (`kinds[].extra`, absent
  = `false`) is the facilitator's promise to fund it; without it, such a transaction is rejected
  (`split_ata_creation_not_authorized`). Rent is bounded per transaction but "**not** bounded over time": an
  owner can close its account and be paid again, or rotate `payTo`. A sponsor "SHOULD bound this, for
  example by tracking sponsored creations per owner and mint and refusing or pricing repeats, by
  rate-limiting sponsored creations per Resource Server… or by recovering the cost through a split to
  itself". MPP's `draft-solana-charge-00` splits use the same name.

## 3. Gas sponsorship and paymasters

- **Alchemy Gas Manager.** `maxSpendPerUoUsd`, `maxSpendPerSender` (USD), a per-policy max spend, max
  operation counts per sender and per policy, start/end dates, sender allow/blocklists. "All of these spend
  limits are lifetime, cumulative totals"; no built-in daily limit (track spend yourself and refuse by
  webhook). One error per limit: "Policy's max spend per spender exceeded.", "Policy's max count per spender
  exceeded.", "Policy max count exceeded.", "Policy max spend global exceeded.", "policy has ended".
- **Pimlico.** A policy has `global`, `user` and `user_operation` limits. Each has
  `user_operation_spending` (USD), and global and user have `maximum_user_operation_count`.
  `reset_interval` is `never` (default), `daily`, `weekly` or `monthly`, alignment not stated
  **[unverified]**. A policy also has `start_time`/`end_time`.
- **Coinbase CDP Paymaster.** Per user: "Dollar amount limit" and "number of UserOperations", in cycles
  that "reset daily, weekly, or monthly" (alignment not stated), plus a global USD cap. Account default
  "Sponsor up to $15k monthly on mainnet"; more is asked for on Discord. Errors (`-32001`): "request denied -
  rejected due to maximum per address transaction count reached", "…max global usd spend limit reached".
- **Circle Gas Station.** Max spend per transaction, max spend per day, max operations per day. "Daily
  limits reset once every 24 hours at 0:00 UTC." Past a limit, "the transaction fails unless the sender
  provides their own gas". Whether limits are per wallet or per policy is not stated.
- **ZeroDev.** Policies per project, contract or wallet, or by webhook. Limits by gas amount, request
  count, gas price or amount per transaction (examples per minute or hour). The error is not documented.
- **Privy recipe.** Daily caps "$2 per wallet, $5 per user, and $100 per app", reset "every day, e.g. at
  midnight UTC". All three are checked before sponsoring and recorded after a successful submit; at a cap
  it falls back to unsponsored.
- **Biconomy.** Global and per-user limits, by gas spend or operation count. A snippet says editing a
  limit restarts its cycle; the pages return 404 today **[unverified]**.

## 4. Ordinary APIs with a free tier

- **Infura.** "Credit quota limits are reset every day at 00:00 UTC for all customers." Past the daily
  limit it is a **hard stop**, **HTTP 402**: "You have reached your daily credit limit. To continue making
  requests, upgrade your plan or purchase additional credits." WebSockets are severed. Emails go out at
  75%, 85% and 100%; the per-second limit answers 429.
- **Helius.** 1M credits a month and 10 RPC req/s on the free plan; the reset day is not stated. When the
  credits are gone, "you won't be able to make new API requests" ("429 max usage reached"). Usage is on
  the dashboard; autoscaling (paid plans) and USDC-prepaid credits extend it.
- **Alchemy.** "Each free tier account is allocated up to 30 million Compute Units (CUs) every month",
  with 300 CUPS per app. The reset day and the behaviour at exhaustion are not stated **[unverified]**;
  webhooks report "Monthly capacity limit exceeded".
- **QuickNode.** On paid plans "your endpoints remain functional" past the plan (auto-scaling overage);
  free and trial plans don't auto-scale. New on 2026-06-09: "x402 requests on Quicknode are now free up
  to 1 million per month, per agent… The allowance refreshes every month… We reserve the right to revoke
  the free tier for wallets that abuse the system."
- **GitHub REST.** 60 requests an hour unauthenticated (per IP), 5,000 authenticated. The budget is per
  user, not per token: a user's tokens share it. Headers `x-ratelimit-limit`, `-remaining`, `-used`,
  `-reset` (UTC epoch s), `-resource`; over the limit, 403 or 429.
- **Anthropic.** Monthly spend caps per tier, "each calendar month"; at the cap, usage "pauses until 00:00
  UTC on the first day of the next month". The answer is 429 `rate_limit_error`, `error_code:
  enforced_spend_limit_reached`, the message names the date ("You will regain access on 2026-09-01 at 00:00
  UTC"), and there is **no `retry-after`**. A lower, self-set limit answers 400. Tiers rise with usage
  history or on request. Rate limits are a token bucket with `anthropic-ratelimit-*` headers.
- **OpenAI.** Free tier $100/month (allowed geographies); paid tiers rise automatically as "total credit
  purchases reach each threshold" ($5/$100/$500). Headers `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`.
  A hard spend limit also answers 429, so "check `error.code`"; `insufficient_quota` is not retryable.
- **Mapbox.** The free tier "resets on the first day of the account's monthly billing period"; periods
  run from the 1st to the last day of the month. Past it, usage is billed, not blocked. It emails "the
  first time a free tier is exceeded" each period, and you can set your own per-service thresholds.
- **Google Maps (since 2025-03-01).** 10,000/5,000/1,000 free calls a month per SKU. "This free usage
  resets on the first day of each month, at midnight Pacific US time." Usage is pooled across a billing
  account's projects; above the free calls it is billed.
- **IETF RateLimit headers** (`draft-ietf-httpapi-ratelimit-headers-12`, 2026-11-20; a draft, not an RFC).
  `RateLimit-Policy: "monthly";q=1000;w=2592000` declares a quota (units `qu`: `requests`, `content-bytes`,
  `concurrent-requests`, others by registration); `RateLimit: "monthly";a=17;w=…` gives what is left. `w` is
  an "effective window" that "does not necessarily end at a fixed point in time"; there is no reset
  timestamp. Its problem-type registry recommends 429 for `quota-exceeded`.

## 5. Sybil resistance of free tiers

- **Douceur, "The Sybil Attack" (IPTPS 2002):** without a logically central identity authority, Sybil
  attacks are always possible "except under extreme and unrealistic assumptions". A per-identity quota
  only moves the cost to getting identities.
- **Geocodio (2025-02):** "$1.50 of free usage per day per account" "can easily be abused by creating
  multiple accounts". One-signup-per-IP blocked universities and workshops and was dropped. A risk score
  (CAPTCHA or email check at medium risk, a block at high) worked. "We have to accept a certain amount of
  abuse."
- **Optimism Superchain faucet (2023-08-01):** traditional faucets "rely on social authentication and cap
  daily amounts". This one scales the drip with identity strength: onchain-attested builders get "up to
  1 testnet ETH per day", "20 times more".
- **Castle:** phone verification can itself be exploited (SMS pumping).
- **Sybil controls in the sources above.** PayAI counts per receiving wallet and asks shared hosts for a
  key sooner; QuickNode may revoke "for wallets that abuse"; OZ gates mainnet keys behind GitHub OAuth, and
  Launchtube gated them behind a Discord request; the Solana spec bounds repeats per owner or per resource
  server. Every paymaster pairs a **per-user cap with a global cap**, so many Sybil users still cannot pass
  the global budget.

## Comparison

| Service | Counts what | Period & reset | Past the limit | How usage is shown | Source |
|---|---|---|---|---|---|
| CDP x402 facilitator | 2xx on-chain settlements; verify and failed settles free | "each month"; calendar month and zone [unverified] | $0.001 each; payment method + KYC [3rd party]; no cap documented | Email at the limit [3rd party]; dashboard [unverified] | docs.cdp.coinbase.com/x402/support/faq |
| PayAI | Settled payments, gas × 1.3 in $0.001 credits | 1,000 free credits; lifetime per wallet [3rd party] | Stops settling for that wallet; 403 `free_tier_exhausted` [3rd party] | `/free-credits` available/low/exhausted; merchant portal | docs.payai.network/x402/facilitators/pricing |
| OZ Channels / Built on Stellar | Stroops per key (records maxFee, incl. on-chain failures) | Fixed 24 h from the key's first transaction | Hard stop, 429 `FEE_LIMIT_EXCEEDED` with consumed/limit; admin raises per key | Admin `Get Fee Usage` (remaining, periodEndsAt) | docs.openzeppelin.com/relayer/plugins/channels |
| Launchtube (legacy) | XLM credits per token (held, then refunded) | Token TTL; no reset | Credits exhausted | `X-Credits-Remaining` header, `GET /info` | github.com/stellar/launchtube |
| Alchemy Gas Manager | USD and op count, per sender and per policy | Lifetime, no reset; start/end dates | Distinct error per limit | Dashboard, Admin API | support.alchemy.com/articles/1436065162 |
| Pimlico | USD and op count; global, per user, per op | never/daily/weekly/monthly (default never) | Not sponsored | API, dashboard | docs.pimlico.io/…/sponsorship-policies/object |
| CDP Paymaster | USD and op count per user; USD global | Daily/weekly/monthly | `-32001`, per-address vs global message | Dashboard | docs.cdp.coinbase.com/paymaster/guides/paymaster-masterclass |
| Circle Gas Station | USD per tx and per day; ops per day | Daily, 00:00 UTC | Not sponsored; user pays gas | Console | developers.circle.com/wallets/gas-station/policy-management |
| Infura | Credits | Daily, 00:00 UTC | Hard stop, 402 | Emails at 75/85/100% | docs.infura.io/how-to/avoid-rate-limiting |
| Helius | Credits | Monthly (day [unverified]) | Hard stop, 429 "max usage reached" | Dashboard Usage page | helius.dev/docs/faqs/billing |
| GitHub REST | Requests per user | Hourly, `x-ratelimit-reset` | 403/429 | `x-ratelimit-*` headers | docs.github.com/…/rate-limits-for-the-rest-api |
| Anthropic API | USD spend per org | Calendar month, resumes 00:00 UTC on the 1st | Hard stop, 429 `enforced_spend_limit_reached`, date in message | Console; `anthropic-ratelimit-*` (rate) | platform.claude.com/docs/en/api/rate-limits |
| OpenAI API | USD per month per tier | Monthly (alignment not stated) | 429 `insufficient_quota` | Console; `x-ratelimit-*` | developers.openai.com/api/docs/guides/rate-limits |
| Mapbox | Per-service units | Billing period, 1st to last day of month | Billed | Email first time over; custom alerts | docs.mapbox.com/accounts/faq/how-does-pay-as-you-go-billing-work |
| Google Maps | Calls per SKU per billing account | 1st of month, midnight Pacific | Billed | Cloud console | developers.google.com/maps/billing-and-pricing/overview |
| QuickNode x402 free tier | x402 requests per agent | Monthly refresh | Not stated; revocable for abuse | Not stated | quicknode.com/blog/x402-free-tier |

## What this suggests for us

- **Calendar month, UTC, and say the instant.** Where a monthly free allowance's reset is stated, it is
  the 1st: Anthropic (00:00 UTC), Google (midnight Pacific), Mapbox, CDP Node; daily ones reset at
  00:00 UTC (Infura, Circle). Windows from first use (OZ's 24 h) or from an edit (Biconomy) are harder to
  explain. This matches decision 24's calendar-month rule. Anthropic's refusal names the date access
  returns; ours could too.
- **Count for the quota, stroops for the budget.** The x402 facilitators meter a **count of successful
  settlements** (CDP: verify and failed settles are free). Sponsors guarding their own wallet meter
  **fees** (OZ in stroops, Launchtube in XLM, paymasters in USD), usually with a count as well. A count
  is easy to explain to a seller; a per-key stroop budget is the safety net against fee spikes and failed
  transactions, which still burn fees. OZ charges the **max fee** on success and on on-chain failure.
- **Hard stop until the reset, with a manual raise.** Every free service with no billing behind it stops
  at the limit: OZ, Launchtube, Infura, Helius, the Anthropic cap. Billing replaces the stop only where a
  payment method exists (CDP, Mapbox, Google). The raise is manual or by tier: OZ's per-key "Set Fee
  Limit", CDP Paymaster ("ask on Discord"), Anthropic ("Request tier increase").
- **Refuse before spending.** OZ checks `consumed + maxFee > limit` before it submits; refusing at
  `/verify` also lets the seller withhold the resource. Reserve the max fee at the check, since OZ's
  separate check and record lets concurrent calls overshoot **[inferred]**.
- **The refusal: 429, a machine code, the numbers and the reset.** A code of its own, like Anthropic's
  `enforced_spend_limit_reached` or OZ's `FEE_LIMIT_EXCEEDED` (the IETF draft maps `quota-exceeded` to 429);
  used/limit, as OZ gives, and the reset time; no `Retry-After` for a monthly stop, as Anthropic. Not 402,
  which to an x402 client means "pay" (Infura's 402 predates x402). Different codes for the per-key limit
  and the shared pool, as Alchemy ("per spender" vs "global") and CDP Paymaster do.
- **Show usage in the account and on responses.** OZ's `consumed/limit/remaining/periodEndsAt` maps onto
  the hub's `account`. The header options are Launchtube's `X-Credits-Remaining`, GitHub's
  `x-ratelimit-*` and the IETF `RateLimit`/`RateLimit-Policy` (still a draft). Infura also emails at
  75/85/100%, and PayAI's public check is deliberately coarse (available/low/exhausted).
- **A shared free pool on top of the per-key quota.** Every paymaster pairs a per-user cap with a global
  one (Alchemy, Pimlico, CDP Paymaster, Privy's wallet/user/app tiers). With Discord-gated keys the
  exposure is keys × quota, and only a global pool bounds that. When the pool is empty, everyone on the
  free tier is refused, so it needs its own error and an alarm.
- **Identity cost is the real gate; keep a way to lower or revoke one key.** Per Douceur, per-identity
  quotas only move the attack to getting identities. Practitioners accept some abuse, score risk
  (Geocodio), scale allowances with identity strength (Optimism) or revoke abusers (QuickNode); OZ's
  per-key custom limit is the tool for that.

## Sources (all read 2026-11-23)

CDP x402: https://docs.cdp.coinbase.com/x402/core-concepts/facilitator.md · https://docs.cdp.coinbase.com/x402/seller/facilitator.md ·
https://docs.cdp.coinbase.com/x402/support/faq.md · https://docs.cdp.coinbase.com/x402/support/troubleshooting.md ·
https://docs.cdp.coinbase.com/get-started/changelog · https://docs.cdp.coinbase.com/api-reference/v2/rate-limits.md ·
https://docs.cdp.coinbase.com/data/node/pricing.md · https://docs.cdp.coinbase.com/x402/network-support.md ·
https://www.kucoin.com/news/flash/coinbase-x402-facilitator-to-charge-0-001-per-settlement-starting-january-2026 [3rd party] ·
https://dev.to/whiteknightonhorse/how-we-replaced-our-x402-payment-facilitator-in-a-single-afternoon-f84 [3rd party]
(https://www.coinbase.com/developer-platform/pricing answered 403.)

x402 facilitators and spec: https://docs.payai.network/x402/facilitators/pricing ·
https://stablecoininsider.org/how-to-enable-payai-x402-facilitator-for-usdc/ [3rd party] ·
https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar · https://docs.openzeppelin.com/relayer/plugins/channels ·
https://docs.openzeppelin.com/relayer/guides/stellar-channels-guide · https://docs.openzeppelin.com/relayer/guides/stellar-x402-facilitator-guide ·
https://github.com/OpenZeppelin/relayer-plugin-channels (src/plugin/fee-tracking.ts, submit.ts, handler.ts) ·
https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator (README) · https://github.com/stellar/launchtube (README, archived) ·
https://portal.thirdweb.com/x402/facilitator · https://portal.thirdweb.com/x402/faq · https://docs.heurist.ai/x402-products/facilitator ·
https://github.com/x402-rs/x402-rs · https://docs.corbits.dev/ · https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md ·
https://github.com/x402-foundation/x402/blob/main/specs/extensions/extension-auth-hints.md ·
https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md ·
https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md (commit 4f64aba4, 2026-11-06) ·
https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/solana/draft-solana-charge-00.md (seen in code search only)

Paymasters: https://support.alchemy.com/articles/1436065162-best-practices-to-limit-gas-manager-spend ·
https://www.alchemy.com/docs/wallets/reference/gas-manager-errors · https://docs.pimlico.io/references/platform/api/sponsorship-policies/object ·
https://docs.cdp.coinbase.com/paymaster/guides/paymaster-masterclass.md · https://developers.circle.com/wallets/gas-station/policy-management.md ·
https://docs.zerodev.app/meta-infra/gas-policies · https://docs.privy.io/recipes/gas-sponsorship-rate-limits.md ·
https://docs.biconomy.io/dashboard/spendingLimits (404)

APIs: https://docs.infura.io/how-to/avoid-rate-limiting.md · https://support.metamask.com/develop/account/limits/daily-limits/ ·
https://www.helius.dev/docs/faqs/billing.md · https://www.helius.dev/docs/billing/plans.md ·
https://support.alchemy.com/articles/5827006872-what-is-included-in-the-free-tier · https://support.quicknode.com/articles/5364861616-monthly-usage-limits ·
https://www.quicknode.com/blog/x402-free-tier · https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api ·
https://platform.claude.com/docs/en/api/rate-limits · https://developers.openai.com/api/docs/guides/rate-limits ·
https://docs.mapbox.com/accounts/faq/how-does-pay-as-you-go-billing-work.md · https://developers.google.com/maps/billing-and-pricing/overview ·
https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/ · https://www.ietf.org/archive/id/draft-ietf-httpapi-ratelimit-headers-12.html

Sybil: https://www.microsoft.com/en-us/research/publication/the-sybil-attack/ · https://geocod.io/code-and-coordinates/2025-02-19-preventing-abuse ·
https://optimism.io/blog/using-onchain-reputation-data-for-testnet-funds-with-the-superchain-faucet ·
https://blog.castle.io/how-bots-and-fraudsters-exploit-free-tiers-in-ai-saas/ (search summary only)
