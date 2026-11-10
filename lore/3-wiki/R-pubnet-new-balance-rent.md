# Pubnet rent for a payment that creates a balance

A payment whose `payTo` has no balance in the token creates that balance, and the network charges
its rent up front in the resource fee. On pubnet that fee is above the facilitator's
`MAX_FEE_STROOPS` (250,000), so `/verify` refuses such a payment. Whether the facilitator should
pay it is an open question in task 0107. Measured 2026-11-05, read-only simulations, nothing sent.

## Measured fees

`minResourceFee` of a `transfer` of one base unit, `simulateTransaction` with the payer as source,
2026-11-05, nothing sent. Stroops.

| Payment                                                                | pubnet                      | testnet      |
| ---------------------------------------------------------------------- | --------------------------- | ------------ |
| XLM SAC to an existing G-account                                       | 12,061                      | 11,717       |
| XLM SAC to a C-address with a live balance                             | 11,258                      | not measured |
| XLM SAC to a fresh C-address                                           | 442,047                     | 119,874      |
| USDC to a G-account with a trustline                                   | 12,040                      | not measured |
| USDC to a C-address with a live balance                                | 11,328                      | not measured |
| USDC to a fresh C-address                                              | 443,065                     | not measured |
| XLM / USDC to a C-address with an archived balance (6 each)            | 442,893 / 442,963           | not measured |
| A SAC whose instance is archived (5 classic assets)                    | 920,507–928,220             | not measured |
| Wasm tokens, recipient holds a balance (4 tokens, no archived entry)   | 10,706–139,680              | not measured |
| Wasm tokens, fresh G- or C-address (3 tokens, no archived entry)       | 288,160–362,217             | not measured |
| Wasm tokens, fresh address, payer's own balance archived (2 tokens)    | 574,525–582,241             | not measured |
| Wasm tokens with an archived instance (2 tokens, 3–4 archived entries) | 112,339,751 and 341,079,036 | not measured |

- What the table can't show: the wasm tokens are the 5 contract tokens among stellar.expert's first 1,200 assets by rating, and the
  archived-instance wasm tokens are 2 found among 79 candidates. Neither is a sample of all tokens.
- A signed settlement costs more than these. Derived: a fresh USDC balance is about 446–447k, adding
  the auth work (14,278 against 12,097 for live USDC) and the nonce's rent. Not measured: it needs a
  signed payload.
- Simulating with the channel as source overstates by ~113k on both networks (measured, 125,509 and
  556,506 for USDC), because recording mode leaves `signatureExpirationLedger` at 0. A later
  measurement has to sign the auth entry.
- `MAX_FEE_STROOPS` defaults to 250,000 (`apps/facilitator/src/config.ts:184`); the check adds the
  inclusion fee on top (upstream `@x402/stellar` 2.28.0 `exact/facilitator` `_verify`).

## Why testnet hides it

A new entry pays rent up to the longer of the network's minimum persistent TTL and the TTL the
token asks for. Pubnet's minimum is 2,073,600 ledgers (~120 days), testnet's 120,960 (~7 days),
both measured. The SAC extends a balance to 518,400 ledgers (30 days,
`BALANCE_EXTEND_AMOUNT`, rs-soroban-env `stellar_asset_contract/storage_types.rs:8`), so testnet
pays 30 days, not 7. Derived: 2,073,600 / 518,400 = 4, which matches the fees above the ~12k base,
about 430k against 108k. A wasm token's rent depends on its own entry size and TTL.

## Rent can rise about tenfold

Both networks sit today at the floor of 1,000 stroops per KB (`MINIMUM_RENT_WRITE_FEE_PER_1KB`,
rs-soroban-env `fees.rs:17,279`). Their inputs differ: the state size target is 3 GB on pubnet and
7 GB on testnet. Pubnet's rate is `-17,000 + 27,000 × state / 3 GB`, so it leaves the floor at 2.0 GB
and reaches 10,000 at 3 GB. A fresh balance's rent would then be about 4.3 million stroops (derived).

Pubnet's state was 1,760,803,483 bytes on 2026-11-02 and 1,586,693,695 on 2026-11-05, and it rose
about 90 MB/day over the 2.6 hours of the 2026-11-05 window. These readings can't give a rate.

## Who is affected

- A first payment to a C-address seller in a SAC, including USDC; any wasm token's first payment to a
  fresh balance, on G- and C-addresses alike; a restore (0066), which costs the same for a SAC
  balance. USDC to a G-account with a trustline doesn't pay this rent.
- Nobody before pubnet: `config.ts:372` refuses `stellar:pubnet`, and mainnet ships in M2 (ADR 0007).
  The catalog holds no seller yet, so no count of C-address sellers exists.
- A balance's rent isn't strictly once: a quiet C-address balance can be archived, then the next
  payment pays a restore (0066).
- The refusal for a new entry names nothing: `withArchivedEntries` (`verify.ts`) only adds archived
  entries, so upstream's message with the two numbers stays.

## Anyone can create the balance outside the facilitator

A 0-amount `transfer` to a fresh address creates the entry in simulation, at the same fee: USDC to a
C-address (443,065), SolvBTC (339,600 / 347,307), XAUM (354,522 / 362,228). One of the 4 wasm tokens
tried answered a 0-amount transfer without creating an entry, so a holder sends it a small amount
instead. Compare a G-account seller of USDC, who must add a trustline; the facilitator already
refuses without one and says why (0078).

## What a higher ceiling would change

- **Fresh addresses are free.** A payer can send 1 stroop to a new random C-address each time, so
  per-`payTo` budgets don't bound it. Above 450k each such payment costs ~447k, about 31× a typical
  settlement, and the money goes to rent on junk entries. On pubnet the bound is 0107's per-key budget,
  not yet built. Derived: `asset:USDC` (250M) fills after ~559 such payments.
- **Every settlement reserves the ceiling** (`spend/policy.ts:205`), a 14.5k one too.
- **The floor is coupled and unchecked.** `SPEND_FLOOR_STROOPS` (5 XLM) covers "about 1.25 XLM at 50
  channels", that is 50 × 250k (`config.ts:268-271`); no check ties the two.
- **A ceiling close to the fee** can pass `/verify` and fail at the pool, after the seller has served,
  when the bid or rent moves (threat model).
- **0077** runs one process for both networks; there the ceiling, the budgets and the floor would need
  a value per network. Today one process serves one network, so no code is needed for it.
