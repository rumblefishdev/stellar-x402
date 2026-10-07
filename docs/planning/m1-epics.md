---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - docs/architecture/m1-spine.md
  - docs/adr/0003-settlement-channel-account-pool.md
  - docs/adr/0004-facilitator-shape.md
  - docs/adr/0005-channel-accounts-as-facilitator-source.md
  - docs/adr/0006-settlement-record.md
  - docs/adr/0007-fee-abuse-containment.md
  - docs/adr/0008-bazaar-catalog-integrity.md
  - docs/adr/0009-conformance-gate-harness.md
  - docs/rfp/07-x402-facilitator-bazaar.md
  - docs/rfp/x402-facilitator-bazaar-technical-architecture.md
requirementsSource: >
  No PRD. Requirements are the RFP 7 core requirements filtered to the Tranche 1 scope agreed
  with okarcz (recorded in the spine's scope and the architecture memlog). This inventory is the
  written M1 scope.
---

# stellar-x402 Milestone 1 (Tranche 1) - Epic Breakdown

## Overview

This document breaks Milestone 1 (Tranche 1) of stellar-x402 into epics and stories. The
requirements come from the RFP, filtered to the agreed T1 scope, and the architecture comes from
the [M1 spine](../architecture/m1-spine.md) (AD-1 to AD-22). Each story becomes one lore backlog
task (lore 0012).

**T1 scope (agreed with okarcz, grant line items):**

1. Facilitator hardening on testnet: verify, settle and supported, any SEP-41 token, sponsored
   fees, rate limiting.
2. Channel-account pool in the settle path (permissive reimplementation).
3. Bazaar foundation: the resources endpoint and the cataloging pipeline, without ranking.
4. `upto`: final design and a testnet proxy-contract prototype.
5. Gate: an unmodified canonical client from the x402 e2e suite completes `exact` verify → settle
   against our testnet facilitator through an external proxy, and the settled transaction hash is
   recorded.

**Out of T1:** mainnet and its pricing, `/discovery/search` and ranking, the MCP server, SDK
helpers, `upto` in `/settle` (0015), the upstream `scheme_upto_stellar.md` merge, the developer
guide, the two example integrations, the security review report, uptime targets, and the
"deploy in under an hour" UX goal.

## Requirements Inventory

### Functional Requirements

- **FR1:** `POST /verify` checks an x402 v2 `exact` payment on `stellar:testnet` with upstream
  `@x402/stellar` verification (Soroban auth signatures and scope, `Address` and `AddressV2`
  credentials, simulation and balance changes) and returns a v2 `VerifyResponse`.
- **FR2:** `POST /settle` re-verifies the payment independently and settles it on
  `stellar:testnet`, returning a v2 `SettleResponse` with a 64-hex transaction hash, network and
  payer.
- **FR3:** `GET /supported` advertises `exact` on `stellar:testnet` with
  `extra.areFeesSponsored: true`, the `bazaar` extension, and the facilitator key as the only
  signer.
- **FR4:** Any SEP-41 token is accepted with no allowlist and USDC as the default. Testnet USDC,
  a self-issued SAC and a non-SAC SEP-41 token all verify and settle.
- **FR5:** The facilitator sponsors network fees: buyers hold only the payment asset. The fee is
  the simulated resource fee plus our inclusion bid (at least 100 stroops), never the client's
  fee, and comes from one fee configuration shared by verify and settle.
- **FR6:** Each settlement is one transaction submitted through the channel-account pool, with
  the channel as transaction source and the facilitator as operation source and fee-bump payer.
- **FR7:** The facilitator rejects any payload that references a channel account or the
  facilitator key as transaction source, operation source, `from` or auth-entry address.
- **FR8:** The facilitator rejects a payload whose auth expires in fewer than
  `minValidityLedgers` ledgers, and a submitted transaction never stays valid past the auth expiry.
- **FR9:** A settlement is claimed once per `network:payer:nonce`. A repeat with the same payload
  returns the stored outcome (waiting, within the settle timeout, if it is pending). A repeat with
  a different payload is rejected and nothing is submitted.
- **FR10:** Settlement records survive restarts: the hash is stored before the first send, states
  only move forward, a record can be found by any of its hashes, and records that aren't final
  are re-checked on chain at startup.
- **FR11:** Only one process at a time settles through a network's channel set (a lease), and
  shutdown waits until in-flight settlements are final or recorded as pending.
- **FR12:** Rate limiting has separate budgets for `/verify`, `/settle` and `/discovery/*`, keyed
  by client IP (from trusted proxy hops) or an optional API key, and returns HTTP 429 when a
  budget is exceeded. Caller authentication and rate limiting are documented.
- **FR13:** Spend budgets (global, per payer, per `payTo`, per asset) and circuit breakers (per
  asset, per `payTo`) stop fee drain. Over budget, `/settle` returns `success: false` and submits
  nothing.
- **FR14:** The facilitator raises alerts when a budget is nearly used up, a breaker opens, the
  facilitator balance is low, a channel is quarantined, or settlements are left pending.
- **FR15:** A resource is cataloged automatically after a successful settle when the client's
  payload carries `extensions.bazaar`. Both `http` and `mcp` resources are accepted.
- **FR16:** Catalog integrity: malformed required fields reject the listing, malformed optional
  fields are soft-dropped, `routeTemplate` is applied to the catalog key, `iconUrl` must be a safe
  absolute https URL, and upserts are idempotent and update `lastUpdated`.
- **FR17:** The settle response carries a best-effort `EXTENSION-RESPONSES` header with the
  cataloging outcome (`processing` or `rejected`). Cataloging never changes or delays the settle
  body or status.
- **FR18:** `GET /discovery/resources` lists catalog entries with the upstream discovery types
  and the `type`, `payTo`, `network`, `extensions`, `limit` and `offset` filters, with a bounded
  `limit`. There is no ranking.
- **FR19:** The `UptoProxy` contract is deployed to testnet and its settlement is tested end to
  end on chain, through the signer pool in the delegated-bump shape.
- **FR20:** The `upto` design is final and documented: a design ADR, contract docs, a threat model
  and a testnet report.
- **FR21:** The conformance gate: an unmodified canonical client from the x402 e2e suite, at a
  pinned upstream commit, completes the Stellar `exact` scenario against our testnet facilitator
  through `conformance/external-proxy/`. The results, with the upstream commit and transaction
  hashes, are committed to `conformance/results/`.

### NonFunctional Requirements

- **NFR1 (license):** Apache-2.0 with license-compatible dependencies and no AGPL. The
  implementation is independent and clean-room (ADR 0002): no OpenZeppelin relayer code.
- **NFR2 (conformance):** Wire level is x402 v2 only, with bodies typed by `@x402/core`. All
  `@x402/*` packages share one pinned version (`~2.28.0`), and `@stellar/stellar-sdk` stays on
  16.x, guarded by a protocol-29 `AddressV2` XDR fixture.
- **NFR3 (non-custodial):** The facilitator never holds client or seller funds or extends credit.
  Its accounts hold only XLM for fees and channel reserves.
- **NFR4 (key security):** One facilitator key per network, reached only through
  `TransactionSigner`. Channels have master weight 0 and the facilitator key as their only
  signer, checked at startup. Testnet and mainnet never share keys.
- **NFR5 (HTTP hardening):** A request body size limit, no CORS on `/verify` and `/settle`,
  trusted proxy hops from config, and no fetching of seller-supplied URLs.
- **NFR6 (throughput):** Concurrent settlements don't serialize on one sequence number: N
  channels allow up to N settlements per ledger (numbers from 0006).
- **NFR7 (observability):** Structured logs with one event per line, carrying network,
  settlement key and hash. Secrets and full XDR are never logged. Pool events feed metrics.
- **NFR8 (testing):** Unit tests with fakes in each package. Facilitator integration tests run
  against in-memory stores and `fake-rpc`. Testnet runs record their transaction hashes.
  Together they form a test suite for verification, settlement and discovery.
- **NFR9 (operations):** The facilitator is a long-lived process with no scale-to-zero. Deploys
  stop the old process before the new one starts. The service is testnet only and free to call.

### Additional Requirements

From the spine and ADRs, affecting how the work is split:

- **Brownfield, no starter template.** `packages/signer-pool`, `packages/config` and
  `contracts/upto-proxy` exist. `apps/facilitator`, `packages/bazaar` and `conformance/` are
  stubs.
- **Dependency upgrade first:** move all `@x402/*` to `~2.28.0` and add `zod` to
  `apps/facilitator` before the facilitator build.
- **Signer-pool prerequisites (0016):** an awaited async `onSigned` that aborts the send if it
  rejects, a `maxLedger` submit option, and the protocol-29 XDR fixture.
- **Paradigm (AD-1, AD-7):** a modular monolith. `apps/facilitator` is the only composition root
  and owns config (zod, read once), secrets, HTTP and store adapters. `packages/*` take
  dependencies through constructors. State goes through four ports (`SettlementStore`,
  `CatalogStore`, `RateLimitStore`, `SpendStore`), each with an in-memory fake.
- **Single owner (AD-16):** one settlement module in `apps/facilitator` makes every write to
  `SettlementStore`, with compare-and-set writes.
- **Upstream boundaries (AD-3):** never call upstream `ExactStellarScheme.settle()`, and never
  call `sendTransaction` outside the pool. Bazaar types come from `@x402/extensions`, and
  `packages/bazaar` holds only a pure validator and normalizer.
- **Key and config model (AD-12):** `FACILITATOR_SECRET` plus `CHANNELS` (addresses only). The
  existing deploy env (`FACILITATOR_SIGNER_SECRETS`, `FEE_BUMP_SIGNER_SECRET`) collapses into it.
- **Error mapping (AD-6):** every `SubmitStatus` and submitter error class maps to a fixed
  `errorReason`, and `pending` maps to `settlement_pending` with the hash.
- **Decisions this work depends on:** the state store (0013, ADR) is needed before real store
  adapters, and hosting, key custody, logger, metrics and alert backend (0014, ADR) are needed
  before the public testnet deployment and the gate run.
- **Interim values:** fee escalation and `maxFeeStroops` use interim testnet values (mainnet
  values: 0010). Numeric budgets and limits are set in config during the build and recorded with
  the task.
- **Gate harness (AD-15):** the proxy's `test.config.json` and `run.sh` (port,
  `Facilitator listening`, `/health`, `/close`, forwarding) live in our repo. A script clones
  `x402-foundation/x402` read-only at a pinned commit, and nothing is pushed upstream in M1.
