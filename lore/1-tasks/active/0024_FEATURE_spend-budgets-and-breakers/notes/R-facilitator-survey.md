---
title: "How facilitators and fee sponsors handle 0024's issues"
type: research
status: draft
tags: [facilitator, fees, budgets, breakers, x402]
---

# How facilitators and fee sponsors handle 0024's issues

Read on 2026-10-29 from source (shallow clones, read only, nothing built or run) in three groups:
Stellar, EVM, Solana. Hosted services without source are marked [DOCS]. [UNVERIFIED] = not
confirmed from a primary source. Clones were read in a session scratchpad and not kept; the commit table pins every source. This survey
supersedes the facilitator parts of [R-prior-art](R-prior-art.md) and corrects it in four places
(section 4).

Issue IDs: I1 fee budgets · I2 accounting · I3 breakers/reputation · I4 failure attribution ·
I5 parallel spend of one balance · I6 payer authenticity · I7 passes simulation, fails on chain ·
I8 dust and junk tokens · I9 duplicate settlement · I10 limiter-store outage · I11 refusal codes ·
I12 operator safeguards.

## Commits read

| Repo | Commit |
|---|---|
| x402-foundation/x402 (TS/Go/Python; `@x402/stellar` 2.29.0, ours 2.28.0) | `957b1e4738c4c2a57174ad615fb73a9ead6e14ac` |
| OpenZeppelin/relayer-plugin-x402-facilitator | `5783d5493c9760acfc9e678b14738afa96162075` |
| OpenZeppelin/openzeppelin-relayer | `487bfd242a5cf08a3514e24beab1c01b731421b3` |
| OpenZeppelin/relayer-plugin-channels | `c7cf073b20b8217f7e739aafbc6aa6bd42d36b34` |
| qntx/r402 (+ server qntx/facilitator `df756983`) | `dfb1d0c021cab51dadf87ac3ef15044d904c5b20` |
| stellar/launchtube (archived) | `1821ebdd95829e8d023f5291baaa9df424af489d` |
| accensa/x402-facilitator-stellar | `2aafe8d5db5e480844d935233121ec14cd8b3c48` |
| FTHTrading/genesis402-stellar-facilitator | `2029b349d521793620d4f3339ddf57d26c5e1bc3` |
| x402-rs/x402-rs | `e75adda8a0e3cf23db446883ba91b88bbab2fe28` |
| faremeter/faremeter | `68e024e62b2aaafacc9ff2171bf13b0bd4e0cc01` |
| thirdweb-dev/js (x402 client of a hosted facilitator) | `1756aa68d987d097e92eebfa828cb1d4d32961ac` |
| solana-foundation/kora | `bc1f339fee0b08156a558e81be0279b3b7d1c53b` |
| Octane, last upstream commit (in JeffreyJoel/octane-0 history) | `e509ede995ac2d6d6c346f62b063355e27fafcb8` |
| rawgroundbeef/OpenFacilitator | `427a7d100f9d6ce997bad1c9692da47eb5d9e0a7` |
| eth-infinitism/bundler (ERC-4337, contrast only) | `aae77140e5c2b1386d04eaeba2d23fc17a62bd87` |
| CDP, PayAI | [DOCS] |

Smaller Stellar finds, one line each: CodeStrux/aether `a1b6218` (dedup on (network, payer,
nonce) in Postgres), Veridex-Protocol/stellar-facilitator `284551d` (refuses to start under 5 XLM),
pedro-pelicioni/stellarsight `e735eb9`, kunaldrall29/walras `483c893` (upstream only). No Go,
Python or Java port has a Stellar facilitator.

## 1. Headline

- **Nobody has a breaker on payers, tokens or recipients (I3), and nobody attributes on-chain
  failures to a cause and acts on it (I4).** The only working model is the ERC-4337 bundler
  (reputation with decay, blame by AA error prefix).
- **Nobody budgets fees per asset; only genesis402 and PayAI budget per `payTo`; nobody budgets in
  fee units over a rolling window in a shared store.** Real containment elsewhere is identity plus
  price (CDP, PayAI, OZ Channels, Launchtube) or an allowlist (OZ x402, genesis402, Kora, OZ
  Solana, Faremeter).
- **Nobody controls parallel spend of one balance per payer (I5)**, except Octane's 5 s lock
  (non-atomic, timer-based, never released). genesis402 and OZ Relayer serialise *everything* as a
  side effect.
- **Nobody detects a token that skips the payer's auth (I6).** On Stellar, upstream, OZ x402 and
  r402 only check that a signature is present; genesis402 verifies Ed25519 locally for G-accounts.
  On EVM, x402-rs has the same bug class (a non-recovering signature falls back to "EIP-1271" and
  the token decides).
