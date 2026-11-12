# Threat model

Written so far: the `upto` contract, `/verify` RPC failover, auth-entry expiry, settlement fees
(what `/settle` can cost the facilitator: spend budgets, breakers, fee griefing with failed
transactions) and the facilitator key. Planned: catalog integrity, auth-entry validation, SSRF in
Bazaar metadata, API key abuse.

## `upto` contract

Scope: `contracts/upto-proxy` ([README](../contracts/upto-proxy/README.md),
[ADR 0010](adr/0010-upto-proxy-design.md)) and the facilitator rules it relies on. The facilitator
itself is covered separately.

### Assets and trust

- **The payer's tokens.** The client authorizes up to `max_amount` of one token, to one
  recipient, with one receiver authorizer, within a time window.
- **The seller's payment.** The seller serves first. In self-managed mode it signs the actual
  amount itself; in facilitator-delegated mode it relies on the facilitator to settle the amount
  it asks for.
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
- **Mitigation:** The client signs `receiver_authorizer`, and the contract calls
  `receiver_authorizer.require_auth()`; that authorization covers `actual_amount`. Without the
  receiver authorizer's signature, a submitter fails with `Error(Auth, InvalidAction)` (spike S5,
  and the e2e "different facilitator" scenario). Another facilitator that rewrites
  `receiver_authorizer` to itself breaks the client's signature (e2e tampering scenario).
- **Residual risk:** None found.

#### Replay of a signed entry

- **Attack:** Submitting the same signed entry a second time.
- **Mitigation:** Soroban makes each auth entry single-use: `Error(Auth, ExistingValue)`. This is
  the only single-use check; the contract stores no nonce of its own (ADR 0010, D6). Shown on
  testnet in 0004 and again on 2026-11-12. A zero settlement never reaches the chain, so the
  facilitator records `(from, auth nonce)` for it and refuses the entry afterwards (spec §8.1).
- **Residual risk:** None.

#### Reuse of a payment ID

- **Attack:** A client signs two entries with the same x402 `nonce`.
- **Mitigation:** None needed: `nonce` is only a payment ID, and two signed entries are two
  payments the client authorized. Both settle (e2e, 2026-11-12). Until 2026-11-12 the contract
  stored the nonce and refused the second with `NonceUsed`, which left a second seller who had
  already served unpaid.
- **Residual risk:** An indexer or seller that treats `nonce` as unique sees two settlements under
  one ID. Use the transaction hash, or `(from, auth nonce)`, as the unique key.

#### Receiver authorizer key

- **Attack:** In self-managed mode the resource server holds a hot key that authorizes the actual
  amount. Someone who steals it authorizes charges on open authorizations.
- **Mitigation:** The key can only authorize `settle_upto` calls the client already signed: the
  money goes to the signed `payTo`, at most the signed ceiling, within the signed window. It holds
  no funds. In facilitator-delegated mode the facilitator holds this authority instead, and the
  server trusts it to charge only the amount asked for.
- **Residual risk:** A stolen key can charge every open authorization up to its ceiling, to the
  seller's own `payTo`. The exposure is the same as a dishonest seller's (see the trust note
  above), bounded by the ceilings and windows.

#### Blind signing by the client

- **Attack:** The client gets its entry from a simulation run by an RPC or a facilitator it
  doesn't control. A lying simulation returns a different tree, for example a plain
  `token.transfer` of the payer's balance, and a client that signs whatever came back authorizes
  it.
- **Mitigation:** The client compares the simulated tree with the one it builds from the payment
  terms and refuses to sign anything else, or builds the entry from the terms without simulation
  (README, "Getting the entry from simulation"). The e2e client does this (`signSimulatedEntry`),
  and the "client refuses a simulated tree" scenario checks it; the `@x402/stellar` client classes
  (0034) must do the same.
- **Residual risk:** None, for a client that checks.

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
  `settle_upto`, after a new client signature and the receiver authorizer's authorization.
  The next settlement's `approve` overwrites the value. The allowance expires with the ledger the
  client signed, at most about `maxTimeoutSeconds` ahead.