- **Open question:** what `/exact/stellar/upfront` requires from a Stellar facilitator. The gate
  work must confirm it before the first gate run.
- **Conventions:** kebab-case ESM with `.js` imports, typed `Error` subclasses, `bigint`
  amounts as decimal strings on the wire, CAIP-2 networks, and HTTP 200 with x402 bodies for
  verify and settle outcomes (400 malformed, 429 rate limit, 500 unexpected).

### UX Design Requirements

None. T1 has no user interface.

### FR Coverage Map

| FR                                 | Epic   | Story                         |
| ---------------------------------- | ------ | ----------------------------- |
| FR1 `/verify`                      | Epic 1 | 1.3                           |
| FR2 `/settle`                      | Epic 1 | 1.4                           |
| FR3 `/supported`                   | Epic 1 | 1.6                           |
| FR4 any SEP-41 token               | Epic 1 | 1.7 (1.3, 1.4 token-agnostic) |
| FR5 sponsored fees, one fee config | Epic 1 | 1.3                           |
| FR6 one tx through the pool        | Epic 1 | 1.4                           |
| FR7 channel-address check          | Epic 1 | 1.3                           |
| FR8 minimum validity, `maxLedger`  | Epic 1 | 1.2, 1.3                      |
| FR9 claim, dedupe, replay          | Epic 1 | 1.4                           |
| FR10 durable records               | Epic 1 | 1.2, 1.5 (adapters 2.1)       |
| FR11 channel lease                 | Epic 2 | 2.4                           |
| FR12 rate limiting, documented     | Epic 2 | 2.2                           |
| FR13 spend budgets, breakers       | Epic 2 | 2.3                           |
| FR14 alerts                        | Epic 2 | 2.6                           |
| FR15 cataloging on settle          | Epic 4 | 4.2                           |
| FR16 catalog integrity             | Epic 4 | 4.1                           |
| FR17 `EXTENSION-RESPONSES`         | Epic 4 | 4.2                           |
| FR18 `/discovery/resources`        | Epic 4 | 4.3                           |
| FR19 `upto` testnet e2e            | Epic 5 | 5.1                           |
| FR20 `upto` docs                   | Epic 5 | 5.2                           |
| FR21 conformance gate              | Epic 3 | 3.1, 3.2 (deploy 2.5)         |

