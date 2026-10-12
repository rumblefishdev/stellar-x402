---
id: "0005"
title: "Document UptoProxy: design ADR, contract docs, threat model and testnet report"
type: DOCS
status: completed
milestone: 1
related_adr: ["0010"]
related_tasks: ["0002", "0003", "0004", "0006", "0012", "0035", "0034"]
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
  - date: "2026-10-09"
    status: completed
    who: okarcz
    note: >
      Done. All 4 acceptance criteria met; Stan's 15 review comments applied. PR #12 never merged
      on its own: PR #14 (0035) was built on its branch and rebase-merged into develop (938f1eb)
      with all of #12's commits, then #12 was closed with its branch at develop. The docs on
      develop are #14's updated versions (ADR 0010 D10/D11, threat model, 58/58 report).

# Document UptoProxy: design ADR, contract docs, threat model and testnet report

## Summary

Write up the result of 0002–0004 so that three groups can use it without reading the code: the
reviewers and auditors, the facilitator team, and the future `scheme_upto_stellar.md` author.

**Story:** [M1 Story 5.2](../../../docs/planning/m1-epics.md#story-52-document-uptoproxy-design-adr-contract-docs-threat-model-and-testnet-report) · **Lane:** Payments

## Status: Completed

> Completed 2026-10-09. The work landed through PR #14 (task 0035), which was built on this
> task's branch; PR #12 was closed with no remaining diff.

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

- [x] The ADR, contract README, threat-model section and testnet report are written
- [x] Every transaction hash in the report resolves on sorobanscan (`testnet.sorobanscan.rumblefish.dev`)
  (all 21 hashes return `SUCCESS` from testnet RPC `getTransaction`, and okarcz opened the
  transaction links on sorobanscan in a browser on 2026-10-08)
- [x] The testnet report includes the 0006 throughput numbers and the one-payment-per-transaction limit
- [x] `format:check` passes (for every tracked file; the local, untracked `CLAUDE.local.md` fails it)

## Implementation Notes

- **ADR** `docs/adr/0010-upto-proxy-design.md`: the decision, the deviations from §6.2 (D1–D9),
  rationale, alternatives (separate approve, escrow, ledger-number window, persistent nonces,
  auth nonce only, allowlist, admin, `cancel`, batch entry point) and consequences.
- **Contract README** `contracts/upto-proxy/README.md`: deployments, interface, the client's auth
  tree and how to get it from simulation, the facilitator's auth, execution order, errors (contract
  codes and the two host auth errors), event, storage, invariants I1–I7, a facilitator guide
  (verify, settle, recommended `delegated-bump` shape with the 0006 costs), build and test
  commands, and the spec input (step 5).
- **Threat model**: the `upto contract` section of `docs/threat-model.md`: assets and trust, then
  15 threats, each with attack, mitigation and residual risk.
- **Testnet report** `docs/upto-proxy-testnet-report.md`: 0004's run report moved from
  `contracts/upto-proxy/e2e/results/testnet-report.md` and extended with **Throughput and
  limits** (0006 cost by shape and throughput) and **Known limits**. Links in the e2e README and
  0034 updated; `docs/README.md` lists the report.
- **After the PR #8 review**: rebased onto the reworked 0004 branch. The report now shows the
  49/49 rerun (21 transactions, all `SUCCESS` on testnet RPC). The 122,589-stroop rent figure,
  which came from an overwritten subset run, is gone from the ADR, threat model and report, and
  "no XLM on fees" became "no settlement fees" (the client pays for its trustlines in setup).
  The transaction links in the last report table lost their code formatting, so they look like
  links.
- **After the PR #12 review** (Stan, 15 comments, all applied): new threats "Seller not paid"
  and "Proxy archived"; the cross-facilitator nonce risk and key rotation rewritten; zero
  settlements now enter the facilitator's nonce record; the 5 s ledger constant replaced by the
  network's target close time (CAP-0070); cost and rent numbers kept only in the testnet report;
  the D1–D9 table kept only in ADR 0010; the G spec's §7 TTL claim and §8.1 corrected.

## Design Decisions

### From Plan

1. **Five deliverables**: the ADR, the contract README, the threat-model section, the testnet
   report and the spec input.

### Emerged

2. **ADR number 0010**: the next free number on develop on 2026-10-08. 0013 (Adam) and 0014
   (Stan) may also write ADRs, so re-check the number before merging.
3. **One testnet report, not two**: 0004's `testnet-report.md` became `docs/upto-proxy-testnet-report.md`
   instead of a second copy next to the results JSON.
4. **Spec input lives in the contract README** (last section), next to the facilitator guide it
   extends, rather than in its own file. 0034 points to it.
5. **D9 added to the deviations**: §6.2 doesn't fix the order of `require_auth_for_args` and
   `approve`; the contract needs the auth first (finding F7).
6. **Threats as sections, not a table**: each has an attack, mitigation and residual risk, which
   were unreadable as a four-column table.
7. **Zero settlements are recorded as settled** (PR #12 review): otherwise a second `/settle` on
   the same payload with a non-zero amount would pass. 0015 must implement it.
8. **No ledger-time constant**: seconds convert to ledgers with the network's target close time,
   and the allowance must last until `deadline`. The 0034 spec draft still has `/ 5`.
9. **Archived research edited in place**: the G spec's §7 claim was wrong and §11 duplicated the
   ADR, so both now point to the canonical docs instead of being left stale.

## Issues Encountered

- **Sorobanscan's API can't be scripted**: it needs a bearer token from a browser challenge, so the
  hashes were checked against testnet RPC instead, and the links were opened in a browser.

## Future Work

- **Extend the proxy's instance and WASM TTL**: done in 0035 (self-extension and the deploy-time
  extension).
- **Sync the 0034 drafts** with the review outcome: ledger close time, zero-settlement record,
  rent wording, and 0035's new proxy, expiry cap and verify rules. Tracked in 0034 itself.
