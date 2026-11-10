---
margin:
  x: 1.5cm
  y: 1.5cm
---

# Stellar x402 Facilitator with Bazaar — Milestone 1 Deliverable Evidence

> - **Project:** x402 Facilitator with Bazaar discovery support for Stellar (SCF RFP track,
>   RFP 7)
> - **Team:** Rumble Fish
> - **Milestone:** 1 (Tranche 1) — testnet facilitator, channel-account pool, Bazaar foundation,
>   `upto` design and prototype, conformance gate
>
> This document is the written companion to the Milestone 1 submission video. It maps every
> Tranche 1 deliverable to evidence a reviewer can check: commands against the live testnet
> service, their output, settled transaction hashes, screenshots and code references.
>
> It also states what Milestone 1 deliberately does not claim (mainnet, search, the MCP server and
> the rest of the later tranches), so that nothing here is read as more than it is.

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Deliverable definition](#2-deliverable-definition)
3. [Architecture](#3-architecture)
4. [Scope against the RFP and the proposal](#4-scope-against-the-rfp-and-the-proposal)
5. [Deliverable evidence](#5-deliverable-evidence)
6. [The production service behind the testnet deployment](#6-the-production-service-behind-the-testnet-deployment)
7. [What is deliberately not claimed](#7-what-is-deliberately-not-claimed)
8. [Live endpoints and access](#8-live-endpoints-and-access)
9. [Repository navigation](#9-repository-navigation)

## 1. Executive summary

Milestone 1 — the testnet foundation of the facilitator and its Bazaar — is complete and running
on `stellar:testnet` at `https://x402-facilitator.sorobanscan.com`. Every Tranche #1 line item is
delivered as approved; none was dropped or moved.

The facilitator serves `/verify`, `/settle` and `/supported` per the x402 v2 spec, built on the
Apache-2.0 `@x402/stellar` package, for any SEP-41 token. It sponsors network fees, so a buyer
holds only the payment asset, and it limits requests per client IP and fee spending by rolling
budgets. Every settlement goes through a pool of channel accounts, reimplemented under
Apache-2.0, so concurrent payments don't wait on one account's sequence number. The Bazaar's
`GET /discovery/resources` lists resources cataloged automatically when a payment carrying the
`bazaar` extension settles. The `upto` scheme's design is final, its proxy contract runs on
testnet, and its specification is already proposed upstream.

The Tranche #1 conformance bar is met. In the run of record (2026-11-06), the x402 Foundation's
own end-to-end suite, unmodified, completed 18 of 18 `exact` payments against our public
facilitator through the suite's external facilitator proxy, and the gate recorded and checked
18 settled testnet transactions.

`<TODO: replace the run of record with the final rerun on the finished Tranche 1 build (task 0029), and update every number in this section.>`

The dependency tree's licenses were re-audited at this tranche boundary: no AGPL, GPL, SSPL or
LGPL-only dependency in 291 npm packages and 239 Rust crates
([`milestone-1-license-audit.md`](./milestone-1-license-audit.md)).

Tranche #1 is testnet only. Mainnet, search and ranking, the MCP server, SDK helpers and `upto` in
`/settle` are later tranches of the approved plan ([section 4](#4-scope-against-the-rfp-and-the-proposal));
[section 7](#7-what-is-deliberately-not-claimed) states plainly what is not claimed.

## 2. Deliverable definition

Quoted from our response to the Panel Review (feedback of 2026-09-16): the Tranche #1 line items
of its budget (§1), and the conformance bar it sets for Tranche #1 sign-off (§4).

> **Tranche #1 (Milestone 1)**
>
> - Facilitator hardening on testnet (verify/settle/supported, any SEP-41 token, sponsored fees,
>   rate limiting)
> - Channel-account pool, permissively-licensed reimplementation (sequence-number throughput —
>   see §5)
> - **Bazaar discovery layer, foundation** (`resources` endpoint + cataloging pipeline, no ranking
>   yet)
> - `upto` scheme design finalization + testnet proxy-contract prototype
>
> **Tranche #1 conformance bar:** **an unmodified canonical client from the `x402-foundation/x402`
> reference repo's own end-to-end test suite** completes verify → settle against our testnet
> facilitator for the `exact` scheme, at the wire level, with a **real settled transaction hash**
> produced and recorded — not a client we've adapted or reimplemented ourselves.

The same response commits to re-auditing the full dependency tree's licenses at each tranche
boundary (§5). Acceptance criteria per line item are in the Tranche 1 stories of
[`docs/planning/m1-epics.md`](../planning/m1-epics.md); the architecture they build against is
[`docs/architecture/m1-spine.md`](../architecture/m1-spine.md).

| #   | Deliverable                      | RFP 7                                                                     | Proposal           | Evidence                                               |
| --- | -------------------------------- | ------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| D1  | Facilitator hardening on testnet | Facilitator: verify/settle/supported, SEP-41, sponsored fees, rate limits | §3.1, §3.1.1, §3.2 | [5.1](#51-d1--hardened-facilitator-on-testnet)         |
| D2  | Channel-account pool             | Stellar-specific: channel accounts for sequence bottlenecks               | §3.3               | [5.2](#52-d2--channel-account-pool-in-the-settle-path) |
| D3  | Bazaar foundation                | `GET /discovery/resources` with filters, automatic cataloging             | §4.1, §4.2, §4.4   | [5.3](#53-d3--bazaar-foundation)                       |
| D4  | `upto` design and prototype      | Settlement schemes: `upto`, `scheme_upto_stellar.md`                      | §6.1–§6.3          | [5.4](#54-d4--upto-final-design-and-testnet-prototype) |
| D5  | Conformance bar                  | Conformance at wire level with unmodified canonical clients               | §9                 | [5.5](#55-d5--conformance-gate)                        |

## 3. Architecture

![Architecture](./architecture.png){height=20cm}

- **One facilitator service** (`apps/facilitator`) serves `/verify`, `/settle`, `/supported` and
  `/discovery/resources`, as the proposal's §2 has it. It builds on the Apache-2.0
  `@x402/stellar` for verify and settle, as the RFP asks, and adds the checks of
  [ADR 0004](../adr/0004-facilitator-shape.md).
- **Settlement** goes through a pool of channel accounts (`packages/signer-pool`), each
  transaction fee-bumped by the facilitator's fee account, so the buyer pays no XLM.
- **The facilitator key** is held in OpenBao Transit on the server and reached over a unix
  socket; the raw key never enters the facilitator's process
  ([ADR 0013](../adr/0013-facilitator-key-custody.md)).
- **State** — settlement records, the channel lease, spend budgets, the catalog — is in Postgres
  ([ADR 0012](../adr/0012-facilitator-state-store.md)).
- **Hosting:** a Hetzner server with Docker Compose behind a Cloudflare tunnel, deployed by digest
  from CI ([ADR 0011](../adr/0011-facilitator-hosting.md)). Logs, metrics and alarms go to
  CloudWatch, alarms to the team's Slack channel ([`docs/monitoring.md`](../monitoring.md)).

## 4. Scope against the RFP and the proposal

The RFP's full scope spans the grant; Tranche #1 is its testnet foundation. The rest is allocated
to later tranches in the Panel Review response's budget (§1), and Tranche #1 delivers no less
than its line items:

| RFP / proposal item                                                         | Tranche (Panel Review response §1)                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Bazaar search + ranking engine, its nDCG@10 evaluation                      | #2                                                                                                              |
| MCP discovery server (search + paid-call tools)                             | #2                                                                                                              |
| `scheme_upto_stellar.md` finalized and submitted to the TSC; upstream merge | #2, #3 — submitted early: [x402-foundation/x402#3781](https://github.com/x402-foundation/x402/pull/3781) (open) |
| SDK helpers (TypeScript, Rust seller crate)                                 | #2, #3                                                                                                          |
| Security audit engagement and remediation (audit via SCF Audit Bank)        | #2, #3                                                                                                          |
| Conformance test suite and report                                           | #3 — the Tranche #1 bar (D5) is met now                                                                         |
| Example integrations                                                        | #3                                                                                                              |
| Production readiness: runbook, monitoring, mainnet launch                   | #3 — runbook and monitoring already run the testnet service (section 6)                                         |

## 5. Deliverable evidence

Every command below runs against the public testnet service as written; none needs a key.

```bash
export FAC=https://x402-facilitator.sorobanscan.com
```

### 5.1 D1 — Hardened facilitator on testnet

**Claimed:** `/verify`, `/settle` and `/supported` per the x402 v2 spec on `stellar:testnet`,
for any SEP-41 token, with network fees sponsored by the facilitator and per-IP rate limits.

**The service answers, with fees sponsored:**

```bash
curl -s $FAC/supported | jq
```

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "stellar:testnet",
      "extra": { "areFeesSponsored": true }
    }
  ],
  "extensions": ["bazaar"],
  "signers": { "stellar:*": ["GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP"] }
}
```

```bash
curl -s $FAC/health | jq
```

```json
{
  "ready": true,
  "signer": "ok",
  "listed": true,
  "commit": "68e778e36af4713f2d193aa781ba89ca6a72fc95"
}
```

`<TODO: rerun both after the final deploy and paste the output; the commit must match the gate rerun's.>`

**Any SEP-41 token, the buyer paying no XLM.** The token matrix settles one payment each in Circle
testnet USDC, a Stellar Asset Contract and a plain SEP-41 (wasm) token, then a batch of six across
several channels:
[`apps/facilitator/test/live/results/token-matrix-testnet.json`](../../apps/facilitator/test/live/results/token-matrix-testnet.json).
Its checks: `everyTokenSettled`, `facilitatorPaidEveryFee`, `buyerPaidNoXlm`,
`buyerSourcedNothing`, `batchSettled`, `batchUsedSeveralChannels` — all `true`.

`<TODO: the matrix of record ran on 2026-10-23 against a facilitator run by the script; rerun it against the deployed service and commit the result.>`

**Strict auth-entry validation** (proposal §3.1.1, Panel Review response §5). `/verify` runs
upstream's `verify()`, which protects the facilitator's own address, then refuses source-account
credentials and any payload where a channel address appears as the transaction or operation
source, `from`, or an auth entry's address, for both `Address` and `AddressV2` (CAP-71)
credentials, in `/verify` and again in `/settle`
([ADR 0005](../adr/0005-channel-accounts-as-facilitator-source.md), the non-custodial guarantee).
It also requires exactly one auth entry for the payer, and a validity window between a minimum and
`MAX_VALIDITY_LEDGERS` (66 ledgers by default), with an upstream error answered as a 500 rather
than a verdict ([spine AD-3](../architecture/m1-spine.md)). A smart-wallet (C-address) payer
settles through the network's own authorization flow (`cAccountSettled` in the spend matrix).

The test of each check (permalinks to `develop` at `da93723a`):

| Check                                                                            | Test                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The facilitator's own (muxed) address anywhere in the payload is refused         | [`verify.test.ts:387`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L387)                                                                                                                                                                            |
| A source-account auth entry is refused, even when upstream accepts it            | [`verify.test.ts:240`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L240)                                                                                                                                                                            |
| A channel as the transaction source                                              | [`verify.test.ts:342`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L342)                                                                                                                                                                            |
| A channel as the operation source                                                | [`verify.test.ts:357`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L357)                                                                                                                                                                            |
| A channel as `from`                                                              | [`verify.test.ts:364`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L364)                                                                                                                                                                            |
| A channel as an auth entry's address, with `Address` and `AddressV2` credentials | [`verify.test.ts:372`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L372)                                                                                                                                                                            |
| The checks run again in `/settle`, which answers a failed one without claiming   | [`settle.test.ts:699`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/settle.test.ts#L699)                                                                                                                                                                            |
| Exactly one auth entry, the payer's                                              | [`verify.test.ts:437`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L437)                                                                                                                                                                            |
| The minimum validity, with `Address` and `AddressV2` credentials                 | [`verify.test.ts:496`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L496)                                                                                                                                                                            |
| The maximum validity (`MAX_VALIDITY_LEDGERS`), with `Address` and `AddressV2`    | [`verify.test.ts:509`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L509)                                                                                                                                                                            |
| An error inside upstream is ours, answered 500, not a verdict                    | [`verify.test.ts:149`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L149), [`verify-route.test.ts:235`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify-route.test.ts#L235) |

**CAP-71 `AddressV2` credentials are accepted.** Both validity tests above accept a payment at the
exact bound with `AddressV2` credentials as with `Address` ones. On testnet, the channel pool
settled a payment whose client auth entry is `AddressV2`:
[`b597301aceaceb40…`](https://stellar.expert/explorer/testnet/tx/b597301aceaceb406760fbc54dbcf25007bbb0083af5b71afe0b5a42f7647052)
(ledger 5054851, 2026-10-06, successful), kept as a fixture the tests parse
([`packages/signer-pool/test/xdr-fixture.test.ts`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/packages/signer-pool/test/xdr-fixture.test.ts#L39)).
The canonical client in the gate (5.5) still signs `Address` credentials: 18 of 18.

**Fee abuse containment and rate limits.** Requests are limited per client IP: 600 a minute on
`/verify` and on `/settle`, 120 on `/discovery/*` (defaults in
[`apps/facilitator/src/config.ts`](../../apps/facilitator/src/config.ts)). Fee spending is capped
by rolling budgets (global, per payer, per `payTo`, per asset) and parties whose settlements keep
failing on chain are cut off by breakers
([ADR 0007](../adr/0007-fee-abuse-containment.md)); the testnet run:
[`spend-matrix-testnet.json`](../../apps/facilitator/test/live/results/spend-matrix-testnet.json).

**Missing trustline** (Panel Review response §5, task 0078). When upstream's simulation fails, the
facilitator looks for the reason, and a missing trustline is answered by name before anything is
sent: `invalid_exact_stellar_payer_trustline_missing` or
`invalid_exact_stellar_payto_trustline_missing`, with a message saying which account lacks the
trustline to which asset and what to do. Tests:
[`verify.test.ts:175`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify.test.ts#L175)
(the reason replaces upstream's `simulation_failed`),
[`trustline.test.ts:140`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/trustline.test.ts#L140)
(the seller's missing trustline, named with what the seller must do),
[`trustline.test.ts:149`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/trustline.test.ts#L149)
(the payer's),
[`verify-route.test.ts:105`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/verify-route.test.ts#L105)
(the route logs its message). The buyer-side SDK step the response also describes is a later
tranche (SDK helpers).

### 5.2 D2 — Channel-account pool in the settle path

**Claimed:** `/settle` submits through a pool of channel accounts, a permissive reimplementation
under Apache-2.0, so concurrent settlements don't wait on one account's sequence number.

- Design: [ADR 0003](../adr/0003-settlement-channel-account-pool.md) and
  [ADR 0005](../adr/0005-channel-accounts-as-facilitator-source.md); the code:
  [`packages/signer-pool`](../../packages/signer-pool/).
- In every gate settlement (5.5) the transaction's source is a channel account and the fee bump's
  source is the fee account `GAVE5V5I…KKRP`.
- The token matrix's batch put six settlements on several channels in one ledger
  (`batchUsedSeveralChannels`, `batchSharedALedgerAcrossChannels`).
- One process at a time holds the channel set: a lease with a fencing token, released on a
  graceful shutdown (tasks 0025, 0071).
- The service refuses to start unless every channel's master key weight is 0 and the
  facilitator key is its only signer (ADR 0005).

`<TODO: one gate transaction opened on stellar.expert, screenshot: the channel as source, the fee bump paid by the fee account.>`

**Licensing.** The repository and every package are Apache-2.0, with no AGPL dependency (the RFP's
non-functional requirement). The dependency tree was re-audited at this tranche boundary, as the
Panel Review response commits to (§5): 291 npm packages (159 shipped) and 239 Rust crates, none
under AGPL, GPL, SSPL or an LGPL-only license, and OpenZeppelin's AGPL `relayer-plugin-channels` in
neither tree. Commands and counts:
[`milestone-1-license-audit.md`](./milestone-1-license-audit.md).

### 5.3 D3 — Bazaar foundation

**Claimed:** `GET /discovery/resources` with the `type`, `payTo`, `network`, `extensions`,
`limit` and `offset` filters, and automatic cataloging of resources whose payment settles with the
`bazaar` extension.

```bash
curl -s "$FAC/discovery/resources?limit=5" | jq
```

The public catalog is empty today (`"items":[]`, `"total":0`): cataloging runs on the deployed
service, but no seller has yet settled a payment carrying the `bazaar` extension through it, and
listings come only from real settlements, with no registration step.

The pipeline, end to end on testnet, with
[`apps/facilitator/test/live/catalog-smoke.ts`](../../apps/facilitator/test/live/catalog-smoke.ts):
a facilitator built by `main()` (a local stand-in for OpenBao, and `CATALOG_LIST_LOCAL=true`
since the seller runs on the same machine), a seller whose `GET /weather` answers 402 with the
`bazaar` extension, a buyer paying with upstream's client, and an outsider calling `/settle`
itself. The run of 2026-11-09, 18:41–18:47 UTC:
[`catalog-smoke-testnet.json`](../../apps/facilitator/test/live/results/catalog-smoke-testnet.json).

| Step                                                                          | Transaction                                                                                                                                 | `EXTENSION-RESPONSES`, decoded       | Catalog                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| The buyer pays                                                                | [`fee64e4474c5442c…`](https://stellar.expert/explorer/testnet/tx/fee64e4474c5442c89fbd47a48837361f49bd60b2d473baa4973ff24da0ff12c), SUCCESS | `{"bazaar":{"status":"processing"}}` | The facilitator asks the seller with one unpaid request and lists what its 402 says: "Weather by city", 10000 stroops (`inserted`) |
| An outsider settles to the seller's `payTo` with its own copy, saying "Pwned" | [`8ef5f9f1188d76ad…`](https://stellar.expert/explorer/testnet/tx/8ef5f9f1188d76ad5d857d2e197c4306676bfed34caf3a8b6c015f4fd4b91175), SUCCESS | `{"bazaar":{"status":"processing"}}` | The seller is asked again; the listing keeps the seller's text and price (`updated`)                                               |

After each step, the facilitator's own `/discovery/resources` listed the entry. The run's other
three steps (a repeat payment, the outsider's settle in the same minute, a new price) were cut
short by the public testnet RPC, which answered in 7–9 s against the facilitator's 10 s budget:
one landed after `/settle` had answered `settlement_pending`, two failed at verify. The cataloger's
tests cover what those steps check
([`cataloger.test.ts:181`](https://github.com/rumblefishdev/stellar-x402/blob/da93723ae5ac9cecffd503def406fe4ad6b1d5c7/apps/facilitator/test/cataloger.test.ts#L181):
the seller is asked only when the copy differs, at most once a minute per key).

The pipeline, as the Panel Review response (§3) describes it:

- **On settle, never on verify**, and only when the payment carries the `bazaar` extension; no
  separate registration step (task 0031).
- **Validation and normalization** of the discovery metadata:
  [`packages/bazaar`](../../packages/bazaar/) (task 0030). Malformed optional fields are dropped
  rather than rejecting the listing (soft-drop); URLs are normalized, percent-encoding included
  ([`packages/bazaar/src/url.ts`](../../packages/bazaar/src/url.ts)), so two spellings of one route
  key one entry.
- **The outcome is reported** in the `EXTENSION-RESPONSES` header
  ([`apps/facilitator/src/http/extension-responses.ts`](../../apps/facilitator/src/http/extension-responses.ts)).
  Decoded from the smoke run's settle responses: `{"bazaar":{"status":"processing"}}`. Cataloging
  runs after the settle response, so the header says it has started, not how it ended.
- **The endpoint and its filters** (task 0032):
  [`apps/facilitator/src/http/discovery.ts`](../../apps/facilitator/src/http/discovery.ts).
- Catalog integrity: who may change a listing, field limits, listing from the seller's own 402
  ([ADR 0008](../adr/0008-bazaar-catalog-integrity.md), task 0063).

### 5.4 D4 — `upto`: final design and testnet prototype

**Claimed:** the final `upto` design for Stellar and a proxy contract deployed on testnet, with
its end-to-end tests.

- Design: [ADR 0010](../adr/0010-upto-proxy-design.md); threat model:
  [`docs/threat-model.md`](../threat-model.md).
- The contract: [`contracts/upto-proxy`](../../contracts/upto-proxy/), deployed at
  `CAL7SBTOECJ6HXXO3ST43LM2HJJFSZ3ZDEEZBIWHJPB7DRF5MXS5V2VC`.
- Testnet report: [`docs/upto-proxy-testnet-report.md`](../upto-proxy-testnet-report.md);
  the end-to-end run: 58 of 58 scenarios across Circle USDC, a Stellar Asset Contract and a
  plain SEP-41 token
  ([`contracts/upto-proxy/e2e/results/testnet-results.json`](../../contracts/upto-proxy/e2e/results/testnet-results.json)).
- The specification is proposed upstream:
  [x402-foundation/x402#3781](https://github.com/x402-foundation/x402/pull/3781) (open). Its merge
  and `upto` in `/settle` are later tranches.

### 5.5 D5 — Conformance gate

**Claimed:** the x402 Foundation's end-to-end suite, unmodified, completes `exact` verify → settle
against our testnet facilitator through an external facilitator proxy, and each settled
transaction hash is recorded.

- How the gate runs: [`conformance/README.md`](../../conformance/README.md),
  [ADR 0009](../adr/0009-conformance-gate-harness.md). The suite is the upstream repository at a
  pinned commit, cloned fresh; the gate adds only its proxy, in the folder upstream keeps for
  external facilitators, and stops if any tracked file differs from the pin.
- The gate fails unless every scenario passed with its own hash, and each hash, read back from
  Stellar RPC, succeeded as one `transfer` of 0.001 testnet USDC from the buyer to the seller, its
  fee paid by the facilitator's signer, in a ledger after the run started.
- The run of record: [`conformance/results/testnet-hosted/`](../../conformance/results/testnet-hosted/)
  — 2026-11-06, upstream `8827cf19`, facilitator `68e778e3`, 18 of 18 passed in 10.8 minutes,
  command `pnpm test --testnet --families=stellar --schemes=exact --facilitators=stellar-x402`.

| #   | Client                  | Server                    | Transaction                                                                                                                        | Ledger  |
| --- | ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `typescript/http/axios` | `typescript/http/express` | [`298beb5fb6ceeeb5…`](https://stellar.expert/explorer/testnet/tx/298beb5fb6ceeeb574398297ddf7a4b4833fbfc0c74cfbaf2a4d07593ed3e3ea) | 5589521 |
| 2   | `typescript/http/axios` | `typescript/http/express` | [`02f40c5607a49cf0…`](https://stellar.expert/explorer/testnet/tx/02f40c5607a49cf06877516a05f6ba28ae4d50451eebc416e3952463ffdec445) | 5589524 |
| 3   | `typescript/http/fetch` | `typescript/http/express` | [`0ae098a100e9f180…`](https://stellar.expert/explorer/testnet/tx/0ae098a100e9f18055b020e9f23478af7c43bac3d129883b1cee54b14588930a) | 5589528 |
| 4   | `typescript/http/fetch` | `typescript/http/express` | [`3b4cdbff91bd81ba…`](https://stellar.expert/explorer/testnet/tx/3b4cdbff91bd81ba96509dff6ea9e6010b1733d9cbdad749ca605443df74563d) | 5589532 |
| 5   | `typescript/http/axios` | `typescript/http/fastify` | [`79f930aa0adb187b…`](https://stellar.expert/explorer/testnet/tx/79f930aa0adb187b2064cabd6121d0dce790508d266982901610ea72beeebf84) | 5589543 |
| 6   | `typescript/http/axios` | `typescript/http/fastify` | [`7d4aa5b025e32628…`](https://stellar.expert/explorer/testnet/tx/7d4aa5b025e326287c8b5b1104a25c2ce608bf72f2260bd248acedacfa151f94) | 5589546 |
| 7   | `typescript/http/fetch` | `typescript/http/fastify` | [`2a68406d87d32d57…`](https://stellar.expert/explorer/testnet/tx/2a68406d87d32d57cebdbcde4473922f7983edc7e642268ef883916b44b7e196) | 5589549 |
| 8   | `typescript/http/fetch` | `typescript/http/fastify` | [`bb417d1a26d4b6b9…`](https://stellar.expert/explorer/testnet/tx/bb417d1a26d4b6b9cde1a6939a6bd6a57a68de09d12ecf6f510de1eed5555456) | 5589552 |
| 9   | `typescript/http/axios` | `typescript/http/hono`    | [`862f778befc9c0e5…`](https://stellar.expert/explorer/testnet/tx/862f778befc9c0e52fd1c17d6bef737b7c84d487cd46c67fee3ca6bf8f36d024) | 5589557 |
| 10  | `typescript/http/axios` | `typescript/http/hono`    | [`d6f6da7ba1ab7fd7…`](https://stellar.expert/explorer/testnet/tx/d6f6da7ba1ab7fd79dd99f94a5f4aa61014c1c440bac93d54dd71f7e5f625ace) | 5589567 |
| 11  | `typescript/http/fetch` | `typescript/http/hono`    | [`63edcd235e21ae5c…`](https://stellar.expert/explorer/testnet/tx/63edcd235e21ae5c8bda839ad8aa05529c0882437315cd8598cbda5e90edbaca) | 5589578 |
| 12  | `typescript/http/fetch` | `typescript/http/hono`    | [`9b86112e0f31cbf5…`](https://stellar.expert/explorer/testnet/tx/9b86112e0f31cbf5de2fbecd6d983f9e4af9f41ca26723540fe6d3eb680c2503) | 5589585 |
| 13  | `typescript/http/axios` | `typescript/http/next`    | [`efa1d8334bee2423…`](https://stellar.expert/explorer/testnet/tx/efa1d8334bee2423a8379cb3e41258578d33e872aeb927029388b4c7da542198) | 5589594 |
| 14  | `typescript/http/axios` | `typescript/http/next`    | [`fe20cc76dab566a9…`](https://stellar.expert/explorer/testnet/tx/fe20cc76dab566a9b5ac565fcbab7cbd6e8c17e6d3db89ee8e7a20e098449689) | 5589603 |
| 15  | `typescript/http/fetch` | `typescript/http/next`    | [`0d047b5fe6f60772…`](https://stellar.expert/explorer/testnet/tx/0d047b5fe6f607725d3607aa27a0ed426e3641baeb85ba368736950844df0209) | 5589610 |
| 16  | `typescript/http/fetch` | `typescript/http/next`    | [`c024ec6d7386be1f…`](https://stellar.expert/explorer/testnet/tx/c024ec6d7386be1f9f16b0f4752fb9963ecb70fa2dc140da56c563f9566f0c95) | 5589618 |
| 17  | `typescript/mcp`        | `typescript/mcp`          | [`a6752973224771f5…`](https://stellar.expert/explorer/testnet/tx/a6752973224771f5b0e2b08477b1562f7fa68303296c25e97a98229fa82d48c1) | 5589628 |
| 18  | `typescript/mcp`        | `typescript/mcp`          | [`90a6a77a0c921857…`](https://stellar.expert/explorer/testnet/tx/90a6a77a0c9218574dbdc8a75825c545aed1eaa74fd12093e94e7d09c0bdf03d) | 5589635 |

**After the testnet reset.** The testnet reset scheduled for 2026-12-16 removes every transaction
from the network. The gate saves each settlement's signed envelope in `gate.json`, so each hash
above can be recomputed from its envelope after the links stop resolving.

**Keeping conformance current.** An hourly off-server check compares the upstream files the suite
rests on with the gate's pin and raises an alarm when they change (task 0029).

`<TODO: replace this table and the run's numbers with the final rerun (task 0029).>`

## 6. The production service behind the testnet deployment

Not separate deliverables; what makes D1's "hardening" hold up as a public service.

| Area                  | What is in place                                                                                 | Where                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Deploys               | Image built in CI and deployed by digest; the old process stops before the new one starts        | [ADR 0011](../adr/0011-facilitator-hosting.md), [`docs/runbook.md`](../runbook.md) |
| Key custody           | The facilitator key in OpenBao Transit, testnet-only, not exportable; signing over a unix socket | [ADR 0013](../adr/0013-facilitator-key-custody.md)                                 |
| Settlement records    | Each payment claimed once per `network:payer:nonce`; records survive restarts and are reconciled | [ADR 0006](../adr/0006-settlement-record.md)                                       |
| Monitoring and alarms | Facilitator, host and log-volume alarms, uptime probe and off-server balance check, to Slack     | [`docs/monitoring.md`](../monitoring.md)                                           |
| Backups               | OpenBao's daily snapshot to an off-site Storage Box                                              | [`docs/runbook.md`](../runbook.md), "OpenBao snapshots"                            |

`<TODO: screenshots: the CloudWatch alarms list in OK state, and a delivery-test message in Slack (no channel or workspace names visible).>`

## 7. What is deliberately not claimed

- **Mainnet.** `stellar:pubnet` is not served; it ships in a later tranche.
- **Search.** `GET /discovery/search` and ranking are Tranche #2. The nDCG@10 evaluation, re-run
  at every milestone boundary, starts with the ranking it measures; Tranche #1 has none.
- **The MCP discovery server and SDK helpers.** Later tranches.
- **`upto` in `/settle` and its upstream merge.** The prototype is on testnet; the specification
  is proposed upstream, not merged.
- **Uptime targets and the "deploy in under an hour" goal.** Not measured in Tranche 1.
- **A security review report.** Before mainnet, in a later tranche.

## 8. Live endpoints and access

| Endpoint                                                       | Access                                       |
| -------------------------------------------------------------- | -------------------------------------------- |
| `https://x402-facilitator.sorobanscan.com/supported`           | Public                                       |
| `https://x402-facilitator.sorobanscan.com/health`              | Public                                       |
| `https://x402-facilitator.sorobanscan.com/verify`, `/settle`   | Public, rate-limited per IP; testnet is free |
| `https://x402-facilitator.sorobanscan.com/discovery/resources` | Public, rate-limited per IP                  |

## 9. Repository navigation

| Path                                    | What it holds                                      |
| --------------------------------------- | -------------------------------------------------- |
| `apps/facilitator`                      | The facilitator service                            |
| `packages/signer-pool`                  | The channel-account pool and submitter             |
| `packages/bazaar`                       | Discovery metadata validation                      |
| `contracts/upto-proxy`                  | The `upto` proxy contract and its end-to-end tests |
| `conformance/`                          | The conformance gate and its results               |
| `docs/adr/`                             | Architecture decisions                             |
| `docs/architecture/m1-spine.md`         | Tranche 1 architecture                             |
| `docs/planning/m1-epics.md`             | Tranche 1 scope, stories and acceptance criteria   |
| `docs/runbook.md`, `docs/monitoring.md` | Operations                                         |

Repository: <https://github.com/rumblefishdev/stellar-x402> (Apache-2.0).