## Epic List

**Lanes.** Every story has one owning lane. The lanes run in parallel after a shared day-1 types PR (Story 1.1):

| Lane          | Owns                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Payments**  | the settlement module and the chain: verify, settle, records, lease, token matrix, `upto`                              |
| **Discovery** | the Bazaar end to end and the state store: 0013, store adapters, validator, cataloging, `/discovery/resources`         |
| **Platform**  | the service around the settle path: skeleton, `/supported`, rate limits, spend budgets, 0014, deploy, alerts, the gate |

Each lore task carries its lane as a tag: `payments`, `discovery` or `platform`.

### Epic 1: Resource servers can settle `exact` payments on testnet

A resource server calls `/verify`, `/settle` and `/supported` on our testnet facilitator for any SEP-41 token. Fees are sponsored, each payment is one transaction through the channel pool, replays are safe, and records survive a restart.

**FRs covered:** FR1–FR10

### Epic 2: Operators can run the facilitator publicly on testnet without being drained

The facilitator runs at a public testnet URL on durable stores, with one process per channel set, rate limits, spend budgets, circuit breakers and alerts.

**FRs covered:** FR11–FR14

### Epic 3: The x402 ecosystem can see that our facilitator conforms (the T1 gate)

An unmodified canonical client from the x402 e2e suite completes `exact` verify → settle against our testnet facilitator through our external proxy, and the results with transaction hashes are committed.

**FRs covered:** FR21

### Epic 4: Agents can discover paid resources in the Stellar Bazaar

