# Threat model

Not written yet, except for the `upto` contract section below. Planned sections: assets (signer
keys, fee budget, catalog integrity), fee griefing via failed transactions, auth-entry
validation, SSRF in Bazaar metadata, API key abuse.

## `upto` contract

Scope: `contracts/upto-proxy` ([README](../contracts/upto-proxy/README.md),
[ADR 0010](adr/0010-upto-proxy-design.md)) and the facilitator rules it relies on. The facilitator
itself is covered separately.

### Assets and trust

- **The payer's tokens.** The client authorizes up to `max_amount` of one token, to one
  recipient, through one facilitator, within a time window.
- **The seller's payment.** The seller relies on the facilitator to settle the amount it asks for.
- **The facilitator's XLM.** It pays every transaction fee and fee bump.

What each party must trust:

- **The client trusts the seller and its facilitator up to the ceiling.** The contract enforces
  `actual_amount <= max_amount`, not that the charge is fair. This is inherent in `upto` on every
  network; short windows limit the exposure.
- **Nobody trusts the contract's operator**, because there is none: no admin, no upgrade, no held
  funds.
- **Everyone trusts the token contract they chose.** The proxy accepts any SEP-41 token.

### Threats

#### Front-running

- **Attack:** Someone who sees the client's signed entry (in the payload, or in a pending
  transaction) settles it first, for example for 1 stroop, cheating the seller.
- **Mitigation:** The client signs `facilitator`, and the contract calls
  `facilitator.require_auth()`; the facilitator's authorization covers `actual_amount`. Another
  submitter fails with `Error(Auth, InvalidAction)` (spike S5, and the 0004 "different facilitator"
  scenario).
- **Residual risk:** None found.

#### Replay of a signed entry

- **Attack:** Submitting the same signed entry a second time.
- **Mitigation:** Soroban makes each auth entry single-use: `Error(Auth, ExistingValue)`. Shown on
  testnet in 0004.
- **Residual risk:** None.

#### Replay of a payment nonce

- **Attack:** A client (or a facilitator holding two entries) signs two payments with the same x402
  nonce.
- **Mitigation:** The contract stores `(from, nonce)` until at least `allowance_expiration_ledger`
  and refuses a second settlement with `NonceUsed` (shown in 0004). After the entry expires, the
  facilitator's durable record of settled pairs refuses reuse at verify and settle (spec §8.1).
- **Residual risk:** A client that reuses a nonce across two facilitators has signed two separate
  payments; each facilitator settles one. Payload-level uniqueness is per facilitator.

#### Recipient substitution

- **Attack:** The facilitator or a relayer redirects the payment.
- **Mitigation:** `to` is signed; a changed recipient fails auth (0004 tampering scenario).
  `to == proxy` is refused (`InvalidRecipient`), so funds can't be locked in the contract.
- **Residual risk:** None.

#### Token substitution

- **Attack:** Settling in another token the payer holds or has approved.
- **Mitigation:** `token` is the first signed argument, and the `approve` sub-invocation names the
  same token. A changed token fails auth (0004).
- **Residual risk:** None.

#### Ceiling or window tampering

- **Attack:** Raising `max_amount`, moving `valid_after` or `deadline`, or extending the allowance.
- **Mitigation:** All are signed, `allowance_expiration_ledger` through the `approve`
  sub-invocation. A changed ceiling or nonce fails auth (0004). The facilitator also checks
  `signatureExpirationLedger == allowance_expiration_ledger` and the `maxTimeoutSeconds` bounds.
- **Residual risk:** None.

#### Leftover allowance

- **Attack:** After settling `actual < max`, the proxy still holds `max - actual` of allowance from
  the payer until `allowance_expiration_ledger`; after a zero settlement, the full ceiling. 0004
  measured 750,000 left after settling 250,000 of a 1,000,000 ceiling.
