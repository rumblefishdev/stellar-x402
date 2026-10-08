---
id: "0005"
title: "Document UptoProxy: design ADR, contract docs, threat model and testnet report"
type: DOCS
status: active
milestone: 1
related_adr: []
related_tasks: ["0002", "0003", "0004", "0006", "0012"]
tags: [layer-contracts, upto, priority-medium, effort-small, payments]
links:
  - ../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-testnet-throughput-measurements.md
  - ../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-network-limits-and-mainnet-usage.md
  - ../archive/0006_RESEARCH_upto-settlement-scaling/notes/S-facilitator-scaling.md
  - ../../../docs/planning/m1-epics.md
history:
  - date: "2026-09-30"
    status: backlog
    who: claude
    note: "Task created with okarcz. Starts after 0004."
  - date: "2026-10-05"
    status: backlog
    who: claude
    note: "Added the throughput numbers from 0006 as input for the testnet report."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "ADR number changed: 0003 is now the channel-pool ADR, so use the next free number."
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Mapped to M1 Story 5.2 (Payments lane) by 0012."
  - date: "2026-10-08"
    status: active
    who: okarcz
    note: "Started while 0004's PR (#8) waits for review; its results and findings are the input."
---

# Document UptoProxy: design ADR, contract docs, threat model and testnet report

## Summary

Write up the result of 0002–0004 so that three groups can use it without reading the code: the
reviewers and auditors, the facilitator team, and the future `scheme_upto_stellar.md` author.

**Story:** [M1 Story 5.2](../../../docs/planning/m1-epics.md#story-52-document-uptoproxy-design-adr-contract-docs-threat-model-and-testnet-report) · **Lane:** Payments

## Status: Active

> Started 2026-10-08. 0004 is done in code and in review (PR #8); its testnet results, report and
> findings are on branch `lore-0004-upto-proxy-testnet-e2e` until it merges.

## Implementation Plan

1. **ADR** `docs/adr/NNNN-upto-proxy-design.md` (next free number; 0003 is the channel-pool ADR): the design decisions from 0002's S- notes, and
   every deviation from arch doc §6.2 with its reason.
2. **Contract README** `contracts/upto-proxy/README.md`: the interface, the signed payload, the
   auth tree a client must sign, errors, events and invariants, and how a facilitator builds,
   verifies and settles a transaction. That includes the recommended submission shape from 0006
   (see below).
3. **Threat model**: fill in the `upto` contract section of `docs/threat-model.md` (front-running,
   leftover allowance, replay, token or recipient substitution, malicious token contract, and
   fee griefing).
4. **Testnet report** `docs/upto-proxy-testnet-report.md`: the contract ID, WASM hash, scenario
   table with transaction hashes and links, cost per settlement, and known limits. It needs a
   **Throughput and limits** section built from 0006 (see below).
5. **Spec input**: a short list of the rules `scheme_upto_stellar.md` needs. Writing the upstream
   spec itself is a separate, later task.

## Input from 0006: throughput numbers

Measured on testnet on 2026-10-05 against proxy `CBEPV3F2…TEGY7`. The details and transaction
hashes are in 0006's
[R-testnet-throughput-measurements](../archive/0006_RESEARCH_upto-settlement-scaling/notes/R-testnet-throughput-measurements.md),
and the raw data is in `0006…/bench/results/`.

**Cost per settlement, by transaction shape:**

| Shape | Size | Fee charged (stroops) | Instructions |
|---|---|---|---|
| Facilitator as tx source | 2,352 B | 40,709 | 1.60 M |
| Channel tx source, facilitator as op source | 2,460 B | 41,180 | 1.60 M |
| The same, with a fee bump | 2,588 B | 41,279 | 1.60 M |
| Channel tx source, facilitator address auth (spike S8) | 2,680 B | 49,368 | 2.15 M |
| **Recommended:** channel with facilitator as signer, op source and fee bump | **2,516 B** | **40,965** | 1.60 M |

- One-time costs fall on whichever settlement triggers them. The first settlement of the day paid
  116,316 stroops of rent for a TTL extension (151,550 in total).

**Throughput:**

| Setup | Result |
|---|---|
| Single source account | 1 pending tx per account, so 1 settlement per ledger (about 0.2/s) |
| 5 / 20 / 50 channels | 5 / 20 / 50 per ledger, 0 failures |
| 120 channels, many sellers | 478 of 480 settled on the first try (the other 2 failed on the bench side), peak 103 per ledger |
| 120 channels, one seller | 480 of 480, peak 102 per ledger: no same-seller penalty |
| Network ceiling (tx size, 266,240 B per ledger) | about 105 settlements per ledger, about 20/s network-wide |
| Mainnet free share (1 h sample, about 59% already used) | about 43 per ledger, about 8/s |
| `/verify` simulation (public testnet RPC) | 0.3 s p50 at low load; levels off at about 150/s |

**Known limits** to state in the report: one `upto` payment is one transaction, so `upto` cannot
go beyond the network share above. Higher request rates need off-chain aggregation, a separate
`batch-settlement` binding (0006's
[S-session-aggregation](../archive/0006_RESEARCH_upto-settlement-scaling/notes/S-session-aggregation.md)).

The source RFP and architecture docs in `docs/rfp/` are left unchanged. Deviations go in the ADR.

## Acceptance Criteria

- [ ] The ADR, contract README, threat-model section and testnet report are written
- [ ] Every transaction hash in the report resolves on stellar.expert
- [ ] The testnet report includes the 0006 throughput numbers and the one-payment-per-transaction limit
- [ ] `format:check` passes