Successful settlements that carry `extensions.bazaar` are validated and cataloged without affecting the payment, and anyone can list them through `GET /discovery/resources`.

**FRs covered:** FR15–FR18

### Epic 5: Sellers of metered services get a working `upto` prototype on testnet

`UptoProxy` is deployed on testnet with on-chain end-to-end tests through the signer pool, and the design is documented for reviewers, the facilitator team and the future `scheme_upto_stellar.md` author.

**FRs covered:** FR19–FR20

## Epic 1: Resource servers can settle `exact` payments on testnet

A resource server calls `/verify`, `/settle` and `/supported` on our testnet facilitator for any SEP-41 token. Fees are sponsored, each payment is one transaction through the channel pool, replays are safe, and records survive a restart.

### Story 1.1: Facilitator skeleton with store ports, settlement hooks and config

**Lane:** Platform · **Lore task:** 0017 · **Covers:** enables FR1–FR21; AD-1, AD-7, NFR7, NFR8

As a developer on any of the three lanes,
I want a facilitator app that boots, validates its config and wires every part through one composition root, with typed store ports and settlement hooks,
So that Payments, Discovery and Platform can build and test their parts in parallel against in-memory fakes.

**Acceptance Criteria:**

**Given** a types-only PR with the four store ports (`SettlementStore`, `CatalogStore`, `RateLimitStore`, `SpendStore`) and the operations AD-7 requires, the before-submit and on-success settlement hooks, and the zod config schema  
**When** it is opened on day 1  
**Then** all three lanes review and approve it before lane work builds on it

**Given** a valid environment  
**When** the app starts  
**Then** it reads and validates config once with zod, listens on the configured port and answers stub routes for `/verify`, `/settle`, `/supported` and `/discovery/resources`  
**And** `src/main.ts` is the only composition root and the only place that reads `process.env`

**Given** a missing or invalid config value  
**When** the app starts  
**Then** it exits with an error that names the value and never prints a secret

**Given** the test setup  
**When** the integration test boots the app with in-memory fakes of all four ports and `fake-rpc`  
**Then** it passes with no network and no database  
**And** each port has an in-memory fake in `apps/facilitator`  
**And** logs are structured, one event per line, and never contain secrets or full XDR  
**And** requests have a body size limit

### Story 1.2: Signer-pool prerequisites and the `@x402` 2.28 upgrade

**Lane:** Payments · **Lore task:** 0016 · **Covers:** FR8, FR10; NFR2 (AD-14, AD-16, AD-22)

As a facilitator operator,
I want the pool to await `onSigned` and respect a `maxLedger` bound, and the workspace on one `@x402` version,
So that settlement hashes are stored before anything is sent and no transaction outlives its authorization.

**Acceptance Criteria:**

**Given** an `onSigned` hook that returns a promise  
**When** the submitter sends or rebuilds a transaction  
**Then** it awaits `onSigned` first  
**And** a rejected `onSigned` sends nothing, frees the channel and returns a typed error

**Given** a `maxLedger` submit option  
**When** the transaction is built  
**Then** its ledger bound never goes past `maxLedger`  
**And** a call that can't fit is refused before signing

**Given** the recorded protocol-29 XDR fixture (`AddressV2` credentials, fee bumps, `LedgerCloseMeta` v2)  
**When** the fixture test runs  
**Then** SDK 16.x parses it

**Given** every workspace `package.json`  
**When** dependencies are installed  
**Then** all `@x402/*` packages resolve to one `~2.28.0` version and `@stellar/stellar-sdk` stays on `^16.3.0`  
**And** existing signer-pool tests still pass, and any changed test is documented

### Story 1.3: Verify `exact` payments

**Lane:** Payments · **Lore task:** 0018 · **Covers:** FR1, FR5, FR7, FR8 (AD-3, AD-5, AD-10, AD-22)

As a resource server,
I want `POST /verify` to check an `exact` payment the way the Stellar spec requires,
So that I only serve resources for payments that can settle.

**Acceptance Criteria:**

**Given** a valid `exact` payload on `stellar:testnet`  
**When** `/verify` is called  
**Then** it returns 200 with `{isValid: true, payer}`, using upstream `ExactStellarScheme.verify()`  
**And** we never re-implement upstream's signature, scope, simulation or event checks

**Given** a payload where a channel account appears as the transaction source, an operation source, `from`, or the address of any auth entry (`Address` or `AddressV2`)  
**When** `/verify` is called  
**Then** it returns `isValid: false` with a reason (AD-5)

**Given** a payload whose auth expires fewer than `minValidityLedgers` ledgers ahead  
**When** `/verify` is called  
**Then** it returns `isValid: false` with a reason (AD-22)

**Given** a malformed request body  
**When** `/verify` is called  
**Then** it returns 400, and an unexpected error returns 500

**Given** the fee configuration  
**When** the app wires `ExactStellarScheme` and the pool  
**Then** one `maxFeeStroops` and one `inclusionFeeStroops` value feed both, and the client's fee is never used (AD-10)

