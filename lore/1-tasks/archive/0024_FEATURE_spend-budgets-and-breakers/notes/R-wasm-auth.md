---
title: "Does an unused payer auth entry let a wasm token forge the payer?"
type: research
status: mature
tags: [facilitator, fees, budgets]
history:
  - date: "2026-10-29"
    status: mature
    who: akot
    note: "Research for the 0024 design (agent report, read only)."
---

# D: Does an unused payer auth entry let a wasm token forge the payer? (0024 open question)

Research only, no code edited. Sources: `@x402/stellar@2.28.0` (installed), `apps/facilitator`,
`packages/signer-pool`, rs-soroban-env `main` (= tag v30.0.0, commit 0c99950), stellar-rpc `main`,
CAP-46-11, CAP-71 (+ -01, -02). Downloaded copies were read in a session
scratchpad and not kept.

## Verdict: the hole HOLDS (source-level; not run on a host)

A wasm SEP-41 token whose `transfer` emits `["transfer", from, to] -> amount` without calling
`from.require_auth()` passes upstream `verify()`, our checker, and the pool's settle simulation with
any `from` (even an address with no account), any nonce, and any non-void `signature` ScVal. The
settlement then **succeeds on chain**, so on-chain-failure breakers never trip.

## 1. What upstream checks (`node_modules/.pnpm/@x402+stellar@2.28.0/.../dist/esm/exact/facilitator/index.mjs`)

- Shape: one `invokeHostFunction` op, `invokeContract` on `requirements.asset`, fn `transfer`, 3 args,
  `to == payTo`, `amount == requirements.amount`, no facilitator as source/payer (lines 293-348).
- Simulation: `server.simulateTransaction(transaction)` with **no authMode** (line 349). stellar-rpc
  `validateAuthMode` (`cmd/stellar-rpc/internal/methods/simulate_transaction.go` ~l.406-435): empty
  authMode = **enforce when the op carries auth entries**, record otherwise. Upstream requires entries,
  so a passing payload is always simulated in enforce mode with the client's own entries.
- Fee ceiling (l.360-370), then events: exactly one contract event, topic0 `transfer`, emitted by
  `requirements.asset`, topics[1]==from, topics[2]==payTo, data==amount (l.445-520). The token
  emits these itself; nothing ties them to a balance change.
- Auth (l.534-585): every entry has address credentials, not a facilitator address, expiration <=
  maxLedger+2, **no sub-invocations**. Then `gatherAuthEntrySignatureStatus` (chunk-HBDJ2YHP.mjs
  l.41-82): an address counts as "signed" iff `signature.switch() !== scvVoid`. Nothing checks the
  signature bytes, the nonce, or that the entry's `rootInvocation` equals the transfer call.
- Ours on top (`apps/facilitator/src/settlement/verify.ts`): no source-account creds, channel check,
  exactly one entry for the payer (nonce = settlement key), expiration window. At `/settle` the pool
  re-simulates with `authMode: "enforce"` (`packages/signer-pool/src/submitter.ts` l.628) and runs
  `expectTransfer` (`apps/facilitator/src/settlement/settle.ts` l.916) — events only again.

## 2. Soroban host semantics (authoritative)

- `AuthorizationManager::new_enforcing` (`soroban-env-host/src/auth.rs` ~l.945) only builds one
  `AccountAuthorizationTracker` per entry; nothing is verified at construction.
- Verification is lazy: `require_auth_enforcing` (~l.1227) -> `maybe_authorize_invocation`
  (~l.2474): if the tracker's root invocation doesn't match the current `require_auth`, return
  `Ok(false)`; only on a match does it run `authenticate()` (signature / `__check_auth`) and then
  `verify_and_consume_nonce` (~l.2586) -> `Host::consume_nonce` (~l.2958).
- No end-of-invocation check for unmatched trackers: `invoke_host_function`
  (`e2e_invoke.rs` ~l.517-545) sets entries, invokes, `try_finish()` (`host.rs` ~l.765) only
  externalizes events/storage. Same for the simulation path (`e2e_invoke.rs` ~l.780).
- Spec, CAP-46-11 "Authorization Payload is Standalone": "the entries have to only be used (i.e.
  consume nonces) when they are actually being used. This way frontrunning someone else's
  authorization entry becomes a no-op". "Nonce Consumption": "Nonce is consumed only for the
  authorization entries that have the root invocation matched to an actual call, have passed
  authentication and don't have an expired signature."
- So an unused entry is **silently ignored**: signature not checked, nonce not read or consumed,
  account need not exist. By design, not a bug.
- Recent protocols: CAP-71 (protocol 27, Final) adds delegated auth and `SOROBAN_CREDENTIALS_ADDRESS_V2`
  (address-bound payload); CAP-71-02: "semantics ... the same as for the existing
  SOROBAN_CREDENTIALS_ADDRESS, with the only difference being the signature payload". No change to
  lazy matching. Host `main` (v30.0.0) still has it.
