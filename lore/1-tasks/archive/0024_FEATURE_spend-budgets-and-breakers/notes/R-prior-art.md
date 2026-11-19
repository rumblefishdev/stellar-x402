---
title: "How fee sponsors contain fee drain"
type: research
status: mature
tags: [facilitator, fees, budgets]
history:
  - date: "2026-10-29"
    status: mature
    who: akot
    note: "Research for the 0024 design (agent report, read only)."
---

# F-prior-art: how fee sponsors contain fee drain, and what 0024 should take from them

Technical research for task 0024 (spend budgets and circuit breakers, ADR 0007, spine AD-18).
Date: 2026-10-29. Analyst: Mary (BMAD TR).

This report builds on R-facilitator-survey
([0066's R-facilitator-survey](../../0066_BUG_archived-state-restore-fee/notes/R-facilitator-survey.md)).
That survey covered restore rent, the Stellar spec's fee cap and code, and the SVM rule that the fee payer pays only the network fee. This report doesn't repeat those findings. It looks at **drain containment**: budgets, rate limits, allowlists, dedup, failure counting and breakers.

Code links are pinned to the commits read on 2026-10-29. **[UNVERIFIED]** marks a claim I could not confirm from a primary source. **[spot-checked]** marks a claim I re-read in the source myself, not only through a research sub-agent.

## 0. Where 0024 starts (repo facts)

| Fact | Source |
| --- | --- |
| The `SpendStore` port already has `reserve`/`commit`/`release`/`used`/`prune` and `recordFailure`/`recordSuccess`/`openBreaker`/`breakerOpenUntil`. `recordFailure` returns *consecutive* failures. | `apps/facilitator/src/ports/spend-store.ts` |
| A reservation is all-or-nothing across every scope, and an `id` is idempotent. `state` is `reserved \| committed`, and `release` deletes only `reserved`. | same; `apps/facilitator/src/adapters/postgres-schema.ts` L89-106 |
| Defaults: window 24 h (`SPEND_WINDOW_MS=86400000`), global 500 XLM, per payer 5 XLM, per payTo 50 XLM, per asset 200 XLM, breaker 5 failures, cooldown 10 min. | `apps/facilitator/src/config.ts` L198-215 |
| The settlement key is `${network}:${payer}:${nonce}`, so dedup is on the auth nonce, not on the transaction bytes. | `apps/facilitator/src/settlement/settle.ts` L691 |
| Only the store calls `recordFailure`/`openBreaker`. No policy wires them yet. | `grep` over `apps/facilitator/src` |
| Open items from reviews: per-(payer, asset) single-flight, failures attributed to the payer rather than the asset, a PRNG `__check_auth` or zero-amount transfers that burn fees, a wasm token that never calls `require_auth`, refusing a reserve after release, and 503 on a busy store. | `lore/1-tasks/backlog/0024_FEATURE_spend-budgets-and-breakers.md` |

## 1. Findings by ecosystem

### 1.1 x402 facilitators and specs

- **Upstream `@x402/stellar`** has no rate limit, no budgets, no dedup cache and no handling for "passes simulation, fails on chain". Its guards are the fee cap (`maxTransactionFeeStroops`, default 50,000, [scheme.ts L36](https://github.com/x402-foundation/x402/blob/957b1e4738c4c2a57174ad615fb73a9ead6e14ac/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts#L36), [L543](https://github.com/x402-foundation/x402/blob/957b1e4738c4c2a57174ad615fb73a9ead6e14ac/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts#L543)) and `facilitator_is_payer` ([L505](https://github.com/x402-foundation/x402/blob/957b1e4738c4c2a57174ad615fb73a9ead6e14ac/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts#L505)). The core facilitator exposes `onBeforeSettle` hooks that may abort ([x402Facilitator.ts L141](https://github.com/x402-foundation/x402/blob/957b1e4738c4c2a57174ad615fb73a9ead6e14ac/typescript/packages/core/src/facilitator/x402Facilitator.ts#L141)), but upstream ships no policy in them.
- **Upstream SVM** has a `SettlementCache`: an in-memory dedup on the message hash with a 120 s TTL. It reserves the key synchronously before the first `await`, and frees it if the transaction was never broadcast ([settlement-cache.ts](https://github.com/x402-foundation/x402/blob/957b1e4738c4c2a57174ad615fb73a9ead6e14ac/typescript/packages/mechanisms/svm/src/settlement-cache.ts)).
- **The SVM spec, §2.2 "Cost and Griefing Controls"**, caps compute units at 400,000 and the priority fee at 5,000,000 µlamports. It also says simulation is a fee saving, **not a security control**, and that a sponsor MAY add stricter policy ([spec L312-338](https://github.com/x402-foundation/x402/blob/957b1e4738c4c2a57174ad615fb73a9ead6e14ac/specs/schemes/exact/scheme_exact_svm.md#L312)).
- **The EVM spec, ERC-7710 security considerations**, names the race we care about: the client invalidates a payment after simulation and the facilitator pays for the failed transaction. Its suggested mitigations are a private mempool, an explicit gas limit, rejecting high simulated gas, and "reputation systems" that can "flag or ban abusive behavior" ([evm spec L306-316](https://github.com/x402-foundation/x402/blob/957b1e4738c4c2a57174ad615fb73a9ead6e14ac/specs/schemes/exact/scheme_exact_evm.md#L306)).
- **Coinbase CDP facilitator** requires a CDP API key. The first 1,000 transactions a month are free, then $0.001 each. It accepts any EIP-3009 or Permit2 ERC-20, and screens addresses for OFAC and KYT ([docs](https://docs.cdp.coinbase.com/x402/seller/facilitator)). Its x402-specific rate limit is **[UNVERIFIED]**; the general v2 API allows 500 writes per 10 s ([rate-limits](https://docs.cdp.coinbase.com/api-reference/v2/rate-limits)). Its containment is identity plus price, not budgets.
- **OpenZeppelin x402 plugin**:
  - It has a per-network `assets` **allowlist** ([verify.ts L151](https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator/blob/5783d5493c9760acfc9e678b14738afa96162075/src/stellar/verify.ts#L151)). `/verify` and `/settle` sit behind a Relayer API key, which carries a per-key governor limit of 100 rps with a burst of 300 ([server_config.rs L156](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/487bfd242a5cf08a3514e24beab1c01b731421b3/src/config/server_config.rs#L156)).
  - **Weakness:** the idempotency key carries a per-call attempt id. A concurrent replay of one payment "gets its own transaction, which fails on the used nonce", and the sponsor pays for it ([settle.ts L64-73](https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator/blob/5783d5493c9760acfc9e678b14738afa96162075/src/stellar/settle.ts#L64)).
- **r402** has an atomic TTL `SettlementCache.reserve(tx_b64)` (2 min) that answers `DuplicateSettlement` ([settle.rs L90](https://github.com/qntx/r402/blob/dfb1d0c021cab51dadf87ac3ef15044d904c5b20/crates/r402-stellar/src/exact/facilitator/settle.rs#L90)). The key is the whole envelope, so the same auth nonce in a re-encoded envelope probably gets past it (my inference, not tested).
- **PayAI** gives 1,000 free credits without a key, then requires one ([docs](https://docs.payai.network/x402/facilitators/introduction)). **x402-rs** rate-limits only outbound RPC. Faremeter and thirdweb were not checked.
- **Academic:** Wang et al., "When HTTP 402 Meets the Blockchain: Risks on Emerging x402 Payments" ([arXiv 2607.19545](https://arxiv.org/abs/2607.19545); the title was spot-checked through the arXiv API). A secondary source ([CryptoSlate](https://cryptoslate.com/31-newly-discovered-vulnerabilities-expose-99-of-x402-crypto-payments-to-asset-theft-and-free-shopping/)) reports these claims:
  - all 15 facilitators tested had service-denial or cost-amplification paths;
  - "Gas Abuse" is an attack class;
  - the mitigations are reserve nonces, cap sponsored fees, reject non-settleable payments, and bind verify to settle.

  I didn't read the paper body, so these claims are **[UNVERIFIED in primary]**.

### 1.2 Stellar fee sponsors

- **Launchtube** ([stellar/launchtube @1821ebd](https://github.com/stellar/launchtube/tree/1821ebdd95829e8d023f5291baaa9df424af489d), archived and superseded by OZ Channels):
  - Each caller holds a JWT credit token: 100 XLM by default, 12-week TTL, must be activated ([tokens-generate.ts](https://github.com/stellar/launchtube/blob/1821ebdd95829e8d023f5291baaa9df424af489d/src/api/tokens-generate.ts#L11)).
  - Every submit first spends `EAGER_CREDITS` (100,000 stroops) "as a spam prevention measure". After simulation that becomes the bid, then the actual `feeCharged`, **also when the transaction fails with a fee charged** ([launch.ts L94-96, L306-329](https://github.com/stellar/launchtube/blob/1821ebdd95829e8d023f5291baaa9df424af489d/src/api/launch.ts#L94), **[spot-checked]**).
  - Other guards: exactly one `invokeContract` operation, an inner fee no higher than the resource fee + 201, and `maxTime` ≤ 30 s.
  - **Weakness:** credits can go negative, as a code comment admits.
- **OZ Relayer Channels plugin and the hosted Channels service**:
  - `FEE_LIMIT` is a stroop budget per API key, reset every `FEE_RESET_PERIOD_SECONDS`, with a custom limit possible per key. The hosted service resets the budget 24 h after the first transaction and doesn't publish the limit ([channels.mdx L173-191](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/487bfd242a5cf08a3514e24beab1c01b731421b3/docs/1.8.x/plugins/channels.mdx#L173), [guide L153-163](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/487bfd242a5cf08a3514e24beab1c01b731421b3/docs/1.8.x/guides/stellar-channels-guide.mdx#L153)).
  - `checkBudget(maxFee)` runs before submit and answers 429 `FEE_LIMIT_EXCEEDED`. `recordUsage(maxFee)` runs after success, after an on-chain failure and on skip-wait ([fee-tracking.ts L63-110](https://github.com/OpenZeppelin/relayer-plugin-channels/blob/c7cf073b20b8217f7e739aafbc6aa6bd42d36b34/src/plugin/fee-tracking.ts#L63), [submit.ts L98, L137, L173](https://github.com/OpenZeppelin/relayer-plugin-channels/blob/c7cf073b20b8217f7e739aafbc6aa6bd42d36b34/src/plugin/submit.ts), **[spot-checked]**).
  - `LIMITED_CONTRACTS` with `CONTRACT_CAPACITY_RATIO` (0.8) confines a listed contract to part of the channel pool, which is an isolation (bulkhead) control.
  - **Weaknesses:**
    - checking and recording are separate steps with no reservation, so concurrent requests overshoot the budget;
    - it records `maxFee`, not the actual fee;
    - a wait timeout is never charged;
    - `recordUsage` swallows errors after 3 lock retries.
- **OZ Relayer Stellar policy:** `max_fee`, `allowed_tokens[{asset,max_allowed_fee}]`, `min_balance`, `concurrent_transactions` and `fee_payment_strategy` ([mod.rs L607-628](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/487bfd242a5cf08a3514e24beab1c01b731421b3/src/models/relayer/mod.rs#L607)). The policy `max_fee` may be enforced only on the user-pays path ([gas_abstraction.rs L306](https://github.com/OpenZeppelin/openzeppelin-relayer/blob/487bfd242a5cf08a3514e24beab1c01b731421b3/src/domain/relayer/stellar/gas_abstraction.rs#L306)) **[UNVERIFIED]**. `min_balance` is a floor: the relayer stops below a set balance.
- **Stellar docs:** the [fee-bump guide](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions) says nothing on limits or abuse. Passkey-kit and Freighter sponsorship historically went through Launchtube **[UNVERIFIED]**.

### 1.3 EVM account abstraction (ERC-4337 / ERC-7562)

- **Reputation ([ERC-7562](https://eips.ethereum.org/EIPS/eip-7562), [spot-checked])**:
  - Per entity (paymaster, factory, aggregator, staked account) the bundler keeps `opsSeen` and `opsIncluded`. Both decay by ×23/24 every hour.
  - With `max_seen = opsSeen / MIN_INCLUSION_RATE_DENOMINATOR` (10), the entity is BANNED if `max_seen > opsIncluded + BAN_SLACK` (50) and THROTTLED if `max_seen > opsIncluded + THROTTLING_SLACK` (10).
  - A THROTTLED entity is limited to 4 ops in the mempool, 4 per bundle, and 10 live blocks per op.
  - The spec bounds a malicious paymaster to about `BAN_SLACK × 10 / 24` non-paying ops per hour.
- **Attribution rules:**
  - **GREP-040:** an entity that passed the second validation and then fails bundle creation is banned at once (`opsSeen = 10000`, `opsIncluded = 0`).
  - **EREP-015:** a paymaster's `opsSeen` isn't incremented for a failure the factory or account caused, so a failure counts against the entity that caused it.
  - **EREP-030:** a staked account is blamed even when another entity caused the failure.
- **Deposit reservation (EREP-010):** the bundler tracks the summed max gas of pending ops per paymaster and refuses a new op that would exceed the paymaster's deposit. This is in-flight reservation against a balance.
- **Concurrency per sender:** `SAME_SENDER_MEMPOOL_COUNT = 4` and `SAME_UNSTAKED_ENTITY_MEMPOOL_COUNT = 10`.
- **"Passes simulation, fails on chain"**:
  - Validation is made deterministic: OP-011 bans TIMESTAMP, NUMBER, PREVRANDAO, BLOCKHASH and other environment opcodes, and the STO-0xx rules limit storage access.
  - Validation runs twice, once on receipt and once before bundling.
  - Execution is unrestricted, and the paymaster pays when execution reverts (`PostOpMode.opReverted`, [IPaymaster.sol](https://github.com/eth-infinitism/account-abstraction/blob/1c6b669d0eea734e09a87e095ba15e076151718a/contracts/interfaces/IPaymaster.sol)).
  - The validation/execution split puts the blame on whoever controls the failing step.
  - **This is the closest analogue of the PRNG `__check_auth` case in 0024.**
- **Reserve and commit in the protocol:** `validatePaymasterUserOp(..., maxCost)` prefunds `maxCost`, and `postOp(..., actualGasCost, ...)` charges the actual cost ([EIP-4337 rationale](https://eips.ethereum.org/EIPS/eip-4337)).
- **Commercial paymaster policies:**

  | Provider | Policy fields | Window |
  | --- | --- | --- |
  | [Pimlico](https://docs.pimlico.io/references/platform/api/sponsorship-policies/object) | global, per-user and per-op spend caps, op counts, webhook | `reset_interval` never/daily/weekly/monthly |
  | [Alchemy Gas Manager](https://www.alchemy.com/docs/wallets/api-reference/gas-manager-admin-api/admin-api-endpoints/create-policy.md) | `maxSpendUsd`, `maxSpendPerSenderUsd`, `maxSpendPerUoUsd`, `maxCount`, `maxCountPerSender`, sender allow/block lists, start/end time, webhook | lifetime of the policy **[UNVERIFIED]**; `webhookRules.approveOnFailure` makes the webhook fail open |
  | [ZeroDev](https://docs.zerodev.app/meta-infra/gas-policies) | amount / request / gas price / amount-per-tx rate limits, per project, contract or wallet | intervals |
  | [Coinbase CDP paymaster](https://docs.cdp.coinbase.com/paymaster/guides/paymaster-masterclass) | per-user and global limits, allowlisted contracts and functions | per-user resets daily/weekly/monthly |
  | Biconomy | global and per-user caps | 1-23 h cycles **[PARTLY UNVERIFIED]** |

  None of them documents whether its windows are fixed or rolling. None has a per-recipient or per-asset spend cap, except contract allowlists.
- **Incidents:**
  - **OpenGSN `acceptanceBudget`:** past a gas threshold the paymaster pays "no matter what". The lesson is to put a hard cap on the cost lost before the sponsor can refuse ([docs](https://docs.opengsn.org/soldoc/contracts/basepaymaster)).
  - **Enzyme GSN paymaster bug** ([Immunefi](https://immunefi.com/blog/bug-fix-reviews/enzyme-finance-privilege-check/)): automatic top-ups from a large pool defeat a small float.
  - **Alchemy VerifyingPaymaster packing bug** ([Alchemy](https://www.alchemy.com/blog/erc-4337-useroperation-packing-vulnerability)): a sponsorship must bind the whole operation.

### 1.4 Solana fee payers

- **Kora** ([solana-foundation/kora @bc1f339](https://github.com/solana-foundation/kora/blob/bc1f339fee0b08156a558e81be0279b3b7d1c53b/kora.toml)):
  - `rate_limit` (100 rps) is a tower layer **per connection**, not per IP or global.
  - Auth is by `api_keys`, HMAC or reCAPTCHA.
  - `[validation]`: `max_allowed_lamports`, `max_priority_fee_lamports`, `max_signatures`, `allowed_programs`, `allowed_tokens`, `allowed_spl_paid_tokens` (empty by default, which means deny all), `disallowed_accounts`.
  - A `fee_payer_policy` has per-instruction booleans that keep the fee payer out of instructions. **The code defaults all of them to false**, while the sample toml enables most.
  - `[kora.usage_limit]` per wallet:
    - counts transactions or instructions, not lamports, in a **fixed window** (`kora:tx:{user}:{ts/window}`);
    - stored in Redis, or in memory without one;
    - **`fallback_if_unavailable = false` means it fails closed**;
    - usage is counted at signing, with no rollback on an on-chain failure **[UNVERIFIED beyond the files read]**.
  - Lighthouse can append balance assertions about the fee payer, so a drain attempt fails on chain.
  - **Advisories:**
    - Unknown instruction types bypassed `fee_payer_policy` ([GHSA-x442-m7cc-hr92](https://github.com/solana-foundation/kora/security/advisories/GHSA-x442-m7cc-hr92)).
    - The Token-2022 transfer fee was ignored in the payment check ([GHSA-725g-w329-g7qr](https://github.com/solana-foundation/kora/security/advisories/GHSA-725g-w329-g7qr)).
  - Kora has **no lamport budget per anything, no per-recipient or per-asset budget, and no breaker.**
- **Octane** (the upstream repo is gone; I read [a fork](https://github.com/JeffreyJoel/octane-0/tree/2a341f739d87f8ae7762b0c9b2ce23795d987377) **[UNVERIFIED identical]**):
  - The fee payer must not be a signer or writable in any instruction.
  - A duplicate-message cache: sha256 key, 1,000 entries, 120 s TTL, in memory.
  - **A 5 s lockout per source token account (`sameSourceTimeout`)**, because "several sign requests can all simulate fine before the first confirms, and the rest then fail on chain". This is the exact parallel-spend griefing that 0024 lists.
  - A per-IP rate limit.
  - The README advises keeping only 3-4 hours of SOL in the fee payer, never returning the fee payer's signature for an unconfirmed transaction, and adding per-user and global limits.
- **OZ Relayer Solana policy:** `max_allowed_fee_lamports`, `allowed_programs`, `allowed_tokens` (empty means all), `min_balance` and others ([docs](https://docs.openzeppelin.com/relayer/solana)). No spend budgets.

### 1.5 Generic patterns

- **Spend limiters** compared:

  | Limiter | How it works | Weakness |
  | --- | --- | --- |
  | Fixed window (Kora) | counts per fixed period | spends twice the limit across a window boundary |
  | Sliding log | exact | memory and CPU cost |
  | Sliding-window counter ([Cloudflare](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)) | 2 numbers per key, about 0.003% error | assumes even spread inside the window |
  | Token bucket ([Stripe](https://stripe.com/blog/rate-limiters)) / GCRA ([redis-cell](https://github.com/brandur/redis-cell)) | `quantity` makes it cost-weighted; Envoy has `hits_addend` ([rls.proto L55](https://github.com/envoyproxy/envoy/blob/1b4730bc0a93fd120b3b150709703390080348e5/api/envoy/service/ratelimit/v3/rls.proto#L55)) | a bucket controls rate, not a total loss over a period |

  Stripe's limiters **fail open** by design, which is the wrong default for a drain guard. [AWS API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html) warns: "Don't rely on usage plan quotas or throttling to control costs". The [AWS fairness](https://builder.aws.com/content/3Eupj3d2bo4fEvlzYbICMZNhQ3B/fairness-in-multi-tenant-systems) article charges every request the cheapest price first and debits the true cost later, which can drive a quota negative.
- **Two-phase accounting:**
  - **TigerBeetle** pending/post/void transfers ([docs](https://docs.tigerbeetle.com/coding/two-phase-transfers/)): limits are checked **when the hold is placed**; posting can be partial, and the rest is released; a `timeout` auto-voids the hold; and a second resolution fails with `already_posted`, `already_voided` or `expired`, so nothing is released twice.
  - **Card holds** ([Stripe](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)) expire after about 7 days, and a partial capture releases the rest.
  - **GCP `allocateQuota`** ([ref](https://docs.cloud.google.com/service-infrastructure/docs/service-control/reference/rest/v1/services/allocateQuota)): NORMAL is all-or-nothing, and an `operationId` makes retries idempotent.
  - **Doorman** ([design](https://github.com/youtube/doorman/blob/master/doc/design.md)) leases capacity with an expiry. When it can't reach the server, the client falls back to pessimistic, optimistic or `safe_capacity` mode.
- **Circuit breakers:**
  - [resilience4j](https://resilience4j.readme.io/docs/circuitbreaker) defaults: `failureRateThreshold` 50%, `minimumNumberOfCalls` 100, a count or time sliding window, `waitDurationInOpenState` 60 s, 10 permitted calls in half-open state, and `recordFailurePredicate` to choose what counts as a failure.
  - [Hystrix](https://github.com/Netflix/Hystrix/wiki/Configuration) defaults: `requestVolumeThreshold` 20, error threshold 50%, sleep window 5 s.
  - [Fowler](https://martinfowler.com/bliki/CircuitBreaker.html): "Not all errors should trip the circuit".
  - [Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker), "resource differentiation": one breaker over independent resources blocks the healthy ones.
  - [AWS shuffle sharding](https://builder.aws.com/content/3F06NpJ8YeoIGP8VHTw4n81pFn8/workload-isolation-using-shuffle-sharding) for isolation.
  - **I found no authoritative write-up of "the breaker as a DoS vector"** **[UNVERIFIED as named prior art]**. The risk follows from the sources above: a shared breaker that anyone can trip is a kill switch that anyone can pull.

## 2. Pattern catalog

| # | Pattern | Who uses it | What it prevents | Known weaknesses | Applicability to 0024 |
| --- | --- | --- | --- | --- | --- |
| P1 | Per-transaction fee cap | everyone: x402 Stellar spec, upstream, r402, OZ (`max_fee`, optional), Kora `max_allowed_lamports`, SVM spec CU and priority caps | one expensive transaction | every transaction can be inflated up to the cap; it doesn't bound volume | Have it already (`maxFeeStroops`, AD-10). Size every budget in multiples of this cap. |
| P2 | Global spend cap per period | Pimlico, Alchemy (`maxSpendUsd`), CDP paymaster, OZ Channels hosted (per key) | total loss in a period | one attacker can exhaust it for everyone (ADR 0007 already notes this) | Adopt. It is the hard stop. Pair it with an alert at a fraction of the cap. |
| P3 | Per-identity spend cap | Alchemy `maxSpendPerSenderUsd`, Pimlico `limits.user`, CDP per-user, OZ Channels `FEE_LIMIT` per API key, Launchtube credits per token | one identity draining | worthless when identities are free (Sybil). Every production sponsor ties it to an **issued** identity: API key, JWT or contract allowlist. | Adapt. A payer is a free keypair, so per-payer bounds a clumsy attacker only. Per-`payTo` costs the same. Keep both, but the global and per-asset budgets carry the guarantee. |
| P4 | Per-asset / per-contract cap or allowlist | OZ plugin `assets` allowlist, Kora `allowed_tokens`, CDP paymaster contract allowlist, OZ Channels `LIMITED_CONTRACTS` (capacity share) | junk tokens; one contract taking the pool | an allowlist contradicts "any SEP-41" (ADR 0007); a per-asset cap alone is Sybil-able by deploying new tokens | Adapt. Tier by asset kind (SAC against wasm): a high per-asset cap for SACs and a low **aggregate cap for all wasm tokens together**, so that deploying new tokens doesn't mint new budget. |
| P5 | Pre-charge/eager hold, then true-up (reserve → commit/release) | ERC-4337 `maxCost` prefund + `postOp`, EREP-010 pending-gas vs deposit, Launchtube `EAGER_CREDITS`→bid→`feeCharged`, TigerBeetle pending/post/void, card holds, GCP `allocateQuota` | concurrent overshoot (the OZ Channels check-then-record race) | leaked holds; release after commit; holds outliving the window | Have the port. Adopt TigerBeetle's one-shot resolution (`reserved → committed \| released`, a second resolution refused) and keep the `released` row so that a late reserve is refused (open item in 0024). Commit **failures at the fee charged** (Launchtube does). |
| P6 | Fixed-window counters | Kora usage limits, Pimlico/CDP `reset_interval`, OZ Channels reset period | volume per period | twice the limit across the reset boundary; one reset time for everyone | Avoid. The rolling window in the store (AD-18) is already exact. |
| P7 | Rate limit by request count (token bucket, GCRA) | OZ Relayer governor per key, Kora per connection, Octane per IP, our AD-11 per IP | flooding | doesn't bound **cost**; IP rotation; AWS: "don't rely on … to control costs" | Keep as is (AD-11). It is no substitute for budgets. |
| P8 | Settlement dedup / in-flight reservation by payment identity | upstream SVM `SettlementCache` (message hash), r402 (tx bytes), Octane (message hash) | double submit of one payment | keyed on bytes, so a re-encoded envelope passes (r402); OZ deliberately doesn't dedup | Have it already, and stronger: the key is `network:payer:nonce`. Nothing to add. |
| P9 | Single-flight per spending source | Octane `sameSourceTimeout` (5 s per source token account), ERC-7562 `SAME_SENDER_MEMPOOL_COUNT` (4) | parallel spends of one balance that all simulate OK and then fail on chain | per-key, so a Sybil can split across payers; it adds latency for honest bursts | Adopt as **one non-final settlement per (payer, asset)**, or N>1 with in-flight amounts summed against the simulated balance. It closes the "N parallel /settle" griefing that 0024 lists. |
| P10 | Reputation by inclusion rate, with decay | ERC-7562 `opsSeen`/`opsIncluded`, ×23/24 per hour, THROTTLED/BANNED slacks | entities whose ops pass simulation and fail at inclusion | local view; fresh identities reset it; needs volume to be meaningful | Adapt for the breaker. Trip on failure **rate** with a minimum volume and slack, not on N consecutive failures, so one success doesn't reset an attacker who alternates. Apply it per payer and per wasm asset; for a SAC, throttle rather than ban. |
| P11 | Failure attribution to the entity that caused it | ERC-7562 EREP-015 (don't blame the paymaster for the account's failure), GREP-040, resilience4j `recordFailurePredicate`, Fowler | collateral bans of innocent parties | needs a classifier of failure causes | Adopt. Classify the on-chain result: a balance race, an expired nonce or auth, or a PRNG `__check_auth` counts against the **payer**; a token trap counts against the **asset** (wasm only); our own failures (sequence, fee too low, timeout) count against nothing. |
| P12 | Circuit breaker on a shared resource | resilience4j, Hystrix; Azure's "resource differentiation" warning | repeated paid failures | **weaponizable**: anyone who can cause failures can open a shared breaker (0024's "6 parallel calls open USDC for 10 min") | Adapt carefully. **Never let untrusted, cheap failures open a breaker that blocks third parties.** An open breaker for the USDC SAC or a popular `payTo` is a cheap DoS. Breaker scopes should be the attacker's own (payer, a wasm asset, a self-dealing payer=payTo pair), or the breaker should throttle (lower the in-flight cap) instead of refusing. |
| P13 | Half-open probe | resilience4j `permittedNumberOfCallsInHalfOpenState` (10), Hystrix sleep window | flapping; a breaker staying open long after the cause is gone | probes cost fees | Adapt. After the cooldown, allow 1 in-flight settlement for the scope, not a full reopen. |
| P14 | Fail-closed on limiter-store outage | Kora `fallback_if_unavailable=false`, Doorman pessimistic mode (opposite: Stripe and GCP fail open) | drain during a store outage | unavailability becomes a refusal | Adopt (it matches 0022's "reserve rejects → 503 with retry"). |
| P15 | Identity + price (API key, per-transaction fee) | CDP facilitator (key, $0.001/tx after 1,000), PayAI (credits, then key), Launchtube (JWT credits), OZ plugin and Channels (key) | Sybil, by making identities cost something | contradicts our open `/settle` (ADR 0007 deferred keys; AD-11 needs a registry, task 0060) | Avoid in T1 as a requirement. Note it as the only control in prior art that actually bounds per-identity drain; the tiered budgets should leave room for "keyed callers get larger budgets" later. |
| P16 | Sponsor balance floor / small float | OZ `min_balance`, Octane README (hold 3-4 h of SOL), Enzyme lesson (automatic top-up defeats the float) | worst-case loss when every budget fails | operational | Adopt as config and runbook. The global window budget ≤ float, no automatic refill above it, and `checkFacilitatorBalance` alerts (AD-18 already lists it). |
| P17 | Make validation deterministic | ERC-7562 OP-011 (environment opcodes banned), STO rules | ops that pass simulation and fail on chain | needs control over the validation VM | Not available on Soroban for `__check_auth` or wasm `transfer`. Note it as the reason P10 and P11 must exist. Upstream's "auth entry has a non-void signature" check is the only analogue. |

## 3. Adopt / adapt / avoid for 0024

**Adopt**

1. **Reserve, then resolve exactly once, with failures committed at the fee charged** (P5). Prior art: Launchtube, ERC-4337 prefund/postOp, TigerBeetle. Add a kept `released` state so that a late reserve is refused. The OZ Channels check-then-record race shows what the port's atomic reserve already avoids; keep it atomic.
2. **Single-flight per (payer, asset)** (P9). Prior art: Octane's 5 s same-source lock, ERC-7562's sender mempool cap. It is the only prior-art answer to N parallel spends of one balance.
3. **Fail closed on store errors with 503 + retry** (P14). Prior art: Kora's default, Doorman's pessimistic mode.
4. **Failure attribution before counting** (P11). Prior art: ERC-7562 EREP-015 and resilience4j predicates. Our own errors never count, payer-caused failures count against the payer, and a token-caused failure counts against a wasm asset.
5. **Global cap ≤ the hot-wallet float, with no automatic refill** (P2, P16). Prior art: Octane's README, the Enzyme incident.

**Adapt**

1. **Per-asset budgets: tier by asset kind** (P4). SACs get per-asset caps, and all wasm tokens share one **aggregate** cap plus low per-asset caps, because a per-asset cap alone is Sybil-able by deploying tokens. This is Adam's idea in 0024, and OZ `LIMITED_CONTRACTS` is the nearest prior art.
2. **Breaker: from N-consecutive to rate with minimum volume and decay** (P10, P13). ERC-7562's slack formula and resilience4j's `minimumNumberOfCalls` are the models. `recordFailure` returning consecutive failures lets an attacker alternate a success with each failure to keep the count low.
3. **Breaker scope and effect** (P12). Open (refuse) only scopes the attacker owns or creates cheaply: payer, wasm asset, the (payer, payTo) pair. For a SAC or a `payTo`, *throttle*: cap in-flight settlements at 1 and rely on budgets, instead of refusing everyone. After the cooldown, half-open with one probe.
4. **Per-payer and per-`payTo` budgets as Sybil-weak secondary bounds** (P3). Keep them, but don't count them toward the guarantee in ADR 0007's rationale. Write down that without an issued identity they bound only a careless attacker.

**Avoid**

1. **Fixed reset windows** (P6). They allow twice the limit at the boundary and a synchronized reset. The rolling window in the store is better than all the prior art I found.
2. **Shared breakers that untrusted, cheap failures can open** (P12). They are a kill switch anyone can pull. No source documents a defence, so this needs a test in 0024.
3. **Fail-open limiters** (Stripe, GCP, Alchemy `approveOnFailure`). Fine for availability limiters, wrong for drain guards.
4. **Recording `maxFee` instead of the actual fee, and skipping timeouts** (OZ Channels). Over-counting refuses honest traffic, and an uncharged timeout leaks budget.
5. **Token allowlists, and required API keys in T1** (P4, P15). They contradict ADR 0007, even though they are the most common real-world control.

## 4. Gaps and open questions

- **No prior art budgets fees per recipient or per asset.** 0024 is novel there, so its thresholds have no external calibration.
- **No source documents breaker weaponization or its defences** in a sponsor context. The recommendation in P12 is analysis, not precedent.
- **Unverified items:**
  - Coinbase CDP's x402 rate limit;
  - Alchemy's window semantics;
  - Biconomy's fields;
  - whether OZ's Stellar policy `max_fee` is enforced on the relayer-pays path;
  - Kora's rollback on an on-chain failure;
  - whether the Octane fork is identical to upstream;
  - the body of the arXiv x402 paper.
- **To verify on a Soroban host before relying on P11:** that the on-chain result codes (`txFAILED` with `InvokeHostFunction` trapped, `txBAD_AUTH`, `txTOO_LATE`, `txINSUFFICIENT_FEE`) are distinct enough to tell payer-caused failures from facilitator-caused ones.