### Story 1.4: Settle `exact` payments once through the channel pool

**Lane:** Payments · **Lore task:** 0009 · **Covers:** FR2, FR6, FR9 (AD-2, AD-3, AD-6)

As a resource server,
I want `POST /settle` to settle a verified `exact` payment exactly once, through the channel pool,
So that I get a transaction hash for every paid request and a buyer is never charged twice.

**Acceptance Criteria:**

**Given** a valid payload  
**When** `/settle` is called  
**Then** it reruns the 1.3 checks, claims `network:payer:nonce`, submits `{func, auth}` through `SettlementSubmitter` with the deadline from the signature expiry and `maxLedger`, and returns `{success: true, transaction, network, payer}`  
**And** upstream `settle()` is never called and nothing else in the service calls `sendTransaction`

**Given** several concurrent `/settle` calls for one settlement key  
**When** they run  
**Then** exactly one transaction is submitted

**Given** a repeat call with the same fingerprint  
**When** `/settle` is called again  
**Then** it returns the stored outcome, waiting within the settle timeout if the record is pending

**Given** a repeat call with a different fingerprint  
**When** `/settle` is called  
**Then** it returns `success: false`, submits nothing and never returns the stored outcome  
**And** a payload with zero or several payer auth entries is rejected

**Given** a submission that is still pending at the settle timeout  
**When** `/settle` answers  
**Then** it returns `{success: false, errorReason: "settlement_pending", transaction, network}`  
**And** every `SubmitStatus` and submitter error class maps to a fixed `errorReason`, listed with the code

**Given** the hooks from 1.1  
**When** a settlement runs  
**Then** the before-submit hook runs before `submit()` and the on-success hook runs when the record turns `success`

### Story 1.5: Settlement records survive restarts

**Lane:** Payments · **Lore task:** 0019 · **Covers:** FR10 (AD-16)

As a facilitator operator,
I want settlement records that are written before sending, only move forward, and are reconciled at startup,
So that a crash or restart never loses a payment that may still land and never charges a buyer twice.

**Acceptance Criteria:**

**Given** a claimed settlement  
**When** the pool signs its transaction  
**Then** the hash is written to `SettlementStore` through the awaited `onSigned` before the first send  
**And** if the write fails, nothing is sent

**Given** a rebuild that produces a new hash  
**When** it is signed  
**Then** the record keeps every hash and can be found by any of them

**Given** a write that would move a record backwards, such as `pending` after `success`  
**When** it arrives late  
**Then** the compare-and-set drops it  
**And** states only move `claimed → signed → pending → success | failed | rejected | expired`

**Given** non-final records in the store  
**When** the app starts  
**Then** before accepting traffic it checks each one on chain by its hashes and finalizes it  
**And** a record that turns `success` this way fires the on-success hook

**Given** any handler or event listener  
**When** it needs to change a record  
**Then** it calls the single settlement module, which owns every write to `SettlementStore`

### Story 1.6: `/supported` and startup channel checks

**Lane:** Platform · **Lore task:** 0020 · **Covers:** FR3 (AD-12, AD-13); NFR4

As a resource server, and as the operator,
I want `GET /supported` to describe exactly what the facilitator does, and the service to refuse channels another key could move,
So that clients aren't misled and our channel accounts stay under the facilitator key's sole control.

**Acceptance Criteria:**

**Given** the running facilitator  
**When** `GET /supported` is called  
**Then** it lists `exact` on `stellar:testnet` with `extra.areFeesSponsored: true`, the `bazaar` extension, and the facilitator key's address as the only signer  
**And** channel addresses never appear, and `upto` is not listed

**Given** `FACILITATOR_SECRET` and `CHANNELS` (addresses only) in config  
**When** the service starts  
**Then** it checks every channel with `checkChannel`: master key weight 0 and the facilitator key as the only signer  
**And** if any channel fails, the service refuses to start and names the channel

**Given** the deploy env examples  
**When** they are updated  
**Then** `deploy/testnet.env.example` and `deploy/mainnet.env.example` use `FACILITATOR_SECRET` and `CHANNELS` instead of `FACILITATOR_SIGNER_SECRETS` and `FEE_BUMP_SIGNER_SECRET`  
**And** the facilitator key reaches the pool only as a `TransactionSigner`

### Story 1.7: Testnet token matrix

**Lane:** Payments · **Lore task:** 0021 · **Covers:** FR4 (AD-9); NFR6, NFR8

As a seller pricing in any SEP-41 token,
I want evidence that verify and settle work for every kind of token,
So that I can charge in my own token, not only USDC.

**Acceptance Criteria:**

**Given** testnet USDC, a self-issued SAC and a non-SAC SEP-41 token  
**When** a scripted run verifies and settles a payment in each through the facilitator on testnet  
**Then** every payment settles and the buyer pays no XLM fee  
**And** there is no per-token code path and no asset allowlist