- **Residual risk:** A wallet or explorer shows an open allowance to the proxy for a few minutes. A
  non-SAC token that ignores allowance expiry keeps it longer, still spendable only by the proxy
  under a fresh signature.

#### Malicious or non-standard token

- **Attack:** A token contract re-enters the proxy, lies in events, charges transfer fees or ignores
  expiry.
- **Mitigation:** Soroban forbids re-entry. The proxy holds no funds and stores no contract data a
  token could reach.
  The facilitator lists accepted tokens in `/supported` and checks balance changes in the
  settle-time simulation, not only events.
- **Residual risk:** A bad token can only harm the payer and seller who chose it, for example a
  seller receiving less than `actual_amount` from a fee-on-transfer token.

#### Seller not paid

- **Attack:** In `upto` the seller serves before settlement, so a client can receive the service
  and then make the settlement fail: move its balance away between `/verify` and `/settle`, or
  revoke its allowance to the proxy.
- **Mitigation:** Short windows (`maxTimeoutSeconds`) and settling soon after serving. At settle,
  the facilitator re-simulates against current state, which shows a balance below the actual
  amount, and refuses before sending, so it pays no fee. Sellers can settle per request or in
  small ceilings, and refuse payers whose settlements failed.
- **Residual risk:** This is the credit risk of `upto` on every network: the seller is exposed to
  at most one ceiling per open authorization. The protocol can't prevent it; sellers price it in
  through the ceiling and the window.

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

