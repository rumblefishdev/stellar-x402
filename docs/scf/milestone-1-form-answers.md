# SCF Milestone 1 — Form Answers (stellar-x402)

> Copy the text inside each blockquote into the matching field of SCF's Build Tranche Completion
> form.
>
> Full evidence lives in the companion document
> [`milestone-1-evidence.md`](./milestone-1-evidence.md), exported to PDF and attached in Google
> Drive next to the video.

Field 1's four deliverables quote the Tranche #1 line items of the Panel Review response's budget
(§1) word for word, and the fifth its Tranche #1 conformance bar (§4).

---

## Field 1 — Tranche Deliverables

> **Tranche 1 — Testnet facilitator, channel-account pool, Bazaar foundation, `upto` design,
> conformance gate.**
>
> Milestone 1 delivers the testnet foundation of an open-source (Apache-2.0), self-hostable x402
> facilitator for Stellar with a Bazaar discovery layer, live at
> `https://x402-facilitator.sorobanscan.com` on `stellar:testnet`.
>
> 1. **Facilitator hardening on testnet (verify/settle/supported, any SEP-41 token, sponsored
>    fees, rate limiting).** Built on `@x402/stellar` per the x402 v2 spec, with strict per-field
>    auth-entry checks; shown with Circle testnet USDC, a Stellar Asset Contract and a plain SEP-41
>    token. Buyers hold only the payment asset; requests are rate-limited per client IP, and fee
>    spending is capped by rolling budgets with breakers.
> 2. **Channel-account pool, permissively-licensed reimplementation (sequence-number
>    throughput).** Settlements go through a pool of channel accounts under Apache-2.0, with no
>    AGPL dependency, each transaction fee-bumped by the facilitator's fee account.
> 3. **Bazaar discovery layer, foundation (`resources` endpoint + cataloging pipeline, no ranking
>    yet).** `GET /discovery/resources` with the `type`, `payTo`, `network`, `extensions`, `limit`
>    and `offset` filters; resources are cataloged on settle when the payment carries the `bazaar`
>    extension, with the outcome in the `EXTENSION-RESPONSES` header.
> 4. **`upto` scheme design finalization + testnet proxy-contract prototype.** The design and a
>    threat model; the proxy contract on testnet
>    (`CAL7SBTOECJ6HXXO3ST43LM2HJJFSZ3ZDEEZBIWHJPB7DRF5MXS5V2VC`), its end-to-end run 58 of 58.
>    The Stellar specification is already proposed upstream (x402-foundation/x402#3781).
> 5. **Tranche #1 conformance bar.** An unmodified canonical client from the
>    `x402-foundation/x402` end-to-end suite completes `exact` verify → settle against our testnet
>    facilitator at the wire level, through the suite's external facilitator proxy: 18 of 18
>    scenarios passed on 2026-11-10, each settled transaction hash recorded and checked on chain.
>
> Not claimed in this tranche: mainnet, search, the MCP server, SDK helpers, `upto` in `/settle`
> and its upstream merge, the developer guide and example integrations, and the security review.
>
> Evidence package: <https://drive.google.com/drive/folders/1sY7eIOrIbzmoC2ocax6DRn3c08ljh6ne?usp=drive_link>

---

## Field 2 — Deliverable Verification - Video

> <https://drive.google.com/file/d/1868RzK71uJ3CTgybL05y-x5hnUqn54PA/view?usp=sharing>

---

## Field 3 — Additional Deliverable Verification

> **Evidence package (Google Drive):** <https://drive.google.com/drive/folders/1sY7eIOrIbzmoC2ocax6DRn3c08ljh6ne?usp=drive_link> — contains `milestone-1-evidence.pdf`
> (every deliverable with commands, outputs, settled transaction hashes and code links, the
> architecture diagram and what is deliberately not claimed) and the demo video.
>
> **Live and anonymous (verify directly):**
>
> - `https://x402-facilitator.sorobanscan.com/supported`
> - `https://x402-facilitator.sorobanscan.com/health`
> - `https://x402-facilitator.sorobanscan.com/discovery/resources`
>
> **Source code (public, Apache-2.0):**
>
> - Repository: `https://github.com/rumblefishdev/stellar-x402`
> - Tranche 1 scope and acceptance criteria:
>   `https://github.com/rumblefishdev/stellar-x402/blob/tranche-1-evidence/docs/planning/m1-epics.md`
> - Conformance gate and its results:
>   `https://github.com/rumblefishdev/stellar-x402/tree/tranche-1-evidence/conformance`
> - Conformance report:
>   `https://github.com/rumblefishdev/stellar-x402/blob/tranche-1-evidence/conformance/REPORT.md`
> - `upto` testnet report:
>   `https://github.com/rumblefishdev/stellar-x402/blob/tranche-1-evidence/docs/upto-proxy-testnet-report.md`
> - Architecture decisions:
>   `https://github.com/rumblefishdev/stellar-x402/tree/tranche-1-evidence/docs/adr`
>
> **Operational access (on request):** the `x402-production-*` CloudWatch alarms in eu-central-1
> (read-only access can be provisioned for a reviewer's AWS account).

---

## Field 4 — Support Needed

> —