**Given** a batch of concurrent payments  
**When** the run settles them across several channels  
**Then** more than one settles in the same ledger

**Given** the run's output  
**When** it finishes  
**Then** the results, with every transaction hash, are committed to the repo

## Epic 2: Operators can run the facilitator publicly on testnet without being drained

The facilitator runs at a public testnet URL on durable stores, with one process per channel set, rate limits, spend budgets, circuit breakers and alerts.

Two research tasks feed this epic and are not stories: **0013** chooses the state store (Discovery) and **0014** chooses hosting, logging, metrics and alerting (Platform). Each ends in an ADR.

### Story 2.1: Durable adapters for the four store ports

**Lane:** Discovery · **Lore task:** 0022 · **Covers:** FR10, FR11, FR13, FR15 (AD-7)

As a facilitator operator,
I want durable implementations of the four store ports,
So that settlements, catalog entries, rate limits and budgets survive restarts and deploys.

**Acceptance Criteria:**

**Given** the store chosen in the 0013 ADR  
**When** the adapters are built  
**Then** `SettlementStore`, `CatalogStore`, `RateLimitStore` and `SpendStore` each have an adapter in `apps/facilitator/src/adapters/` that passes the same contract tests as its in-memory fake

**Given** concurrent claims for one settlement key  
**When** they hit the store  
**Then** exactly one wins  
**And** lookup by any hash, forward-only compare-and-set, the exclusive renewable channel lease, catalog upserts by key and the `resources` filters are all supported

**Given** a fresh environment  
**When** migrations run  
**Then** the schema is created with one command  
**And** the composition root picks the memory or the real stores from config

### Story 2.2: Rate limiting and HTTP hardening

**Lane:** Platform · **Lore task:** 0023 · **Covers:** FR12 (AD-11); NFR5

As a facilitator operator,
I want per-route rate limits and basic HTTP hardening,
So that one caller can't exhaust the channel pool or the service.

**Acceptance Criteria:**

**Given** separate budgets for `/verify`, `/settle` and `/discovery/*`  
**When** a client exceeds one  
**Then** it gets HTTP 429 on that route only  
**And** counters go through `RateLimitStore`

**Given** a request with a forged `X-Forwarded-For`  
**When** the limiter keys it  
**Then** the client IP comes only from the configured trusted proxy hops

**Given** a request with an API key  
**When** the limiter keys it  
**Then** the key is used instead of the IP  
**And** requests without a key still work, so the gate proxy can call keyless

**Given** the HTTP layer  
**When** requests arrive  
**Then** bodies over the size limit are refused and `/verify` and `/settle` send no CORS headers

**Given** the facilitator docs  
**When** this story is done  
**Then** caller authentication and the rate limits are documented

### Story 2.3: Spend budgets and circuit breakers

**Lane:** Platform · **Lore task:** 0024 · **Covers:** FR13 (AD-18)

As a facilitator operator,
I want fee spending capped and failing assets or recipients cut off,
So that nobody can drain the facilitator's XLM with valid self-payments or junk tokens.

**Acceptance Criteria:**

**Given** a global rolling fee budget and per-payer, per-`payTo` and per-asset budgets  
**When** the before-submit hook runs  
**Then** it reserves the fee against all of them  
**And** over any budget, `/settle` returns `success: false` and submits nothing

**Given** a settlement outcome  
**When** it is final  
**Then** the reservation is settled at the fee actually paid or released

**Given** repeated on-chain failures for one asset or one `payTo`  
**When** the threshold is reached  
**Then** that breaker opens and settlements for it are refused until it resets

**Given** a budget nearing its limit or a breaker opening  
**When** it happens  
**Then** an event is emitted for the alerts in 0027  
**And** state goes through `SpendStore`, and the numeric limits are in config and recorded in this task

### Story 2.4: Channel lease and graceful shutdown

**Lane:** Payments · **Lore task:** 0025 · **Covers:** FR11 (AD-17); NFR9

As a facilitator operator,
I want only one process at a time to settle through a network's channel set,
So that a deploy or a second instance never collides on channel sequence numbers.

**Acceptance Criteria:**

**Given** a process starting  
**When** it boots  
**Then** it takes an exclusive lease on its network's channel set through the store and keeps renewing it  
**And** without the lease it doesn't serve `/settle`

**Given** a second process for the same channel set  
**When** it starts  
**Then** it can't take the lease and submits nothing

**Given** a shutdown signal  
**When** the process stops  
**Then** it refuses new `/settle` calls, waits until every in-flight submission is final or recorded as pending, then releases the lease

**Given** a process that dies without releasing  
**When** the lease TTL passes  
**Then** a new process can take the lease

### Story 2.5: Public testnet deployment