- SAC contrast: `stellar_asset_contract/contract.rs` `transfer` calls `from.require_auth()?` before
  `spend_balance`; its event has a 4th topic, the SEP-11 asset name (`event.rs` `transfer`). So for a
  SAC the payer's entry is always matched, authenticated (G: `account_contract.rs`
  `check_account_authentication` loads the account and checks weight >= med threshold; C:
  `__check_auth`) and its nonce consumed.

## 3. Consequences for 0024

- Attack cost ~ one wasm deploy; per settlement free. `from`, nonce, `payTo` rotate freely; each
  asset (new instance of the same wasm) absorbs up to the per-asset budget (default
  `SPEND_PER_ASSET_STROOPS` 2,000,000,000 = 200 XLM). Then the global budget refuses every seller.
- Per-payer budget bounds nothing for such tokens, and worse: `from` can be a **real victim's**
  address, so a payer-keyed budget (not keyed by asset) lets the attacker exhaust a victim's USDC
  budget. Records and catalog carry the forged payer.
- Even with auth proven, payer identities on an attacker-controlled asset (any wasm, or a
  self-issued SAC) are cheap: a G payer must exist (create + merge back ~ 2 tx fees), a C payer costs
  a deploy. So per-payer budgets only bound real value on assets the attacker can't mint.

## 4. Mitigations

### M1 (recommended): the payer's nonce key must be in the simulation's read-write footprint
`consume_nonce` writes `ContractData{contract: payer, key: ScVal::LedgerKeyNonce{nonce},
durability: Temporary}`. The simulation runs on a recording footprint, so this key is in
`sim.transactionData` `resources.footprint.readWrite` **iff** the payer's entry was matched,
authenticated and its nonce was fresh. A contract can't fake it: `ScVal::LedgerKeyNonce` can't be a
guest `Val` (`soroban-env-common/src/val.rs` ~l.626; `host/conversion.rs` ~l.656) and a contract
writes only under its own address. Works for G and C payers, SAC and wasm, credentials v1/v2.
- `/settle`: add to `expectTransfer` (the pool's enforce sim is already there): **zero extra RPC**,
  refuses before signing, so no fee. Budget reservation made before `submit()` is released.
- `/verify`: upstream's sim is TS-private (`_verify` returns `simResponse`); either call it through a
  cast (private API, breaks on upgrade), or one own enforce `simulateTransaction` (1 extra RPC), or
  leave `/verify` as is (costs us nothing on chain).

### M2: verify the payer's signature ourselves
ed25519 over `HashIdPreimage` (SorobanAuthorization or ...WithAddress for v2) with the G key: local,
but misses multisig/threshold, C accounts, nonce freshness, and still lets the token skip
`require_auth` (attribution only). Dominated by M1.

### M3: recording-mode re-simulation
`authMode: "record"` and require a recorded entry for `from` rooted at this transfer. 1 extra RPC,
same information as M1.

### M4: asset kind (SAC vs wasm)
- Local, zero RPC, proof-grade: a SAC's contract ID is `hash(ContractIdPreimage::FromAsset)`, which
  no wasm can occupy. Compare `requirements.asset` to `Asset.contractId(passphrase)` for configured
  assets (USDC, `Asset.native()`), or for the asset named in the SAC event's 4th topic (only
  available where the sim is: the pool's `checkSimulation`).
- Generic: `getLedgerEntries` of the instance key (`ScVal::LedgerKeyContractInstance`, persistent)
  -> `ContractExecutable` type. 1 RPC per new asset, cacheable forever (a SAC stays a SAC; a wasm
  contract can update its wasm but never become a SAC). Reuses the `getLedgerEntries` path in
  `channel-check.ts`.
- On its own it doesn't close the hole for wasm; it is the input for tiering.

## 5. Recommendation for 0024 budgets

1. M1 at `/settle` regardless of tiering: it removes payer forgery and victim impersonation for all
   tokens at no RPC cost. Then per-payer keys are real (authenticated) addresses.
2. Tier budgets by asset kind, with the kind from M4 (configured SAC IDs computed locally, everything
   else via one cached instance read before reservation):
   - SAC: normal per-payer / per-payTo / per-asset limits.
   - wasm: low per-asset and per-payTo defaults, and a **separate global sub-budget** for wasm, so
     exhausting it refuses only wasm sellers, not USDC ones.
   - Optionally treat SACs outside a configured "known issuer" list like wasm for the global
     sub-budget: a self-issued SAC is honest about auth but as mintable as a wasm token. This is a
     budget tier, not an acceptance allowlist, so ADR 0007's "no allowlist" stands.
3. Key per-payer budgets by `(payer, tier)` at least, so spending on cheap assets can't use up a
   payer's budget for real ones.
4. Pin with a test: a mock wasm `transfer` that emits the event without `require_auth` must be
   refused at `/settle` (needs a local Soroban host or testnet deploy; not done here).