- **Nobody refuses amount 0 in code** (CDP documents an unpublished `amount_too_low`).
- **Fail-closed on a store outage** exists in accensa, Kora (opt-in), genesis402 (nonce store).

## 2. Matrix

"–" = nothing in code.

| | I1 budgets | I2 accounting | I3 | I4 | I5 parallel spend | I6 payer auth | I7 | I8 | I9 dedup | I10 | I12 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **upstream Stellar** | – (hooks only; `beforeSettle` runs before the fee is known, `afterSettle` never sees it) | – | – | on-chain fail and timeout → one code; 2.29 splits send status retryable or not | – | signature present (non-`scvVoid`) + simulation | re-simulates at settle | ceiling only, 0 allowed | – | n/a | ceiling |
| **OZ x402 plugin** | – (README: use Channels' key budget, i.e. one global budget) | – | – | passes the relayer's decoded reason as text | – (plain relayer serialises) | signature present + simulation | re-simulates | **asset allowlist**; ceiling optional, off | – on purpose; replays are paid | n/a | – |
| **OZ Relayer (Stellar)** | – | n/a | – | **decodes outer, inner, op and contract error**; acts only on its own causes | lane gate: one tx per relayer account, in process | simulation | re-simulates under lane | – | n/a | n/a | **`max_fee` and `min_balance` not enforced when the relayer pays** |
| **OZ Channels** | per API key, fixed window, check-then-record | records `maxFee` (bid); timeouts uncharged; lost records dropped | – | logs code; `ONCHAIN_FAILED` | – | **explicit `authMode: enforce`** | one simulation | `LIMITED_CONTRACTS` capacity share | n/a | read fails closed, record fails open | – |
| **r402 (Stellar)** | – | – | – | one code | – | signature present + simulation | re-simulates | ceiling | tx base64, memory, 2 min, never released | n/a | ceiling |
| **Launchtube** | per JWT token, lifetime credits, may go negative | **hold → bid → `feeCharged`; failures charged; timeouts keep the bid** | email alert | TODO in code | – | enforce simulation + auth before == after | one simulation | – | – | n/a | email at 100k errors/h |
| **accensa** | per key or IP, fee/day, fixed windows, check-then-record | ceiling on success, **0 on failure** | RPC-host breaker | – | – (lock keyed on whole payload) | upstream | upstream | – | header or payload hash | **fails closed** (`rate_limit_store_unavailable`) | `/readyz` floor, default 0 |
| **genesis402** | **global + per-`payTo` fee per trailing hour (sliding log) + per-`payTo` count, atomic** under a global mutex, in memory | simulated fee charged at PENDING, failures included; ambiguous at ceiling | – | – | one settlement at a time globally, re-simulation inside | **local Ed25519 over the auth preimage + exact invocation match** (G-accounts only) | re-simulates the rebuilt tx in the lock | **allowlist** (USDC); 0 allowed | (network, payer, nonce) SQLite, claim key, released if never sent | nonce store fails closed | budget 0.5 XLM/h |
| **upstream EVM (TS)** | – | – (revert = terminal, nobody charged) | – | revert text → codes, for reporting only | – (`simulateInSettle` off; viem estimate at send) | strict: ecrecover without code, EIP-1271 with code | estimate at send | any token with code; exact amount; 0 passes | pending store (5 min) for `settlement_pending` only | write fails → non-retryable | receipt timeout |
| **upstream EVM (Go/Python)** | – | – | – | – | **fixed gas, no estimate: every race is broadcast and paid** | as TS | – | as TS | as TS | as TS | Python nonce lock |
| **x402-rs** | – | – | – | – | `balanceOf` re-check + estimate on pending block | **weak: non-recovering sig → "1271", token decides** | estimate (pending) | amount ≥ required | – | n/a | round-robin signers |
| **r402 (EVM)** | – (0.002 ETH funding cap per payment) | – | – | – | re-checks balance and `authorizationState` in settle + pending estimate | strict, by payer code | estimate (pending) | any token with code | atomic reserve `chainId:nonce`, memory, released only if not broadcast | memory only, one replica | refuses funding when underfunded |
| **Faremeter** | – | – | – | – | – (no simulation, no balance check) | `verifyTypedData` | estimate at send | allowlist by construction (USDC) | `authorizationState` read only | n/a | – |
| **CDP** [DOCS] | API key; $0.001/tx after 1,000 free; x402 rate limit unpublished (general v2: 500 writes/10 s, inferred) | billed per on-chain tx | – | `kyt_risk_detected` | – | – | `settle_exact_failed_onchain` | any ERC-20; **`amount_too_low` (value unpublished)** | resend reconciles | – | – |
| **PayAI** [DOCS] | **credits per receiving wallet (`payTo`)**, lifetime, then key | per settled payment, gas-indexed | – | – | – | ? | ? | listed tokens | 409 duplicate, recorded outcome | ? | edge IP limits; 429 + `Retry-After` |
| **upstream SVM** | per-tx CU and price caps only | **three-way outcome**: not broadcast → release; definite on-chain fail → release; unknown → keep + pending record | – | outcome only | – | local Ed25519 for every signer | spec: simulation is "not a security control"; re-sim at settle + post-settle check | exact amount; 0 not refused | `SettlementCache` (msg hash, 120 s) + `PendingSettlementStore` | store write fails → terminal | – |
| **Kora** | per user, **counts txs not lamports**, fixed or lifetime, atomic Lua | **counted before validation, never rolled back** | signer-pool health only | – | – | verified signers | one simulation | allowlists | runtime dedups | `fallback_if_unavailable=false` fails closed (generic error) | balance gauge |
| **Octane** | – (user pays in tokens) | – | – | – | **5 s lock per source account**: set before simulation, not atomic, never released | `serialize()` verifies | one simulation | token allowlist + min fee | sha256 msg, 120 s, memory | n/a | README: float 3–4 h of fees |
| **OpenFacilitator** | – (no price cap) | – | – | – | – | – | **no simulation** | program allowlist | – | n/a | – |
| **OZ Relayer (Solana)** | per-tx `max_allowed_fee_lamports`, **enforced** on relayer-pays | – | – | transient vs permanent | – | fee payer = relayer | simulation | allowlists | – | n/a | **`min_balance` floor per tx** |
| *ERC-4337 bundler* | paymaster deposit vs sum of pending max cost (EREP-010) | prefund `maxCost`, `postOp` actual | seen/included ratio, hourly decay, THROTTLED/BANNED, GREP-040 instant ban | **blame by AA1x/2x/3x prefix** (EREP-015) | one op per sender per bundle; 4 per sender in mempool | – | validation twice; deterministic validation (OP-011) | – | – | – | – |

## 3. Key evidence

Prefixes: UP = x402 @957b1e4, OZX, OZR, OZC, R4 = r402 @dfb1d0c, LT = launchtube @1821ebd,
G4 = genesis402 @2029b34, BN = bundler @aae7714 (full URLs in the commit table).

- **Upstream Stellar auth (I6):** `mechanisms/stellar/src/exact/facilitator/scheme.ts`
  L769-840, `shared.ts` L221-238: "signed" = `signature.switch().name !== "scvVoid"`. r402 same:
  `r402-stellar/src/chain/xdr.rs` L391-396. OZ x402: `src/stellar/utils.ts` L189-197.
- **Upstream core hooks can't see the fee:** `core/src/facilitator/x402Facilitator.ts` L385-391
  (`beforeSettle` before scheme settle), L431-439 (`afterSettle` gets no fee).
- **OZ Relayer Stellar `max_fee` only on user-pays:** `validate_max_fee` callers are only in
  `domain/relayer/stellar/gas_abstraction.rs` (L306, L422, L636, L797), all behind
  `fee_payment_strategy: User`; relayer-pays path `prepare/operations.rs` L41-104 has no cap.
  `min_balance` on Stellar: `stellar_relayer.rs` L782-784 returns `Ok(())`.
- **OZ Relayer failure decoding (I4):** `status.rs` L338-410 (`first_failing_op` L654,
  `extract_contract_error` L705). Lane gate (I5): `lane_gate.rs` L1-35, held prepare → final.
- **OZ Channels budget:** `fee-tracking.ts` L63-112 (check, then locked record with
  `onBusy:'skip'`); `submit.ts` L95-99, L134-138, L171-174 record `maxFee`, L187-195 timeouts not
  recorded. Enforce mode: `simulation.ts` L71-72.
- **Launchtube accounting:** `launch.ts` L94-96 (eager hold 100,000 stroops), L306-330 (bid, then
  `feeCharged` on failure and success); `credits.ts` L3-6, L35-53 (can go negative).
- **accensa:** `rate-limit.js` L11-23, L155-179 (fail closed), L275-283 (check-then-record);
  `app.js` L823-828 (`sponsoredFee = result.success ? ceiling : 0`).
- **genesis402:** `facilitator.ts` L33, L61-79, L105-126, L309-323 (budgets, mutex, sliding log),
  L324-329 and L386-390 (charging), L526-560 (re-simulation in lock); `verify.ts` L157-196 (local
  Ed25519 + invocation match), L76 (amount `/^\d+$/`, 0 allowed); `nonce-store.ts` L59-96.
- **Upstream SVM three-way outcome (I2):** `mechanisms/svm/src/exact/facilitator/scheme.ts`
  L486-498, L546-591; spec `scheme_exact_svm.md` L359-361 ("simulation is a fee-saving and
  viability check").
- **Kora never rolls back usage:** `rpc_server/method/sign_and_send_transaction.rs` L73-84
  (increment before validation); grep for `decr|rollback|refund|release` in `usage_limit/` is
  empty. Atomic Lua: `usage_store.rs` L70-91. Fail closed: `usage_tracker.rs` L311-356.
- **Octane lock:** `packages/core/src/actions/signIfTokenFeePaid.ts` L35-70 @ `e509ede`.
- **x402-rs signature fallback:** `crates/chains/x402-chain-eip155/src/v1_eip155_exact/facilitator.rs`
  L526-560, L812-835.
- **Upstream Go/Python fixed gas:** `python/x402/mechanisms/evm/signers.py` L34, L533-539;
  `examples/go/facilitator/basic/signer.go` L259-276.
- **Bundler blame and reputation:** `BundleManager.ts` L273-288 (blame by prefix), L323-372 (one
  op per sender); `ReputationManager.ts` L138-193. Two bugs in the reference: `DepositManager.ts`
  L39 subtracts the incoming op each pass; `ReputationManager.ts` L79 decays `opsIncluded` from
  `opsSeen`.
- **CDP [DOCS]:** facilitator (API key, $0.001/tx), troubleshooting (`amount_too_low`,
  `kyt_risk_detected` not retryable, `settle_exact_failed_onchain`), settlement-pending (resend
  reconciles). **PayAI [DOCS]:** pricing (credits per receiving wallet), capacity-and-limits (429 +
  `Retry-After`, 409, pending).

## 4. Corrections to F-prior-art

1. OZ Relayer Stellar policy `max_fee` is **not** applied when the relayer pays; `min_balance` on
   Stellar is a no-op (F listed it as a floor).
2. Kora usage is counted **before validation and never rolled back** (F: unverified).
3. F read a modified Octane fork HEAD; the faithful source is `e509ede`. Its lock is set before
   simulation, never released, not atomic.
4. OZ Relayer Solana `max_allowed_fee_lamports` **is** enforced on the relayer-pays path.
5. CDP x402 rate limit: not documented separately; general v2 limit (500 writes/10 s) inferred.

## 5. Best seen per issue, and what 0024 does better

| Issue | Best seen | Its weakness | 0024 |
|---|---|---|---|
| I1 budgets | genesis402: global + per-`payTo`, sliding hour, atomic | memory, global mutex, no payer or asset scope | Global, payer, `payTo`, asset (SAC / wasm tier, plus one cap for all wasm), in stroops, rolling, atomic across scopes in Postgres |
| I2 accounting | Launchtube hold → `feeCharged`; upstream SVM three-way outcome | Launchtube can go negative; SVM tracks no money | Reserve the ceiling after verification, commit `feeCharged` on success and failure, keep on unknown until reconciled, release only when nothing was submitted; one resolution, kept `released` row |
| I3 breakers | ERC-7562 reputation (bundler) | needs volume; reference has a decay bug | Breakers on attributed scopes only, failure rate with minimum volume, backoff on reopen; never a refusing breaker on a SAC asset or a third party |
| I4 attribution | OZ Relayer decoding; bundler blame by prefix | OZ blames nobody | Keep the Soroban op result and contract error in the record; route: ours → alert, payer, `payTo`, wasm asset |
| I5 parallel spend | Octane 5 s source lock; bundler one op per sender | not atomic, timer, memory | One non-final settlement per (network, payer, asset), enforced in Postgres in `claim`, held until final, released at once on refusal |
| I6 payer auth | genesis402 local Ed25519; upstream EVM strict by payer code | G-accounts only | Payer's nonce key must be in the simulation's read-write footprint: proven by the host, G and C payers, SAC and wasm |
| I7 sim ok, chain fails | upstream SVM: re-sim + post-settle check; r402 re-check in settle | nobody reacts to the failures that remain | Re-simulation in the pool already; plus attribution and payer breaker for `__check_auth` failures (which Solana gets free and Soroban doesn't) |
| I8 dust/junk | allowlists; CDP `amount_too_low` | allowlist contradicts ADR 0007; CDP value unpublished | Refuse amount 0 (and optionally a configured minimum) with its own code; tiers instead of an allowlist |
| I9 dedup | genesis402 / aether (network, payer, nonce) | SQLite single host | Already have (network, payer, nonce) in Postgres |
| I10 store outage | accensa fails closed with its own code | – | Fail closed with `settle_exact_stellar_spend_store_unavailable` |
| I11 codes | PayAI table (429 + `Retry-After`, 409, pending); upstream 2.29 `extra.retryable` | docs only | One code per budget kind, breaker and busy; retryability stated per code in the README |
| I12 operator | OZ Solana per-tx floor; Veridex start-up floor; Octane float rule | none combine floor + budget | Global budget ≤ float; refuse below a balance floor at settle time; alert at 80 % |
