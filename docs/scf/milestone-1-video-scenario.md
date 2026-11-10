# Milestone 1 — Deliverable Verification Video Script

Purpose: record the SCF deliverable-verification video for Milestone 1 of the x402 Facilitator
with Bazaar for Stellar: the testnet facilitator, the channel-account pool, the Bazaar foundation,
the `upto` design and prototype, and the conformance gate.

**Target length: 4–5 minutes.** Scene timings below add up to about 4:30. If you run long, trim
Scene 7: the gate's table is in the PDF.

The video shows; the PDF ([`milestone-1-evidence.md`](./milestone-1-evidence.md)) proves. Every
number said on camera must match the PDF, so record after the final deploy and the gate rerun, and
paste the same outputs into the PDF.

## Before recording

### Windows to have open (in this order — the scene order)

1. **PDF viewer** — `milestone-1-evidence.pdf`, at section 1; Scene 5 jumps to section 5.3.
2. **Image viewer** — `architecture.png`, full screen.
3. **Terminal A** — `export FAC=https://x402-facilitator.sorobanscan.com`, `jq` installed. Run
   every command of Scenes 3 and 5 once beforehand, so you know the output before the camera is
   on.
4. **Browser tab 1** — stellar.expert (testnet) on one transaction from the gate's run, e.g. the
   first row of the table in section 5.5 of the evidence document.
5. **Browser tab 2** — stellar.expert (testnet) on the `UptoProxy` contract
   `CAL7SBTOECJ6HXXO3ST43LM2HJJFSZ3ZDEEZBIWHJPB7DRF5MXS5V2VC`.
6. **Browser tab 3** — GitHub: `docs/upto-proxy-testnet-report.md` at the `tranche-1-evidence` tag.
7. **Browser tab 4** — GitHub: `conformance/REPORT.md` at the `tranche-1-evidence` tag, at its table of
   settlements.
8. **Browser tab 5** — the upstream PR x402-foundation/x402#3781.
9. **Browser tab 6** — AWS Console → CloudWatch → Alarms, filtered to `x402-production`, in
   eu-central-1.

### ⚠️ Secrets — read this before you hit record

Nothing below may appear in any frame:

- OpenBao: tokens, AppRole role or secret IDs, unseal or recovery keys, `bao` output.
- The server: its IP, SSH sessions, `/srv/x402/`, `/run/x402/`, any `.env` file.
- RPC URLs from `RPC_URLS`: one can carry an API key. Logs name them `RPC_URLS[i]#…` only.
- AWS: the account ID in the console's top-right menu (crop or hide it), credentials, the
  Storage Box.
- Slack: the workspace's and other channels' names.

### Values to have ready

| Value                                         | Where from                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| The deployed commit                           | `curl -s $FAC/health \| jq -r .commit` — must equal the gate rerun's facilitator commit |
| Gate run: passed/total, date, upstream commit | `conformance/results/testnet-hosted/gate.json` and `suite.json`                         |
| One gate transaction                          | Section 5.5 of the evidence document                                                    |
| The catalog pipeline's run                    | Section 5.3 of the evidence document: two transactions and the decoded header           |

### What NOT to show

- Anything in the secrets list above.
- Mainnet, search, the MCP server: they are not in this milestone. If asked on camera, they are
  later tranches.
- Team members' names, the team's Slack or internal tools, Polish text.
- An alarm in ALARM state, unless you explain it (a `make fire-test` delivery test is fine, and
  says so).

## Scene 1 — Intro and scope (~0:20)

**Screen:** the evidence PDF's title page or section 1's table.

> "This is Milestone 1 of the x402 Facilitator with Bazaar for Stellar, by Rumble Fish. It is
> the testnet foundation: a hardened facilitator, a channel-account pool in the settle path, the
> Bazaar's resources endpoint and cataloging, the final `upto` design with a testnet prototype,
> and a conformance gate run with the x402 Foundation's own test suite."

## Scene 2 — Architecture (~0:30)

**Screen:** `architecture.png`.