**Lane:** Platform · **Lore task:** 0026 · **Covers:** FR21 prerequisite; NFR4, NFR9

As a anyone integrating with or testing the facilitator, including the gate,
I want the facilitator at a public HTTPS testnet URL,
So that the e2e proxy and real resource servers can reach it.

**Acceptance Criteria:**

**Given** the platform chosen in the 0014 ADR  
**When** a deploy runs  
**Then** a container image built from the repo is deployed to it as the ADR describes, and the service answers `/supported` at a public HTTPS URL

**Given** a running instance  
**When** a new version is deployed  
**Then** the old process stops before the new one starts  
**And** the process is long-lived and never scaled to zero

**Given** the facilitator key  
**When** the service is deployed  
**Then** it comes from the platform's secret store, never from the image or the logs, and is a testnet-only key

**Given** the durable stores from 0022  
**When** the service runs  
**Then** it uses them, and `docs/runbook.md` has the deploy and rollback steps

### Story 2.6: Alerts and metrics

**Lane:** Platform · **Lore task:** 0027 · **Covers:** FR14 (AD-18); NFR7

As a facilitator operator,
I want metrics and alerts for anything that costs money or can lose a payment,
So that I hear about problems before users do.

**Acceptance Criteria:**

**Given** the running facilitator  
**When** it serves traffic  
**Then** pool `onEvent` events, per-route request counts and settle outcomes are exported as metrics

**Given** each alert condition: budget nearly used, breaker open, low facilitator balance (`checkFacilitatorBalance`), quarantined channel, pending settlements  
**When** it occurs  
**Then** an alert fires on the backend chosen in 0014  
**And** each alert has been triggered once on testnet or with a fake

**Given** `docs/monitoring.md`  
**When** this story is done  
**Then** it lists every metric and alert

## Epic 3: The x402 ecosystem can see that our facilitator conforms (the T1 gate)

An unmodified canonical client from the x402 e2e suite completes `exact` verify → settle against our testnet facilitator through our external proxy, and the results with transaction hashes are committed.

### Story 3.1: Gate harness: external proxy and runner

**Lane:** Platform · **Lore task:** 0028 · **Covers:** FR21 (AD-15)

As a reviewer of the grant,
I want a reproducible way to run the unmodified x402 e2e suite against our facilitator,
So that conformance is shown by evidence, not claimed.

**Acceptance Criteria:**

**Given** `conformance/external-proxy/`  
**When** it is built  
**Then** it has a `test.config.json` (`name`, `type: facilitator`, `language: typescript`, `protocolFamilies: [stellar]`, `schemes: [exact]`, `x402Versions: [2]`, and `environment.required` naming our facilitator-URL variable) and a `run.sh` that listens on `PORT`, prints `Facilitator listening`, answers `GET /health` and `POST /close`, and forwards `/verify`, `/settle` and `/supported`

**Given** a conformance script  
**When** it runs  
**Then** it clones `x402-foundation/x402` read-only at a pinned commit, copies in only our proxy folder and runs the Stellar `exact` scenarios with `--output-json`  
**And** nothing else in the clone is changed and nothing is pushed upstream

**Given** the proxy pointed at the public Stellar facilitator  
**When** the harness runs  
**Then** it completes end to end, which proves the harness before our facilitator is ready

**Given** the `/exact/stellar/upfront` scenario  
**When** this story is done  
**Then** what it requires from a Stellar facilitator is answered and written down

### Story 3.2: Gate run against our testnet facilitator

**Lane:** Platform · **Lore task:** 0029 · **Covers:** FR21 (AD-13, AD-15)

As a reviewer of the grant,
I want e2e results with real settled transaction hashes committed to the repo,
So that the T1 exit criterion is met and can be checked by anyone.

**Acceptance Criteria:**

**Given** our facilitator deployed at its public URL (0026)  
**When** the gate runs  
**Then** the canonical client completes `exact` verify → settle for each Stellar scenario and every run records a real transaction hash

**Given** a finished run  
**When** results are saved  
**Then** `conformance/results/` gets the run JSON with the upstream commit, the date, our facilitator version and the transaction hashes

**Given** a failing scenario  
**When** it is analysed  
**Then** a backlog task is created for the owning lane

**Given** the finished T1 build, including Bazaar and spend budgets  
**When** the gate reruns  
**Then** it passes and the final results are committed

## Epic 4: Agents can discover paid resources in the Stellar Bazaar

Successful settlements that carry `extensions.bazaar` are validated and cataloged without affecting the payment, and anyone can list them through `GET /discovery/resources`.

### Story 4.1: Bazaar validator and normalizer

**Lane:** Discovery · **Lore task:** 0030 · **Covers:** FR16 (AD-19)

As a agent looking for paid services,
I want only well-formed, safe listings to reach the catalog,
So that I can trust what discovery returns.

**Acceptance Criteria:**