- **Attack:** Payments that create ledger entries (a recipient's first balance in a token, a
  client's first allowance entry, a host nonce entry with a long TTL) or extend an entry's TTL (a token
  instance whose TTL runs low, or the proxy's own instance and code) pay rent on top of the normal
  fee. A payment that touches an archived entry (the token's instance or code, a non-SAC balance,
  a C-account's SAC balance) restores it and pays its restore rent in the same fee: 0021's testnet
  run measured resource fees of 342,189 and 551,787 stroops with archived entries, against 14,278
  for live USDC.
  The payer picks `allowance_expiration_ledger`, and the facilitator pays temporary rent on the
  token's allowance entry until then: in the unit test
  `a_far_allowance_expiration_costs_the_facilitator_rent`, the furthest expiry the network allows
  costs about 14 million stroops more than one 12 ledgers ahead. The host also keeps a nonce
  entry for the client's signature until `signatureExpirationLedger`, which the payer picks too
  and the contract never sees; in self-managed mode the same holds for the server's entry and its
  `signatureExpirationLedger`. Over the fee ceiling, the settlement is refused after the seller
  has served; under it, every settlement can be made to cost up to the ceiling.
- **Mitigation:** The facilitator computes fees from a fresh simulation and caps them with
  `maxFeeStroops` (250,000 by default, ADR 0007). At verify it refuses an
  `allowance_expiration_ledger` beyond the payment window and a `signatureExpirationLedger` that
  differs from it (README, Verify step 2), and in self-managed mode a server entry whose
  `signatureExpirationLedger` is past the client's. The second check is the only bound on the signature
  nonce's rent, so it is required, not defence in depth; the facilitator's `/verify` for `upto` is task 0015, and until
  then the rule is enforced only by the e2e suite's `checkClientAuth`. The contract refuses an
  expiry more than 17,280 ledgers (about a day) ahead, so even a facilitator that skips the check
  pays at most about 25,000 stroops of it (ADR 0010, D11). The proxy's own extension
  is capped at 720 ledgers per settlement, about 149,000 stroops on testnet (ADR 0010, D10).
  For `exact`, restore rent is rent too: over the ceiling the payment is refused, and when its
  transaction lists the archived entries the refusal's message names them, so anyone can restore
  them from their own account and pay again (task 0066); under the ceiling the facilitator pays it.
  The list comes from the buyer's transaction and is not checked against the chain.
- **Residual risk:** Rent depends on the entry's size and the length of the extension, so there
  is no fixed bound. When the token extends its own instance in the same settlement as the
  proxy's extension, the total goes over the default ceiling, and a valid payment is refused
  before sending. Measured on testnet: 330,032 stroops for a SAC instance extended by 54,689
  ledgers, the proxy and code by 720, and an expiry at the cap. Up to about 480,000 is possible for
  a SAC instance close to expiry (extrapolated). Task 0015 raises the `upto` ceiling and keeps the
  accepted tokens' instances alive outside settlements. A settlement that pays it can cost several times a normal one; the
  [testnet report](upto-proxy-testnet-report.md#known-limits) has the measured case.

#### Nonce griefing

- **Attack:** A third party consumes a client's auth nonce to block its payment.
- **Mitigation:** Consuming it requires the client's signed entry and the receiver authorizer's
  authorization. Host nonces are keyed per address, so payers can't collide.
- **Residual risk:** None.

#### Proxy archived

- **Attack:** Not an attack: the proxy's instance and WASM entries are persistent and expire when
  their TTL runs out.
- **Mitigation:** The deploy script extends both to the network's maximum TTL (about 180 days),
  and every successful settlement extends them toward 30 days, at most 720 ledgers (about an
  hour) at a time (task 0035, ADR 0010 D10). The 0035 testnet run ended with both at the maximum.
- **Residual risk:** A deployment with fewer than about one settlement an hour runs down after
  the deploy-time extension, about 180 days; its operator must extend it again. If it is archived
  anyway, anyone can restore it, and a settlement restores it by itself at extra cost, possibly
  above `maxFeeStroops`. Open authorizations are bound to the address, so a new deployment can't
  settle them.

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
- **Mitigation:** Authorizations bind the facilitator's address, not its key. A G-account can
  rotate signers and keep its address: add the new key as a signer, remove the old one. Open
  authorizations stay valid. The channel accounts must get the same change, since the facilitator
  key is their only signer: add the new key to each channel before removing the old one.
- **Residual risk:** Only an address change drops open authorizations, and they expire within the
  window. A careless rotation that removes the old key from a channel before adding the new one
  locks that channel.

#### Smart-wallet policy

- **Attack:** A policy-based wallet signs `settle_upto` but not the nested `approve`, or the
  reverse.
- **Mitigation:** The client's tree has exactly two contexts; the spec tells wallets to allow both.
- **Residual risk:** Wallets that don't follow it can't pay with `upto`.

## `/verify` RPC failover

Scope: upstream verify's failover across `RPC_URLS` (spine AD-3, task 0045).

### Threats

#### RPC steering

- **Attack:** A client moves every user's `/verify`, `/settle` and pool traffic to a fallback RPC:
  it exhausts `RPC_URLS[0]`'s per-key quota until it answers 429. Upstream reports that as
  `unexpected_verify_error`, which moves nothing, but the shared client's next read (the AD-22
  ledger read, a fee-stats read) fails there and moves every caller (0045 decision 21). Keeping
  traffic there needs only to keep `RPC_URLS[0]` failing.
- **Mitigation:** Calls return to `RPC_URLS[0]` only when a probe (`getLatestLedger`, no client
  payload) finds it healthy and at most 2 ledgers behind, so no payload can bring it back early or
  keep traffic away once it answers. A failure of a fallback doesn't bring it back either: calls go
  to the next fallback, or stay and probe at once (0045 decision 26). A verify call never moves the
  shared URL on an answer, and an
  odd payload's `unexpected_verify_error` doesn't move it either (0045 decision 22). A client's own
  verdict can't be chosen this way: a rejection is never failed over.
- **Residual risk:** Until the rate limit (0023), anyone can spend `RPC_URLS[0]`'s quota, and
  traffic stays on the fallback while they do. Each probe interval then costs one probe, not a
  user request. The trustline lookup (0078) adds to that: it runs on the shared client after
  upstream's `simulation_failed`, so a client can trigger it, and with `RPC_URLS[0]` at its quota
  its failed read moves every caller sooner. A payload needs the payer's one auth entry to reach
  it, so one without costs upstream's 1 call; one with a junk entry costs 2, and only a real `#13`
  costs the 3rd.

#### Lagging RPC answers

- **Attack:** A fallback RPC that trails the network by a few ledgers answers `/verify`. Besides
  rejecting valid payments, it can accept a payment the first URL would refuse: a replay whose
  nonce is used on chain but not yet on that RPC, a balance spent since its ledger, a revoked SAC
  authorization.
- **Mitigation:** For `exact`, `/verify` is advisory: `/settle` simulates again through
  `FallbackRpc` before it submits, and AD-6 refuses a nonce already used. The probe only returns to
  `RPC_URLS[0]` when it isn't lagging, and `verified` names the URL that answered, so false answers
  can be traced to it.
- **Residual risk:** A seller that serves on `/verify`'s answer alone, without `/settle`, can serve
  a payment that never settles. For `upto` (0015) `/verify` carries more weight, so its rules must
  not rely on a single RPC's view.

## Auth-entry expiry

Scope: the `exact` payer's auth entry and how long it stays landable (spine AD-6, AD-22, task 0073).

### Threats

#### An extra auth entry hides the payer's expiry

- **Attack:** A seller adds a second signed auth entry from an account it controls, valid for 60
  ledgers, next to the payer's entry signed for days. Upstream accepts it, and an expiry check
  that reads the earliest entry sees 60, so the payer's signature stays landable for days, and a
  "sign a new payment" answer given once the extra entry expires invites a second payment.
- **Mitigation:** `/verify` and `/settle` refuse any address-credential entry that isn't the
  payer's (`…_payer_auth_entries`, 0073 decision 21), so every expiry the facilitator reads is
  the payer's.
- **Residual risk:** None known.

#### A refused payment settles after its payer signed again

- **Attack:** A payment P1 is refused before the claim, which records nothing. The seller has its
  payer sign P2, which settles. P1 is then sent again, by a seller retrying with backoff or by
  anyone holding it, once the reason it was refused no longer holds, and settles too.
- **Mitigation:** A resource asking for more than the cap fits is refused on its
  `maxTimeoutSeconds`, which doesn't change over time, so the same request stays refused (0073
  decision 22).
- **Residual risk:** A sender who edits `maxTimeoutSeconds` gets P1 through; it holds P1, so it
  could submit it on chain without us anyway. A 300 s payment signed at 4 s ledgers is refused by
  the ledger gap and can pass later. `invalid_exact_stellar_payload_fee_exceeds_maximum` has the
  same path once fees drop (0086).

#### A payment ended after its claim settles after its payer signed again

- **Attack:** A payment P1 ends after the claim: a refusal by the pool or a spend limit, or a
  transaction that failed or was refused, which doesn't use the auth entry's nonce. An answer of
  "sign a new payment" has the payer sign P2, which settles. Whoever holds P1 then lands it before
  its auth entry expires, through another facilitator or directly on chain.
- **Mitigation:** Every such answer names the expiration ledger and says to sign again only once
  it has closed (0082).
- **Residual risk:** The answer only guides the client: nothing stops P1 landing, so a client that
  signs early can still pay twice. A record claimed before 0073 keeps its old answer, and a release
  from before 0082, during a deploy or after a rollback, answers without the wait. MCP agents get
  no ledger, since it would come through the seller; they are told not to pay again without
  checking.

## Settlement fees

Scope: what `/settle` for `exact` can cost the facilitator, which pays every fee (AD-10), and the
spend budgets and breakers that bound it (AD-18, [ADR 0007](adr/0007-fee-abuse-containment.md),
task 0024). `/settle` accepts any SEP-41 token. On testnet it takes no API key; on pubnet it will
require one (0105).

### Threats

#### Parallel spend of one balance

- **Attack:** A payer funded with one payment's `amount` signs N payments with N nonces and sends
  N `/settle` calls at once. Each passes both simulations, N channels submit in one ledger, and
  N−1 fail on chain at our fee. Done to USDC, the failures could also trip a breaker that refuses
  everyone's USDC.
- **Mitigation:** At most one settlement per (network, payer, asset) is in flight, enforced by
  PostgreSQL in the claim and in a reopen (0073), across instances and lease hand-overs. Another
  call waits within the settle budget, then gets `settle_exact_stellar_payer_busy` with nothing
  recorded. The next settlement's simulation sees the previous transfer, so a payment the balance
  no longer covers is refused before anything is sent. Failures count against the payer, never
  against a SAC asset.
- **Residual risk:** A payer that sends its payments one after another pays for its own failures,
  up to its budget. Fan-out from one payer in one asset is serialized, which may slow a buyer
  that pays many sellers at once.

#### A token that skips `require_auth`

- **Attack:** A wasm token whose `transfer` never calls `from.require_auth()`. Upstream checks
  only that the payer's auth entry is signed, and Soroban checks an entry only when `require_auth`
  uses it, so the payment settles with any `from` and any nonce. On testnet it settled with a
  victim as payer who never signed. Per-payer budgets and breakers then bound nothing, and records
  and the catalog carry a payer the attacker picked.
- **Mitigation:** `/settle` requires the payer's nonce key in the settlement simulation's
  read-write footprint, which the host writes only for an auth entry it matched, authenticated and
  found fresh. Without it the settlement is refused before anything is signed
  (`settle_exact_stellar_payer_not_authorized`). It works for G and C payers, SAC and wasm tokens.
- **Residual risk:** `/verify` doesn't run the check, so it accepts such a payment. Only a seller
  paid in its own forged token is fooled, and `/settle` refuses it at no cost.

#### Breaker abuse

- **Attack:** Someone makes a breaker refuse other people's payments: a payer fails a few USDC
  payments on purpose to close USDC for everyone, or pays a competing seller with failing
  payments to close its `payTo`.
- **Mitigation:** Breakers count only included, charged failures, against the party that caused
  them (attribution from the operation result and the host's diagnostic events; an event a
  contract publishes itself is ignored, so a token can't name an error of its choice). A SAC's code
  is the host's, so a SAC asset never has a breaker, and a failure that is ours counts against
  nobody. A failure on the recipient's side of a SAC transfer blames the `payTo` only for a known
  asset and only when the error names it alone; anything else blames the payer, since whoever
  issues a classic asset can wrap it in a SAC and deauthorize any `payTo`. A C-account payer's
  breaker opens on one failure only in its own contract; elsewhere it takes 3, like a G-account's.
  The payer's and the `payTo`'s scopes are split per other asset, so a seller's own token can't
  trip a buyer's USDC scope, nor a junk token a seller's. A wasm token's breaker needs 5 failures
  and at least as many failures as successes.
- **Residual risk:** A wasm token's issuer, or its payers together, can close that token. A
  `payTo` whose own contract fails transfers to it closes itself. Both hurt only that token or
  seller. Each failure still costs us its fee, bounded by the budgets.

#### Payload front-running

- **Attack:** A seller (or anyone the payload reaches) submits the buyer's signed payload itself,
  paying its own fee, before the facilitator does. Our transaction then fails on chain at our fee
  with `Error(Auth, ExistingValue)`: the nonce is used. Charged to the payer, three of them would
  close the buyer's USDC breaker for every seller.
- **Mitigation:** A reused nonce feeds no breaker: the payer signed one payment and it settled.
  The fee still counts against the budgets. The payment itself settled once, so nobody is paid
  twice. The host checks the nonce when the token calls `require_auth`, before a C-account's
  `__check_auth` runs, so the error names the token, never the payer: shown on testnet for a
  `test-wallet` payer in a wasm token and in a SAC (task 0024,
  `apps/facilitator/test/live/results/front-run-testnet.json`).
- **Residual risk:** Each front-run costs us one fee, bounded by the budgets, and costs the
  front-runner its own. A wasm token can raise `Error(Auth, ExistingValue)` itself (a
  `require_auth` of its own on a used entry), so its failures feed no breaker; they stay bounded
  by the budgets. The same error in a C-account payer's own frame can't come from a front-run
  (the token's frame fails first), only from the wallet's own nested auth, so it is blamed on the
  payer like any failure there: its breaker opens at once.

#### Shared budget exhaustion by Sybil self-payments

- **Attack:** Someone pays themself valid 1-unit USDC payments (the value comes back) from many
  cheap addresses. Per-payer and per-`payTo` budgets stop each address, but `asset:USDC`,
  `tier:other` and `global` sum over everyone. At the defaults about 13 payers and 3 `payTo`s
  fill `asset:USDC` in about 17,000 payments. With one payment per payer in flight, 13 payers take
  about two hours; about 50 payers and 50 channels take half an hour.
  The addresses' reserves (about 1.5 XLM each) come back on merge, and about 0.2 payments a second
  keep USDC closed as the window rolls. Every payment succeeds, so no breaker opens. USDC is then
  refused for every seller. `global` stays out of reach while USDC is the only known asset.
- **Mitigation:** The loss stops at the budgets, 25 XLM for USDC and 10 XLM for other tokens per
  window; with no budget the same attack would empty the 100 XLM float. The budgets bound the
  rate, not the sum: kept up for under three days, the attack takes the float to its 5 XLM floor,
  and `/settle` then refuses everyone until a top-up.
  `spend_budget_nearing` fires at 80 % of a shared budget, and the facilitator README has a
  runbook to tell an attack from real traffic.
- **Residual risk:** Accepted on testnet (decided by akot, 2026-10-30): the shared budgets bound
  the loss, not availability. On pubnet `/verify` and `/settle` will require an API key issued
  after Discord sign-in, and a key's settlements count in a budget of its own, not in the shared
  ones (0105, 0106, 0107; akot, 2026-11-03); `stellar:pubnet` is refused until they land. A
  Discord account then plays the part of an address, but only up to its free quota, and all free
  quotas share one budget, so many accounts use up only the free traffic (0107).

#### Targeted `payTo` budget exhaustion

- **Attack:** Someone fills one seller's `payTo` budget so its real payments are refused
  (`settle_exact_stellar_spend_limit_pay_to`) until the window rolls. The budget counts the fee of
  every payment to that seller, whoever pays. In USDC, about 7,000 1-unit payments from a handful
  of cheap payers (each within its own budget) fill its 10 XLM; the units go to the seller. In a
  junk token the attacker issues, the same payments would cost it nothing.
- **Mitigation:** The `payTo` budget is split by tier like the payer's: payments in another token
  count in `payTo:<address>/<token>`, so a junk token fills only that, never the seller's USDC
  budget. The USDC route stays bounded by `asset:USDC` and `global`, and `spend_budget_nearing`
  reports the `payTo` budget at 80 %.
- **Residual risk:** The USDC route is accepted, as Sybil self-payments are: per-party budgets
  bound one address, not one attacker. On pubnet API keys (0105) close it only if the `payTo`
  budget is also kept per caller, one of 0107's decisions.

## Facilitator key

Scope: the facilitator key in OpenBao Transit on the facilitator's Hetzner server
([ADR 0013](adr/0013-facilitator-key-custody.md)). The key signs for every channel and pays fee
bumps (AD-12). It can't move buyers' or sellers' tokens: a theft reaches the fee account's float and
the channels' reserves, about 130 XLM at launch (a 100 XLM float plus ~30 XLM of reserves).

### Threats

#### A bug in the facilitator leaks its memory or environment

- **Attack:** A bug, a crash dump or a debugging session exposes what the facilitator holds.
- **Mitigation:** The facilitator holds an AppRole token allowed `transit/sign/<key>` and the secret
  ID that mints it, never the key. The token expires within 1 hour; the secret ID doesn't.
- **Residual risk:** A leaked secret ID mints new tokens until it is destroyed (runbook, 0026). The
  theft alarm shows a changed signer or money leaving our accounts.

#### Code runs in the facilitator's container

- **Attack:** A bug lets someone run code in the facilitator's container. They read the role ID and
  secret ID from its tmpfs files, mint tokens, and have OpenBao sign any 32-byte hash for that
  network's key, a channel `set_options` included.
- **Mitigation:** None that stops it: nothing checks what OpenBao signs, and the secret ID doesn't
  expire. The theft alarm detects it, the runbook destroys the secret ID, and the float caps the
  loss.
- **Residual risk:** Accepted at today's stakes, as for root on the server: they can also lock us
  out of the channels (0048).

#### Root on the server

- **Attack:** Root, through another service on the shared server or a container escape, copies the
  key from OpenBao's memory, or its disk plus the unseal credential.
- **Mitigation:** None that stops it. The theft alarm (a signer or threshold change on the fee account or
  a channel, or a Horizon effect on them other than a credit or a claimable balance naming them,
  read off the server) and the low-balance alarms catch it; the float caps the loss. The float has no
  upper limit, so the weekly review re-checks that this custody still fits it.
- **Residual risk:** Accepted at today's stakes. The hot key is each account's only signer (0048's
  cold key was declined for now), so a thief can also lock us out of the channels. Upgrades: TPM-bound
  credentials, OpenBao on its own machine, a KMS, and 0048 re-checked before mainnet.

#### A copied disk or snapshot

- **Attack:** Someone copies a Raft snapshot from the Storage Box, or the server's disk.
- **Mitigation:** Snapshots are encrypted by OpenBao and open only with the unseal key, which is kept
  apart from them in AWS Secrets Manager. The Borg repository is encrypted too.
- **Residual risk:** A copy of the whole disk includes the unseal credential in `host` mode; TPM mode
  would bind it to the board.

#### Someone reads the backup set in AWS

- **Attack:** An admin of the AWS account soroban-explorer and prices-api share, or someone who takes
  over such an admin, reads `x402/production/openbao-backup` and, with the read-only Storage Box key
  it holds, copies one snapshot. Together they open OpenBao's data and give the key.
- **Mitigation:** The facilitator's server has no AWS credentials that can read the secret (only
  ADR 0011's logs-and-metrics role), so a break-in there doesn't reach it. People sign in to AWS
  through SSO only. Each restore drill checks the 90-day CloudTrail event history for reads that
  weren't drills; the theft and balance alarms catch a theft.
- **Residual risk:** Accepted at today's stakes, as for root on the server. The account has no
  CloudTrail trail, so the alarm on a read uses the event history, about 15 minutes behind.

#### OpenBao lost or down

- **Attack:** OpenBao's disk dies, or it is sealed, down, or can't write its audit log.
- **Mitigation:** `/settle` fails closed and an alarm fires; `/verify` keeps working. Daily snapshots
  leave the server. The backup set (seal key and key ID, recovery key, Borg passphrase, seal config,
  the read-only Storage Box key) is in AWS Secrets Manager, and a restore drill proves it before mainnet and every quarter.
- **Residual risk:** The key can't be exported and has no cold backup. Losing both the snapshots and
  the backup set, or access to the shared AWS account, loses the fee account and every channel.

## Monitoring

Scope: the metrics and alarms of task 0027 ([ADR 0011](adr/0011-facilitator-hosting.md)): the
facilitator's and the host's metric lines, shipped by the CloudWatch agent with the logging role,
and the two Lambdas off the server, the uptime probe and the check that watches the accounts.

### Threats

#### Root on the server forges metric points

- **Attack:** Root holds the agent's credentials and writes metric lines of its own. A metric
  line's namespace is free text that no IAM condition covers, so it can add points to the
  off-server metrics too, such as a high balance, `ready` at 1 or no mismatch, to hide what the
  check reads. This is untested, but nothing stops it.
- **Mitigation:** Each alarm on an off-server metric uses the statistic a forged point can't hide
  a real one behind: `Minimum` for a balance and for `ready`, `Maximum` for a count. Root can't
  stop the Lambdas from the server, and their silence is read from `AWS/Lambda`.
- **Residual risk:** Forged points can raise false alarms. Metrics the server writes itself, such
  as `fee_charged_stroops`, can be forged or held back; the weekly review sets the fee spend
  against the balance, which comes from off the server.

#### A flood of effects on our accounts

- **Attack:** Anyone can send dust payments or make claimable balances that name our accounts, so
  the check reads many pages, and a real debit sits among them.
- **Mitigation:** Both effects are allowed, and the check pages back to where it last read in
  full, so a debit can't fall off a page. A flood longer than a run's time fails the run, and
  `watch-errors` fires.
- **Residual risk:** A long enough flood keeps the check failing, which shows as an alarm, not as
  silence.

#### A client IP in the shared account's logs

- **Attack:** The `rate_limited` line names the client's IP, and the logs sit in the AWS account
  that soroban-explorer and prices-api share, so every admin there can read 30 days of them.
- **Mitigation:** The line is written only past a rate limit, and it lets anyone with AWS access
  block the address at the edge without a shell on the server.
- **Residual risk:** Accepted on testnet. Looked at again before mainnet, with the retention
  (0038).