> "One facilitator service serves verify, settle, supported and the Bazaar's resources endpoint.
> It builds on the Apache-2.0 `@x402/stellar` package. Settlements go through a pool of channel
> accounts, each fee-bumped by our fee account, so a buyer needs no XLM. The facilitator key lives
> in OpenBao on the server and never enters the process. State is in Postgres; logs and alarms go
> to CloudWatch."

## Scene 3 — The live facilitator (~0:40)

**Screen:** Terminal A.

```bash
curl -s $FAC/supported | jq
curl -s $FAC/health | jq
```

> "It's live on testnet. `/supported` lists the `exact` scheme on `stellar:testnet`, fees
> sponsored, the Bazaar extension, and the facilitator's signer. `/health` says it is ready, its
> signer works, and names the commit it runs."

Point at `areFeesSponsored: true` and at `commit`.

## Scene 4 — Settlement through the channel pool (~0:40)

**Screen:** browser tab 1, the gate transaction on stellar.expert.

> "Here is one settled payment. The transaction's source is one of our channel accounts, not the
> buyer; the outer fee bump is paid by the facilitator's fee account. Inside, one SEP-41
> `transfer` of 0.001 testnet USDC from the buyer to the seller."

> "The same path settles Circle USDC, a Stellar Asset Contract and any plain SEP-41 token; the
> token matrix in the evidence document shows all three, and six buyers' payments settled through
> four channels, three of them in one ledger."

## Scene 5 — The Bazaar foundation (~0:40)

**Screen:** Terminal A, then the PDF at section 5.3.

```bash
curl -s "$FAC/discovery/resources?network=stellar:testnet&type=http&limit=1" | jq
```

> "The Bazaar's resources endpoint is live, with the spec's filters: type, payTo, network,
> extensions, limit and offset. Its catalog fills only from real settlements carrying the Bazaar
> extension, with no registration step, and no seller has settled one through it yet, so today
> it is empty."

Switch to the PDF, section 5.3.

> "Here is the pipeline end to end on testnet. A buyer's payment settles, and the facilitator
> lists what the seller's own 402 response says. An outsider's payment with a forged description
> leaves the seller's text and price in place. Search and ranking come in a later tranche."

Point at the two transaction hashes and at `processing` in the decoded header.

## Scene 6 — `upto` (~0:30)

**Screen:** browser tab 3 (the report), then tab 2 (the contract), then tab 5 (the upstream PR).

> "`upto` lets a buyer authorize up to a cap and pay for actual usage. The design is final, with
> a threat model. The proxy contract is deployed on testnet, and its end-to-end run passed 58 of
> 58 scenarios across USDC, a Stellar Asset Contract and a plain SEP-41 token. The Stellar
> specification is proposed upstream to the x402 Foundation."

## Scene 7 — The conformance gate (~0:45)

**Screen:** browser tab 4, then tab 1 again if needed.

> "Conformance is tested at the wire level. The gate runs the x402 Foundation's own end-to-end
> suite, unmodified, at a pinned commit, against our public testnet facilitator through an
> external proxy, the mechanism the suite provides for that. Every canonical TypeScript client and
> server, over HTTP and MCP: 18 of 18 passed, each with a settled transaction the gate reads back
> from the network and checks."

The numbers are the final rerun's (2026-11-10, facilitator `5d2e26ba`), the same as the PDF's.

## Scene 8 — Operations and wrap-up (~0:30)

**Screen:** browser tab 6, the CloudWatch alarms, all OK.

> "Behind it is a production service: deploys by image digest, the key in OpenBao, settlement
> records that survive restarts, spend budgets and breakers against fee abuse, and alarms that
> reach our on-call channel. Mainnet, search, the MCP server and the SDK helpers are the next
> tranches. Everything shown here is in the evidence document and the public repository."

## After recording

1. Watch the whole video once for any frame from the secrets list.
2. Upload it to the Google Drive folder with the PDF, link-sharing set to "anyone with the link
   can view".
3. Paste its link into Field 2 of [`milestone-1-form-answers.md`](./milestone-1-form-answers.md).
