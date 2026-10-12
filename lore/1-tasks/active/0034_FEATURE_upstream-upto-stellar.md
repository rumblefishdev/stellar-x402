---
id: "0034"
title: "Merge the Stellar upto scheme upstream: scheme_upto_stellar.md and the @x402/stellar classes"
type: FEATURE
status: active
related_adr: ["0001"]
related_tasks: ["0002", "0003", "0004", "0005", "0015"]
tags: [upstream, upto, spec, priority-high, effort-large, payments]
links:
  - https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track#x402-facilitator-with-bazaar-discovery-support
  - https://github.com/x402-foundation/x402/blob/main/specs/CONTRIBUTING.md
  - https://github.com/x402-foundation/x402/blob/main/CONTRIBUTING.md
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md
  - ../../../docs/adr/0001-repo-layout.md
  - ../../../docs/rfp/07-x402-facilitator-bazaar.md
history:
  - date: "2026-10-08"
    status: backlog
    who: claude
    note: >
      Task created with okarcz from the published RFP, which makes the upstream merge a
      deliverable. No earlier task covered it: 0005 only lists the spec input, and M1 leaves the
      merge out.
  - date: "2026-10-08"
    status: active
    who: okarcz
    note: "Started while 0005's PR (#12) waits for review; work is on a local branch from lore-0005."
  - date: "2026-10-09"
    status: active
    who: claude
    note: >
      Added the 0035 security review's rules for the spec and the client: the allowance window
      bound and the contract's 17,280-ledger cap (D11), and that the client never signs a
      simulated tree without comparing it to the terms. The proxy is now CAL7SBTO…V2VC.
---

# Merge the Stellar upto scheme upstream: scheme_upto_stellar.md and the @x402/stellar classes

## Summary

Write the Stellar network spec for the `upto` scheme, `scheme_upto_stellar.md`, and get it and
the matching `upto` classes merged into `x402-foundation/x402`. The RFP counts this as done only
once it is **merged**, not when it is proposed.

**Lane:** Payments

## Context