**Given** an `extensions.bazaar` block with an `http` or `mcp` input type  
**When** it is validated  
**Then** a valid block becomes a normalized entry typed with `@x402/extensions`

**Given** a malformed required field  
**When** it is validated  
**Then** the listing is rejected with a reason  
**And** a malformed optional field (`serviceName`, `tags`, `iconUrl`) is dropped and the listing kept

**Given** an `iconUrl`  
**When** it is validated  
**Then** it is kept only if it is absolute https with no IP literal and no loopback or private host

**Given** calls to `/users/42` and `/users/7` with `routeTemplate` `/users/:userId`  
**When** their catalog keys are computed  
**Then** both produce one key: `network + payTo + method + normalized URL`  
**And** `packages/bazaar` does no I/O and reads no env, and is fully unit-tested

### Story 4.2: Catalog resources after successful settlements

**Lane:** Discovery · **Lore task:** 0031 · **Covers:** FR15, FR17 (AD-8, AD-19)

As a seller,
I want my resource listed automatically after a buyer pays for it,
So that I don't need a separate registration step.

**Acceptance Criteria:**

**Given** a settlement whose record turns `success`, immediately or later through a resolved event, with `extensions.bazaar` in the payload  
**When** the on-success hook fires  
**Then** the entry is upserted into `CatalogStore` after the response is sent  
**And** upserts are idempotent and update `lastUpdated`

**Given** a payload without `extensions.bazaar`, a settlement that didn't succeed, or a payment that was only verified  
**When** it is processed  
**Then** nothing is cataloged

**Given** a settlement with `extensions.bazaar`  
**When** `/settle` responds  
**Then** the synchronous validation result is in a base64 JSON `EXTENSION-RESPONSES` header with status `processing` or `rejected`  
**And** the body and status of the settle response never change

**Given** a `CatalogStore` failure  
**When** the upsert runs  
**Then** the settle response is unaffected and the error is logged and counted  
**And** the facilitator never fetches a seller-supplied URL

### Story 4.3: List resources in `/discovery/resources`

**Lane:** Discovery · **Lore task:** 0032 · **Covers:** FR18 (AD-20)

As a agent,
I want to list catalog resources with the standard discovery filters,
So that I can find Stellar services with the same client I use for other x402 facilitators.

**Acceptance Criteria:**

**Given** cataloged entries  
**When** `GET /discovery/resources` is called  
**Then** the response uses the upstream discovery list types, with each resource's `accepts` terms, `extensions.bazaar.info` and `lastUpdated`

**Given** the `type`, `payTo`, `network`, `extensions`, `limit` and `offset` filters  
**When** they are used alone or combined  
**Then** only matching entries are returned

**Given** no `limit`, or a `limit` above the maximum  
**When** the endpoint is called  
**Then** the fixed default applies, or the value is clamped to the maximum  
**And** results come in a stable order with no ranking

## Epic 5: Sellers of metered services get a working `upto` prototype on testnet

`UptoProxy` is deployed on testnet with on-chain end-to-end tests through the signer pool, and the design is documented for reviewers, the facilitator team and the future `scheme_upto_stellar.md` author.

### Story 5.1: Deploy `UptoProxy` to testnet and run on-chain e2e tests

**Lane:** Payments · **Lore task:** 0004 · **Covers:** FR19 (AD-2, AD-4)

As a seller of a metered service,
I want the `upto` contract live on testnet and proven by on-chain tests through the signer pool,
So that I can see that authorize-a-ceiling, settle-the-actual-amount works for real.

**Acceptance Criteria:**

**Given** the `UptoProxy` WASM  
**When** the deploy script runs  
**Then** the contract is on testnet and its ID and WASM hash are recorded

**Given** the scenario list in 0004 (below, at and zero amounts; over-ceiling, replay, too early, expired, wrong facilitator; tampering; concurrency; three token kinds)  
**When** the suite runs on chain through `SettlementSubmitter` in the delegated-bump shape  
**Then** every scenario has the expected outcome  
**And** the client account never pays a fee

**Given** a finished run  
**When** results are written  
**Then** the results file lists every transaction hash  
**And** the suite reruns from a clean testnet state with one command

### Story 5.2: Document `UptoProxy`: design ADR, contract docs, threat model and testnet report

**Lane:** Payments · **Lore task:** 0005 · **Covers:** FR20

As a reviewer, facilitator developer or future `scheme_upto_stellar.md` author,
I want the `upto` design written down,
So that I can use and review it without reading the contract code.

**Acceptance Criteria:**

**Given** the results of 0002–0004  
**When** the docs are written  
**Then** the design ADR, the contract README, the threat-model section and the testnet report exist

**Given** the testnet report  
**When** it is checked  
**Then** every transaction hash resolves on stellar.expert and the report includes the 0006 throughput numbers and the one-payment-per-transaction limit  
**And** `format:check` passes
