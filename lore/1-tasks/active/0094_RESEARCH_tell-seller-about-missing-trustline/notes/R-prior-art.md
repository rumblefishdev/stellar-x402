---
title: "Prior art: who tells a seller that its payTo can't receive"
type: research
status: mature
tags: [facilitator, prior-art, trustline, solana, ata]
history:
  - date: "2026-11-26"
    status: mature
    who: akot
    note: >
      Web research (agent report), sources read 2026-11-26; the key claims re-read with gh
      (issue #1020, SVM errors.ts and spec, Stellar facilitator scheme.ts, PR #3962, Solana docs).
    spawns: [notes/S-recommendation.md]
---

# Prior art: who tells a seller that its payTo can't receive

Sources read on **2026-11-26**. **[inferred]** marks our reading of code or docs, not their words.
OpenZeppelin's relayer and its x402 plugin are left out (clean-room rule, AGPL).

Upstream moved to **`x402-foundation/x402`**; `coinbase/x402`'s main stopped at 2026-10-15.
Permalinks are to main at `520e5a05` (2026-11-26), written `X/` below
(`https://github.com/x402-foundation/x402/blob/520e5a055af5c7f2a2c1602cdf94fd0971de2768/`).
The latest npm release of `@x402/core`, `@x402/svm` and `@x402/stellar` is 2.32.0 (2026-11-20);
we pin 2.31.

## Conclusion

**No x402 facilitator or SDK warns the seller before the first payment.** What exists:

- written "set up the receiving account before you advertise" steps (Solana's docs, PayAI, CDP,
  the Algorand spec);
- one portal flow that creates the account at onboarding (PayAI's merchant portal, Solana, its
  batch-settlement lane);
- a paid third-party probe (x402 Doctor, Solana only).

Everything else reports the problem when a payment fails, and to the buyer. Outside x402, Stripe
Connect and Core Lightning do tell the receiver before the first payment.

## Solana: the payTo's token account (ATA)

The same problem: a wallet needs an associated token account per mint to receive it.

- **Nobody creates it, by design (released `@x402/svm` 2.32.0).** The fee payer may appear in no
  instruction: "the Solana runtime cannot authorize it for … ATA creation"
  (`X/specs/schemes/exact/scheme_exact_svm.md:285`).
- **Why:** issue [#1020](https://github.com/x402-foundation/x402/issues/1020), "Automatically
  create an ATA for the payTo address on Solana" (opened 2026-01-23, still open). Its author puts
  our problem in a seller's words: the seller has said how it wants to be paid, "but the
  transaction is failing because the seller hasn't quite setup their account". The maintainer
  (`ukstv`, 2026-01-25): "That's by design. Creating ATA on the facilitator/server side opens an
  attack vector for draining their funds": the seller closes the ATA, takes the rent back, and
  repeats.
  - An operator (2026-08-15) suggests a check "before issuing payment requirements": the ATA's
    address is derived, so it is "one RPC call". A comment, not code.
- **Two attempts were closed unmerged.**
  - [#2798](https://github.com/x402-foundation/x402/pull/2798): the facilitator pays the ATA.
    Refused for the same reason.
  - [#2802](https://github.com/x402-foundation/x402/pull/2802#issuecomment-6336700402): the buyer
    fails fast on a missing ATA. Refused because "it also fails before a payload exists, so neither
    the server nor the facilitator ever sees the error". The reviewer asked for a check in the
    facilitator instead, after a failed simulation.
- **What shipped is a diagnosis at `/verify`:**
  [#3962](https://github.com/x402-foundation/x402/pull/3962), merged 2026-10-27 (TypeScript and Go;
  Python in #4026), in 2.32.0.
  - The reasons are `invalid_exact_svm_recipient_ata_missing` and
    `…_recipient_ata_wrong_program_owner` (`X/typescript/packages/mechanisms/svm/src/exact/facilitator/errors.ts:87-89`).
  - They come from one `getAccountInfo` after a failed simulation (`…/facilitator/scheme.ts:1501-1530`).
  - This is the same shape as our 0078. As with ours, the reason goes back to the buyer in a 402.
- **On main, not released: sponsored ATA creation** (#3968, 2026-11-24).
  - The seller marks `extra.ataCreationRequired`. A facilitator that advertises
    `ataCreationSponsored` in `/supported` lets the client add a `CreateIdempotent` paid by the
    fee payer (spec §5.4–5.5, `:81`, `:289-304`).
  - The spec admits the drain stays: "It is not bounded over time: an owner can close its ATA and
    the next charge pays rent again" (`:304`).
  - The client adds the instruction only when the ATA is missing. Nothing checks that the seller
    set the flag.
- **Other Solana stacks** expect the seller to have the ATA:
  - Faremeter/Corbits assumes it exists ([inferred] from `packages/payment-solana/src/exact/`).
  - Dexter's `@dexterai/mpp` README: "Recipients must have an existing USDC token account (ATA)…
    If the recipient's ATA doesn't exist, the settlement will fail with a clear simulation error."
- **Solana's own docs** say it plainly before going live: "Before advertising the route, create the
  recipient's associated token account for the accepted mint… A facilitator may sponsor
  settlement transaction fees, but that does not imply that it will create the recipient account
  or fund its rent." They ship a `create-recipient-account.ts`
  ([solana-com `a0c373ea`, `x402/index.mdx:202-206`](https://github.com/solana-foundation/solana-com/blob/a0c373ea99eea6614c632a43e0919d62d2748c04/apps/docs/content/docs/en/payments/agentic-payments/x402/index.mdx)).

## Upstream's Stellar scheme

- **Spec:** `X/specs/schemes/exact/scheme_exact_stellar.md` says nothing about trustlines, a
  missing `payTo` account or the seller's setup. The only `payTo` rule is that the transfer's `to`
  equals it (`:120`), and the simulation must succeed (§5).
- **Facilitator:** a failed simulation is `console.error("Simulation error:", …)` and
  `invalid_exact_stellar_payload_simulation_failed`
  (`X/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts:530-533`). It has no
  trustline reason; ours (0078) and SVM's ATA reasons are the only ones of the kind.
- **Client:** `TrustlineMissingError` (#2975, closing
  [#2761](https://github.com/x402-foundation/x402/issues/2761)), the buyer's side only.
- **README:** "Add USDC trustline (required for client and resource server)" appears only under the
  integration tests' setup (`…/stellar/README.md:158`).
- **`stellar/x402-stellar`** (`61bd87a6`): its example server checks `payTo`'s format only
  (`examples/simple-paywall/server/src/config/env.ts:41-44`). Its `paymentLogger` middleware logs a
  paid retry's x402 error fields: the one seller-side log of refusals we found.
- **Stellar's x402 page** (developers.stellar.org/docs/build/agentic-payments/x402) mentions
  trustlines only for two facilitators' fee models, not for `payTo`.

## Other chains in x402's specs

The receiver can be unready on several other chains too.

- **Algorand** is the one spec with seller guidance: the resource server "MUST be opted-in to
  that asset… as part of the resource server's setup, it SHOULD ensure it has opted-in"
  (`X/specs/schemes/exact/scheme_exact_algo.md:201`).
- **NEAR**, **XRPL** and **Hedera** make the facilitator check it at `/verify`:
  - NEAR: `invalid_exact_near_recipient_not_registered_for_storage`
    (`…/near/src/exact/facilitator/scheme.ts:319`);
  - XRPL: an IOU trust line;
  - Hedera: `payTo` associated with the token.
- **EVM** has no per-receiver account, so it has no such check. The nearest case is CDP's
  `self_send_not_allowed`, which reaches the client "as a bare `402` with an empty body"
  ([#2911](https://github.com/x402-foundation/x402/issues/2911), open).

## Facilitators

- **Coinbase CDP:**
  - [Seller quickstart](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers): needs "a
    `payTo` address that can receive the asset on each network you advertise".
  - Production configuration: "Confirm that each `payTo` address can receive funds on its
    mainnet."
  - Docs only: no endpoint, no check, no failure dashboard found. It can provision a CDP wallet as
    `payTo`.
- **PayAI** ([batch settlement](https://docs.payai.network/x402/servers/batch-settlement)):
  - The wallet in `payTo` must have its USDC ATA "before customers open channels"; PayAI "does not
    create the merchant's receiving ATA during settlement".
  - The merchant portal has a "token-account setup flow" and "may sponsor the first linked Solana
    wallet's USDC ATA when eligible". Its Express guide has an `spl-token create-account` step.
  - The closest thing to onboarding help. Documented for one lane; no general "check my payTo"
    endpoint or webhook found.
- **thirdweb:** nothing on the ATA; "watch your server wallet dashboard".
- **Heurist:** a dashboard of verifications and settlements, after the fact.
- **Daydreams:** optional `recordVerification()` tracking, after the fact.
- **x402.org docs:** the seller quickstart has no ATA or trustline step.
- **Resource-server middleware** (`@x402/core`, express, hono, next, Python FastAPI):
  - It checks no `payTo` at `initialize()`, which looks only at schemes and `/supported`
    (`X/typescript/packages/core/src/http/x402HTTPResourceServer.ts:504-512`, `:1141-1240`).
  - It turns `isValid: false` into a 402 with the reason and logs nothing (`:692-704`).
  - Upstream's hooks page says `onAfterVerify` runs "including a facilitator response with
    `isValid: false`", and `onVerifyFailure` "does not run" for one. No page suggests alerting on
    either.
- **Third-party probes:**
  - [x402 Doctor](https://x402-doctor.fizzl.eu): its paid seller diagnosis covers "the Solana
    payout token account", and its preflight covers "whether the payout address can receive".
    Nothing for Stellar.
  - x402check, x402 Preflight and the proposed x402-doctor CLI check the 402's shape, not
    receivability.

## The same problem outside x402

- **Stellar anchors (SEP-24):**
  - They show `pending_trust`: "the user must add a trustline for the asset for the deposit to
    complete".
  - They can deliver anyway with a claimable balance: anchors "will no longer have to wait until
    the user's Stellar account has a trustline"
    ([sep-0024 `cd1b371e`](https://github.com/stellar/stellar-protocol/blob/cd1b371e51182cb56ccdcf1ba7e5772aef496100/ecosystem/sep-0024.md), `:625-657`, `:1370`).
  - A visible status and "claim later", not a check before going live. A claimable balance doesn't
    fit `exact`, whose transfer is a SAC `transfer` the buyer signed [inferred].
- **Solana Pay:** the payer's side throws `recipient not initialized` (`core/src/createTransfer.ts:155-165`).
- **Core Lightning:**
  - [`invoice`](https://docs.corelightning.org/reference/invoice) answers with `warning_capacity`
    ("there's not enough incoming capacity to pay this invoice") when the receiver creates the
    payment request.
  - The closest analog to warning a seller when it publishes its offer.
- **Stripe Connect:**
  - [`charges_enabled` / `payouts_enabled`](https://docs.stripe.com/connect/account-capabilities)
    with `requirements.currently_due` and an `account.updated` webhook.
  - The platform knows before the first charge whether the merchant can be paid, and hears when
    that changes. It can because it holds the merchant's account; an x402 facilitator only
    answers calls.

## Summary

| Project                          | Missing receiver account                                               | Warns the seller before the first payment                |
| -------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| x402 Stellar spec / `@x402/stellar` | buyer's client throws `TrustlineMissingError`; facilitator `…simulation_failed` | no                                         |
| `@x402/svm` 2.32.0               | not created (fee payer isolated); `/verify` `…recipient_ata_missing`    | no: the reason goes to the buyer                         |
| `@x402/svm` main                 | opt-in sponsored `CreateIdempotent`                                     | no: the seller sets a flag by hand                       |
| Algorand / NEAR / XRPL / Hedera specs | checked at `/verify` (NEAR, XRPL, Hedera)                          | Algorand: a written SHOULD                               |
| `@x402/core` and middlewares     | no `payTo` check at start; a refusal isn't logged                       | no; `onAfterVerify` is the only hook that sees it        |
| Coinbase CDP                     | not documented                                                          | docs: "confirm that each payTo can receive"              |
| PayAI                            | not created at settlement                                               | partly: docs and a portal setup flow (batch lane)        |
| Solana docs                      | the facilitator isn't expected to create it                             | docs and a script, "before advertising the route"        |
| Dexter, Faremeter/Corbits        | refused / assumed to exist                                              | Dexter: docs only                                        |
| thirdweb, Heurist, Daydreams     | not documented                                                          | no; dashboards or tracking after the fact                |
| x402 Doctor (third party)        | n/a                                                                     | a paid probe, Solana only                                |
| SEP-24 anchors                   | `pending_trust`, claimable balances                                     | no; a status to the receiver                             |
| Core Lightning, Stripe Connect   | n/a                                                                     | yes: at invoice creation; account capabilities + webhook |

## Gaps

- Daydreams, Heurist, thirdweb and Corbits were read from docs, not code.
- PayAI's portal was read from its docs only.
- Other Stellar facilitators (AlgoVoi, Vellar, Rail402) were not looked at in depth.
