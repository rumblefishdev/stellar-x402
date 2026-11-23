---
title: "Fee numbers for the quota and budgets"
type: research
status: mature
tags: [facilitator, fees, budgets, pubnet]
history:
  - date: "2026-11-23"
    status: mature
    who: akot
    note: "Measured on pubnet, read only (agent report): typical settlement, ceiling, rent, XLM price."
---

# Fee numbers for 0107's quota, per-key budget and `global`

Research for 0107, 2026-11-23. Read-only: nothing sent, nothing signed. Labels: **M** measured,
**D** derived from measured numbers by arithmetic, **E** estimated, **A** assumed. 1 XLM = 10^7
stroops. Pubnet calls were made 12:45–13:06 UTC to `mainnet.sorobanrpc.com`,
`soroban-rpc.mainnet.stellar.gateway.fm`, `rpc.lightsail.network` and `horizon.stellar.org`.
Scripts: [`fee-scan/`](fee-scan/) (`scan-usdc-fees.mjs`, `horizon-fee-account.mjs`, `state-size.mjs`); their
raw output is not kept.

## 1. A typical pubnet settlement

**What the facilitator pays.** The pool re-simulates and signs a fee bump whose fee field is the
simulated `minResourceFee` plus twice the bid: inner tx and bump each pay it (CAP-15)
(`packages/signer-pool/src/submitter.ts:737-745`, `apps/facilitator/src/settlement/fees.ts`
`settlementInclusionFee`). The bid is `INCLUSION_FEE_STROOPS` or the p90 of `getFeeStats`
`sorobanInclusionFee`, clamped to 100–10,000 and cached 30 s (`signer-pool/src/fees.ts:26-37`).
The client's fee is never used. The network charges less than that fee field: the non-refundable
resources, the refundable part actually used (rent, events), and an inclusion fee at the ledger's
price. With no surge that price is 100 per operation, so 200 under a fee bump.

**Fee market now (M, `getFeeStats`, 12:45 UTC, 3 RPCs agree, ledger 65,630,380):** Soroban
inclusion fee min 100, p10–p99 **200**, max 200 (7,006 txs over 50 ledgers). Our bid today = 200,
the fee field = resource + 400, inclusion charged = 200.

**Real pubnet transactions of the x402 `exact` shape (M).** A fee bump, a different inner source,
one `transfer` on the USDC SAC (`CCW67T…MI75`), and the payer's address-credential auth entry.
Found through `getEvents` on the USDC SAC, then all 1,000 Horizon transactions of the fee account
`GA5SXM…IF3M`, 2026-11-09 → 2026-11-23, with `fee_charged` and the decoded envelopes.

| Payment (x402 shape unless noted)                    |   n | Fee charged (stroops) | Breakdown (one tx, RPC meta)                                       |
| ---------------------------------------------------- | --: | --------------------- | ------------------------------------------------------------------ |
| USDC G→G, both trustlines (`72cba04c…`)              | 131 | **12,203** (all 12,203–12,205) | non-refundable 9,588 + refundable 2,415 (rent 1,799, the nonce) + inclusion 200; 1.075M instr. |
| USDC self-payment, from = to (`f7d701d1…`; one decoded, the rest share its fee field and instructions) | 861 | 9,906 (≤ 10,008) | non-refundable 7,291 + 2,415 + 200 (one trustline) |
| XLM SAC from a C smart wallet → G (`ee988a85…`)      |   7 | 13,258–13,568          | non-refundable 11,128 + 2,240 (rent 1,771) + 200; 5.4–5.6M instr. (wallet `__check_auth` + a verifier contract) |
| USDC G→C, **source-account auth** (not x402), one relayer `GBVVWA…`, 09:43–13:05 UTC | 240 | 60% ≈ 6,661; 17.5% 7k–20k; 11.7% 20k–92k; **10.8% ≈ 382,150** | the steps are the SAC extending the C balance's TTL (rent 10k–63k), and creating a fresh balance (fee field 443k, charged 382k) |

What the repo had before, and why it differs:

| Figure | Source | What it is |
| --- | --- | --- |
| 41,200 "typical exact" | ADR 0013:206-207 (from ADR 0003) | the testnet upto/proxy era (0007's runs, 41,000–43,900); not today's `exact` transfer (0093) |
| 14,278 | 0066 README:46-48, threat model:175 | testnet `minResourceFee` (the fee field, not the charge), live USDC |
| 12,040 / 11,328 | `lore/3-wiki/R-pubnet-new-balance-rent.md` table | pubnet `minResourceFee`, payer as source, so no auth entry: G→G / C with a balance |
| 10,493 | 0093:57-60 | testnet charge, native XLM `transfer`, our channel shape |

**Pick (M): f_typ = 12,203 stroops = 0.00122 XLM ≈ $0.000156** for USDC G→G, the common seller
shape. A G payer can't raise it: the args are fixed and the nonce's rent is bounded by
`MAX_VALIDITY_LEDGERS` 66 (`config.ts`). The fee field the ceiling check sees is larger,
17,169 + 2 × bid (M, the same txs).

## 2. The most expensive settlement allowed

| What | Where | Bounds |
| --- | --- | --- |
| `MAX_FEE_STROOPS` default 250,000 | `apps/facilitator/src/config.ts:184` | the **whole fee**: the resource fee (rent and restore rent included) + 2 × bid |
| `/verify` | `settlement/upstream.ts:94-95` → `@x402/stellar` 2.31.0 `exact/facilitator/index.mjs:372-374` | refuses `minResourceFee + 2×bid > 250k` (`…_fee_exceeds_maximum`) |
| pool | `signer-pool/src/submitter.ts:369` (default), `:738-745` | the same check before signing; a raised bid is cut to fit, never below the base bid |
| bid limits | `config.ts:300-313`; `signer-pool/src/fees.ts:33` | `2 × INCLUSION_FEE_STROOPS < MAX_FEE`; the fee-stats bid ≤ 10,000 |
| reservation | `spend/policy.ts:205` | every settlement reserves 250k; `onFinal` commits `feeCharged` |
| budgets ≥ ceiling | `config.ts:356-360` | each `SPEND_*_STROOPS` must be ≥ `MAX_FEE_STROOPS` |

The charge is never above the signed fee field, so **one settlement costs at most 250,000 stroops
= 0.025 XLM ≈ $0.0032** (D). What pushes a settlement toward it:

- **A C-address payer with its own `__check_auth`** (E/D from pubnet config, M 12:54–13:00 UTC):
  instructions cost 3 stroops per 10,000. A tx may use 400M, which is 120,000 stroops. Read entries
  cost 781 each (200 max) and write entries 1,250 each (200 max), plus bytes, so a wallet built to
  be expensive reaches the ceiling alone. A real smart wallet costs 13.6k (M, above). The
  attacker pays nothing for this, so the ceiling is the bound that matters.
- **Rent on C-address balances** (M): the SAC extends a balance to 30 days when it is touched with
  less than 29 days left. Observed extensions add 10k–63k (up to 91.5k in total). A full 30-day
  extension is about 107k (D: 430k ÷ 4, wiki). A C payer and a C payTo can both extend in one
  settlement: ≈ 12k + 2 × 107k ≈ 226k (E), under the ceiling.
- **Surge** (D): the bid can rise to 10,000, so up to +20,000 under the bump. Escalation, only if
  `FEE_ESCALATION_*` is set, stops at `max` 1,000 by default (`submitter.ts:365`).
- **Over the ceiling, so refused today:** a fresh `payTo` balance, USDC to a fresh C-address:
  fee field 443,065 (wiki, M 2026-11-05) and 442,991–443,094 here (M), **charged 382,114–382,209**
  (M, n = 26, source-account auth). With x402 auth the fee field is about 446–447k (wiki, D). Any
  archived entry: 442k (C balance) to 928k (SAC instance) (wiki, M). The check runs on the fee
  field, so the 382k such a payment would actually be charged doesn't decide it.

## 3. Today's budgets and the float

Every budget shares one rolling window, `SPEND_WINDOW_MS`, 24 h (`config.ts:252`). Defaults are
the same on testnet and pubnet (`deploy/mainnet.env.example:25-38`, all commented).

| Scope | Var (`config.ts`) | Stroops | XLM / 24 h | At f_typ | At ceiling |
| --- | --- | --: | --: | --: | --: |
| `global` | `SPEND_GLOBAL_STROOPS` :257 | 500,000,000 | 50 | 40,974 | 2,000 |
| `payer:<G/C>` (known assets) | `SPEND_PER_PAYER_STROOPS` :259 | 20,000,000 | 2 | 1,639 | 80 |
| `payTo:<addr>` | `SPEND_PER_PAY_TO_STROOPS` :260 | 100,000,000 | 10 | 8,195 | 400 |
| `asset:<C…>` known (USDC) | `SPEND_PER_ASSET_STROOPS` :262 | 250,000,000 | 25 | 20,487 | 1,000 |
| `asset:<C…>` other | `SPEND_PER_ASSET_OTHER_STROOPS` :264 | 20,000,000 | 2 | — | 80 |
| `tier:other` | `SPEND_TIER_OTHER_STROOPS` :266 | 100,000,000 | 10 | — | 400 |
| floor (refuse below) | `SPEND_FLOOR_STROOPS` :271 | 50,000,000 | 5 | | |

**The float** (ADR 0013:206-218; runbook:892-895): 100 XLM in the fee account, low-balance alarms
at 25 and 10 XLM, the floor at 5 XLM, no upper limit. Top-ups are by hand: on mainnet a withdrawal
from the company's exchange account, by a person to be named before mainnet; never from a key on
the server. A weekly review sets 7 days of `fee_charged_stroops` against the balance and picks the
next refill. 0024's rule for `global` (S-design §5): `global ≤ float − alarm` (100 − 25 = 75), set
at 50. At f_typ the float is ~82,000 settlements, not ADR 0013's ~24,000, which used 41.2k (D).

Notes for 0107. On pubnet every `/settle` carries a key, so once AC 1 takes keyed settlements out
of the asset and tier budgets, those budgets apply only on testnet. A 1-month window keeps rows
for `max(2 × window, 7 d)` (`pruner.ts:24`), about 62 days, if the pruner is given the longest
window.

## 4. XLM/USD (M, 2026-11-23)

| Source | Value | Time (UTC) |
| --- | --- | --- |
| `api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd` | 0.128251 | 12:45:40 (its `last_updated_at`) |
| `api.kraken.com/0/public/Ticker?pair=XLMUSD` | last 0.127998 (24 h 0.1251–0.1292) | 12:46 |
| Horizon `order_book` XLM/USDC (Circle) | bid 0.12798 / ask 0.12813 | 12:46 |

**Used: p = $0.1282 per XLM.** 0024 assumed $0.1–0.3.

## 5. Arithmetic for the defaults

Symbols: Q = quota (1,000 a month, A from 0107); f_typ = 12,203 (M); C = `MAX_FEE_STROOPS`
= 250,000; K = number of free accounts; m = the per-key budget's multiple of typical; W = 24 h.

| Quantity | Formula | Stroops | XLM | USD |
| --- | --- | --: | --: | --: |
| 1,000 typical | Q × f_typ | 12,203,000 | 1.22 | 0.16 |
| 1,000 at the ceiling | Q × C | 250,000,000 | 25 | 3.21 |
| 1,000 fresh C balances, if paid | Q × 447,000 | 447,000,000 | 44.7 | 5.73 |
| proposed per-key budget, m = 4 | B_key = Q × f_typ × m → round | **50,000,000** | **5** | **0.64** |

**Why m ≈ 4 (proposal, E):**
- It covers 1,000 settlements averaging up to 50k. That includes C sellers: source-account C
  traffic averaged ≈ 13k without the fresh balances (D, 214 txs), plus about 2–4k for x402 auth (E).
- It covers the rent tenfold (§6): ≤ 28.4M.
- A key whose settlements all cost the ceiling stops after B_key ÷ C = 200 of them, not 1,000.
- In-flight reservations of 250k each leave room for ~150–200 concurrent settlements.
- It stays ≥ C, as `config.ts:356` requires.
- m = 2 (25M) would refuse honest keys at full quota once the rent rises.
- B_key = Q × C (250M) bounds nothing that the count doesn't.

**K free accounts, per month** (D, at p = $0.1282):

| K | Typical, all at quota: K × Q × f_typ | All at their budget: K × B_key | No fee budget, all at the ceiling: K × Q × C | Typical per day |
| --: | --: | --: | --: | --: |
| 10 | 122M = 12.2 XLM ($1.56) | 500M = 50 XLM ($6.41) | 2.5B = 250 XLM ($32) | 0.41 XLM |
| 100 | 1.22B = 122 XLM ($15.6) | 5B = 500 XLM ($64) | 25B = 2,500 XLM ($320) | 4.07 XLM |
| 1,000 | 12.2B = 1,220 XLM ($156) | 50B = 5,000 XLM ($641) | 250B = 25,000 XLM ($3,205) | 40.7 XLM |

**The shared free budget and `global` (proposal, E).** Neither K × B_key nor the float is a daily
figure, so the bound in W is the shared free budget:
- `B_free(W) = min(global(W) − R_raised(W), h × K_active × u × Q × f_typ / 30)`. R_raised is what
  accounts with a raised limit are guaranteed; u is the average share of the quota used (A,
  unknown, 1 below); h is headroom (A, 3–5).
- `global(W) ≥ B_free(W) + R_raised(W)`, and 0024's rule `global(W) ≤ float − alarm_low` gives
  `float ≥ global(W) + 25 XLM`.
- `float ≥ D_topup × daily spend + alarm_low`, with D_topup the days between manual top-ups.
- The free tier's worst month is `min(K × B_key, 30 × B_free)`.
- **The float and `global` as they are (100 / 50 XLM):** B_free = 25 XLM / 24 h (250M) leaves
  `global` 25 XLM a day for raised accounts. That is 20,487 typical or 1,000 ceiling settlements a
  day, so up to K* = B_free × 30 ÷ (Q × f_typ) ≈ **614 keys at full quota**. The free tier's
  worst month is min(K × 5, 750) XLM.
- **K = 1,000 at full use (40.7 XLM a day):** B_free ≈ 2 × 40.7 ≈ 80 XLM and `global` ≈ 105 XLM,
  so float ≥ 130 XLM by 0024's rule. Weekly top-ups need float ≥ 7 × 40.7 + 25 ≈ 310 XLM (E).
- At K ≤ 100 the current float and `global` hold with room to spare (4 XLM a day, typical).

For 0108: CDP's $0.001 per settlement is 6.4× f_typ ($0.000156) but below the ceiling's cost
($0.0032) (D).

## 6. If rent rises tenfold

Rate per 1 KB = `max(1,000, −17,000 + 27,000 × S / 3 GB)` below the 3 GB target; it grows faster
above it (`sorobanStateRentFeeGrowthFactor` 5,000) (M, config read 12:54 UTC; wiki).

- **Pubnet now (M):** the live Soroban state window averages **1,644,826,608 bytes** (30 samples,
  1.637–1.654 GB). The formula gives −2,197, so the rate sits at the 1,000 floor; it leaves the
  floor at 2.0 GB. Earlier readings: 1.76 GB (11-02) and 1.59 GB (11-05) (wiki). No trend can be
  read from these.
- **Typical G→G (D, upper bound):** only the nonce's rent scales, 1,799 → ≤ 17,990, so ≤ **28,394**
  (×2.3). Part of `rentFeeCharged` is a fixed TTL-write fee, so the real figure is lower. 1,000 of
  them ≤ 28.4M = 2.84 XLM ($0.36), still under a 50M B_key.
- **C-address balances (D):** TTL extensions observed at 10k–63k become 100k–630k, and a full
  30-day extension ~1.07M. Many C-seller and C-payer settlements would then cross the 250k ceiling
  at times. Either they get refused, or the ceiling rises, and with it every reservation and the
  number of ceilings a budget holds.
- **Fresh balance (D, wiki):** ~4.3M = 0.43 XLM ($0.055) each. Sponsoring it at Q would be 4.3B
  (430 XLM) a key, so a fresh balance can't be paid inside a free quota.
- **Ceiling-cost loss is unchanged:** K × B_key and Q × C don't move with rent. Only how many
  honest settlements fit in them does.

## Gaps

- No x402-shape USDC payment **to a C-address** was found. G→C figures are source-account
  transfers from one relayer over 3.4 h; x402 auth adds about 2–4k (E, from G→G vs simulation).
- The pubnet sample is one fee account's traffic, mostly self-payments; 131 real G→G payments.
- u, h, R_raised and the top-up cadence are assumptions for akot.