The published RFP (SCF Build Award, RFP track, "x402 Facilitator with Bazaar Discovery
Support") says:

- `upto` (authorize up to a cap, settle actual usage) fits metered services such as token
  billing. The spec has EVM and SVM versions but no Stellar one, "so this work includes authoring
  `scheme_upto_stellar.md` as well as the implementation, contributed upstream so the whole
  ecosystem benefits."
- Deliverable: "upto scheme merged upstream into the x402 package with its
  `scheme_upto_stellar.md` network spec." This covers the code as well as the spec.
- "Coordinate the upstream contribution through the x402 Technical Steering Committee. SDF's
  board seat is available to unblock maintainer review."
- "Respondents must state whether their upto design ships a Soroban contract." A design without
  a contract must document its weaker trust model, because SEP-41 allowances alone can't enforce
  the recipient binding and single settlement the spec requires.

Our local copy, `docs/rfp/07-x402-facilitator-bazaar.md`, is shortened and lacks the last two
points.

What we have:

- **Design:** the UptoProxy contract spec and research in 0002
  (`archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/G-upto-proxy-contract-spec.md`).
- **Contract:** `contracts/upto-proxy` (0003). It enforces the recipient binding and single
  settlement, so we do ship a Soroban contract.
- **On-chain proof:** 0004 ran 49 scenarios on testnet across Circle USDC, a SAC asset and a
  non-SAC SEP-41 token (`docs/upto-proxy-testnet-report.md`).
- **Spec input:** 0005 step 5 lists the rules the spec needs, and its threat model covers the
  leftover allowance.
- **Facilitator settlement:** 0015 wires `upto` into our `/settle`.

ADR 0001 sets where the work happens: the spec and the `upto` classes are written in our fork of
`x402-foundation/x402`; UptoProxy is offered to upstream `contracts/stellar/` once the Technical
Steering Committee agrees; until the release ships, we depend on a local build of the fork.

### Upstream layout and rules (checked 2026-10-08)

- Specs: `specs/schemes/upto/` has `scheme_upto.md`, `scheme_upto_evm.md` and
  `scheme_upto_svm.md`. A network spec follows `specs/scheme_impl_template.md`: Summary, Payment
  header payload, Verification, Settlement, Appendix. `scheme_exact_stellar.md` is the house
  style for Stellar.
- Code: `typescript/packages/mechanisms/stellar/src/` has only `exact/` (`client`, `server`,
  `facilitator`). `typescript/packages/mechanisms/svm/src/upto/` is the layout to copy.
- Contracts: `contracts/evm/` holds `x402UptoPermit2Proxy.sol` with its tests. There is no
  `contracts/stellar/` yet.
- Process (`specs/CONTRIBUTING.md`): open an issue or discussion first (the problem, the
  approach, why the existing schemes don't suffice), then write the spec from the template, then
  open the PR.
- PR rules (`CONTRIBUTING.md`):
  - Every commit is signed.
  - Disclose AI use when most of a PR was generated, and review it yourself before marking it
    ready.
  - A changeset goes in `typescript/.changeset/`.
  - `pnpm test` must pass in `typescript/`.
  - Merging is at the x402 Foundation's discretion, based on risk and quality.

## Implementation

### 1. Open the conversation early

Upstream review is the slow part, so start it before the code is ready:

- Open an issue in `x402-foundation/x402` proposing `upto` on Stellar. Cover the problem
  (metered payments, no Stellar `upto` yet), the approach (a Soroban proxy contract, the client
  signs one auth entry, the facilitator settles the actual amount), and why `exact` is not enough.
- Ask through the Technical Steering Committee for a maintainer to own the review. Ask SDF to
  use its board seat if review stalls.
- Ask where the contract should live: upstream `contracts/stellar/`, or our repo with the spec
  pointing to its deployed address and WASM hash.

### 2. Write `scheme_upto_stellar.md`

Write it in the fork, from `scheme_impl_template.md`, in the style of `scheme_exact_stellar.md`.
Base it on 0005's spec-input list. It covers:

- **`PaymentRequirements` and payload:** the network IDs, the asset (SAC or SEP-41), `maxAmount`,
  `payTo`, `extra` fields (the proxy contract ID, the facilitator address), and the signed auth
  entry carried in the payload.
- **The authorization:**
  - the client signs a `settle_upto` entry with an `approve` sub-invocation;
  - the signed arguments are everything except `from` and `actual_amount`;
  - the nonce, `valid_after`, `deadline` and allowance expiration;
  - the client never pays a fee.
- **Verification:**
  - the auth tree matches the terms exactly;
  - credential types (`Address` / `AddressV2`);
  - simulation;
  - the validity window against the current ledger;
  - `allowance_expiration_ledger` no earlier than the deadline's ledger and no further than the
    window (`maxTimeoutSeconds` in ledgers plus a margin), and equal to `signatureExpirationLedger`
    (a MUST: the host's nonce for the client's signature lives until then, and the contract never
    sees it). The facilitator pays all three entries' rent. The contract refuses anything over 17,280 ledgers ahead
    (ADR 0010, D11), so `maxTimeoutSeconds` for `upto` is at most about a day;
  - `from` is not the facilitator;
  - the nonce is unused.
- **Settlement:**
  - the facilitator swaps in the actual amount and re-simulates;
  - it submits with the facilitator as the operation source;
  - zero-amount settlement;
  - the `upto_settled` event;
  - what `SettlementResponse` returns.
- **Security:**
  - replay is refused twice (Soroban auth `ExistingValue` and contract `NonceUsed`);
  - the recipient and facilitator bindings;
  - the leftover allowance until expiration (0005 threat model);
  - why a contract is required, and the weaker trust model without one, as the RFP asks.
- **Appendix:** the contract interface and error codes, deployed testnet IDs, and links to the
  0004 transactions.

### 3. Upstream the `upto` classes

In the fork, add `typescript/packages/mechanisms/stellar/src/upto/` with `client`, `server` and
`facilitator`, following `svm/src/upto/`. Move the logic out of our own code rather than writing
it twice:

- **Client:** build and sign the auth entry (from `contracts/upto-proxy/e2e/src/upto.ts`,
  `clientSign` and `signSimulatedEntry`). Never sign a simulated tree without comparing it to the
  one built from the terms: the simulation comes from an RPC or facilitator the client doesn't
  control (threat model, "Blind signing by the client"). Include a unit test with a forged tree.
- **Facilitator:** verify the tree and settle the actual amount (`checkClientAuth`, `settleCall`,
  and the 0015 settle path). Keep the facilitator's own submission pluggable, as `exact` does.
- **Server:** price and build `PaymentRequirements` for `upto`.
- Unit tests in the package's style, a changeset, and the docs page (`docs/schemes/upto.mdx`
  lists the networks).
- Add an e2e scenario to the upstream harness if maintainers want one.

### 4. Get it merged

- Open the spec PR first and the code PR after it, or one PR if maintainers prefer. Each one
  links the issue, the 0004 report and the audit status.
- Answer the review. Record every change it forces in our contract or facilitator as a follow-up
  task.
- Once it is released, switch the monorepo from the local fork build to the published
  `@x402/stellar` (ADR 0001) and delete our duplicated client and facilitator code.

## Acceptance Criteria

- [ ] An upstream issue proposes Stellar `upto`, and a maintainer or the Technical Steering
  Committee has acknowledged it
- [ ] `specs/schemes/upto/scheme_upto_stellar.md` is merged into `x402-foundation/x402`
- [ ] The Stellar `upto` client, server and facilitator classes are merged into
  `@x402/stellar`, with tests and a changeset
- [ ] The spec states that the design ships a Soroban contract and explains why
- [ ] The monorepo depends on the published `@x402/stellar` with `upto`, not the local fork build
- [ ] `docs/rfp/07-x402-facilitator-bazaar.md` matches the published RFP's `upto` wording

## Dependencies

- **0005:** the spec-input list and the threat model.
- **0015:** facilitator settlement for `upto`, the source of the upstream facilitator class.
- **An audit or security review of UptoProxy:** maintainers may ask for one before merging code
  that moves value.
- Step 1 can start now. Steps 2–4 follow 0005 and 0015.