- **Mitigation:** Only the proxy is the spender, and it calls `transfer_from` only inside
  `settle_upto`, after a new client signature, an unused nonce and the facilitator's authorization.
  The next settlement's `approve` overwrites the value. The allowance expires with the ledger the
  client signed, at most about `maxTimeoutSeconds` ahead.
- **Residual risk:** A wallet or explorer shows an open allowance to the proxy for a few minutes. A
  non-SAC token that ignores allowance expiry keeps it longer, still spendable only by the proxy
  under a fresh signature.

#### Malicious or non-standard token

- **Attack:** A token contract re-enters the proxy, lies in events, charges transfer fees or ignores
  expiry.
- **Mitigation:** Soroban forbids re-entry, and the nonce is written before any token call. The
  proxy holds no funds or shared state a token could reach; its only state is nonces keyed by payer.
  The facilitator lists accepted tokens in `/supported` and checks balance changes in the
  settle-time simulation, not only events.
- **Residual risk:** A bad token can only harm the payer and seller who chose it, for example a
  seller receiving less than `actual_amount` from a fee-on-transfer token.

#### Fee griefing

- **Attack:** A client sends payloads that pass `/verify` but fail on chain, for example by moving
  its balance away before settlement, so the facilitator pays fees for failed transactions.
- **Mitigation:** Settlement re-simulates in enforcing mode against current state, and the submitter
  refuses before sending when simulation fails; refused settlements cost nothing (all rejections in
  0004 were caught this way). Spend budgets and breakers per payer and per facilitator ([ADR
  0007](adr/0007-fee-abuse-containment.md)) bound what gets through.
- **Residual risk:** The state can still change between simulation and inclusion (a few seconds),
  and the fee is charged on failure. Bounded by the budgets.

#### Fee inflation by rent

- **Attack:** Payments that create new ledger entries (a recipient's first balance in a token, a
  fresh nonce entry with a long TTL) cost more.
- **Mitigation:** The facilitator computes fees from a fresh simulation and caps them with
  `maxFeeStroops` (250,000 by default, ADR 0007). The nonce TTL is bounded by
  `allowance_expiration_ledger`.
- **Residual risk:** A first payment to a seller costs about 3× a normal one (122,589 stroops in
  0004).

#### Nonce griefing

- **Attack:** A third party consumes a client's nonce to block its payment.
- **Mitigation:** Storing a nonce requires the client's signature and the facilitator's
  authorization. Nonces are keyed per payer, so payers can't collide.
- **Residual risk:** None.

#### Contract bug

- **Attack:** A flaw in the immutable contract.
- **Mitigation:** Small surface (two public functions, I1–I7 tested, 12 hand-made mutations each
  caught by a test in 0003). A fix is a new deployment; facilitators switch through `/supported`,
  and open authorizations expire within minutes. A security review of the contract is planned
  (`docs/security/`).
- **Residual risk:** Until the review, the contract is unaudited. Open authorizations to an old
  address stay settleable there until they expire.

#### No client cancellation

- **Attack:** A client wants to revoke an authorization before its deadline.
- **Mitigation:** Not supported in v1 (decided by okarcz). The window is bounded by
  `maxTimeoutSeconds`, typically 60–300 s.
- **Residual risk:** For long windows, the client can't revoke. Adding `cancel` would need a new
  deployment, so it must be decided before mainnet.

#### Facilitator key rotation

- **Attack:** The facilitator changes its key while authorizations are open.
- **Mitigation:** Authorizations bind the facilitator's address, so only the old address can settle
  them; they expire within the window.
- **Residual risk:** Rotating mid-window drops the open authorizations bound to the old key.

#### Smart-wallet policy

- **Attack:** A policy-based wallet signs `settle_upto` but not the nested `approve`, or the
  reverse.
- **Mitigation:** The client's tree has exactly two contexts; the spec tells wallets to allow both.
- **Residual risk:** Wallets that don't follow it can't pay with `upto`.
