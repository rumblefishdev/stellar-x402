---
title: "SEP-41 / SAC allowance semantics, storage TTL and network limits"
type: research
status: mature
tags: [sep-41, sac, storage, ttl]
links:
  - ../sources/sep-0041.md
history:
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "Verified in soroban-env-host 28.0.2 SAC source, SEP-41 v0.5.2, live network settings"
    spawned_from: ["notes/I-section-6-2-review-findings.md"]
---

# SEP-41 / SAC allowance semantics, storage TTL and network limits

Abbreviations: `sac/` = `soroban-env-host-28.0.2/src/builtin_contracts/stellar_asset_contract/`,
`sdk/` = `soroban-sdk-28.0.0/src/`. SEP-41 is v0.5.2 (Draft), copied in `sources/`.

## SAC `approve(from, spender, amount, live_until_ledger)`

**Validation**
- `amount >= 0`, and `from.require_auth()` is called (`sac/contract.rs:166-167`).
- `live_until <= max_live_until_ledger` must hold for every amount. If `amount > 0`, also
  `live_until >= current seq` (`sac/allowance.rs:44-59`).

**Effect**
- It **overwrites** both the amount and the expiry (`sac/allowance.rs:72-75`). It does not add.
- The allowance lives in **temporary** storage under the key `Allowance{from, spender}`. Its TTL
  is extended to `live_until` when `amount > 0`.
- It emits an `approve` event and does not touch any balance.

## SAC `transfer_from(spender, from, to, amount)`

**Checks, in order**
1. `amount >= 0`.
2. `spender.require_auth()`, which passes automatically when the proxy is the caller.
3. The allowance is at least `amount`. The new allowance is `allowance - amount`, with the **same
   `live_until`** (`sac/allowance.rs:116-158`).
4. The spend balance and receive balance pass their authorization checks.

**Events.** It emits `transfer` normally, `mint` if `from` is the issuer, and `burn` if `to` is
the issuer.

**Zero amount.** `amount = 0` succeeds even without an allowance and **still emits a transfer
event**. It also still requires trustlines. For this reason the proxy skips `transfer_from` when
`actual = 0`.

**Leftover allowance.** When `actual < max`, an allowance of `max - actual` remains until
`live_until`.
- Only the proxy can spend it, and the proxy only does so after a fresh client signature that
  sets its own allowance anyway.
- The spike's unit test showed the leftover. Later settlements overwrite it.
- To reset it to 0 in the same call, the client would have to sign a second `approve` node. That
  is not worth the extra cost; a short `live_until` is enough.

## Trustlines and issuer flags

- G-account `from` and `to` need an **authorized** trustline (`sac/balance.rs:565-575`,
  `835-841`). This applies even when the amount is 0.
- C-address payees have no trustline. If the issuer has AUTH_REQUIRED, they must first be
  authorized with `set_authorized` (`sac/balance.rs:233-245`).
- `approve` needs no trustline.
- Circle USDC (testnet issuer `GBBD47IF…FLA5`): `auth_required: false`, `auth_revocable: true`,
  `auth_clawback_enabled: false`. The issuer can freeze `from` or `to`, and settlement then fails
  cleanly.

## What SEP-41 requires of any token, versus what the SAC does

- **Required wording:** `approve` overwrites. `live_until` cannot be in the past unless the amount
  is 0. An expired allowance counts as 0. `transfer_from` reduces the allowance "without changing
  when it expires", and fails if the allowance or balance is too small.
- **Latitude a custom token has:** event shapes vary (vec or map data, extra topics). SEP-41 is a
  draft, so a token can be buggy or malicious: add to allowances, ignore expiry, charge transfer
  fees.
- **Effect on the design:** the proxy holds no funds and no shared balances. Its only state is
  nonces keyed by `(from, nonce)`. A malicious token can therefore harm only the parties who chose
  to pay in it. Whether to accept a token is the **facilitator's and seller's policy** (the assets
  listed in `/supported`), not a contract allowlist. This is recorded in S-token-scope.

## Soroban storage and TTL

- `extend_ttl(key, threshold, extend_to)` only extends when the current TTL is `<= threshold`.
  For temporary entries, `extend_to > max_ttl` is an **error** (`host/storage.rs:575-631`).
- An expired temporary entry is gone for good. It is read as "absent" and can be created again.
- The SDK exposes `env.storage().max_ttl()` and `env.ledger().max_live_until_ledger()`.

Live network settings, read with `stellar network settings` on 2026-09-30:

| Setting | Testnet | Mainnet |
|---|---|---|
| Protocol | **29** | 28 |
| `max_entry_ttl` | 3,110,400 | 3,110,400 |
| `min_temporary_ttl` | 720 | 17,280 |
| Ledger close target | 5 s | 5 s |

- **Protocol mismatch:** testnet is ahead of mainnet. Our crates are protocol 28. Testnet runs of
  a protocol-28 WASM worked in the spike.
- **SDK test defaults differ from the network** (`max_entry_ttl 6_312_000`, `min_temp 16`,
  `timestamp 0`). Tests must set them explicitly.

## Time sources

- `env.ledger().timestamp()` is the ledger's close time in unix seconds.
- `sequence()` is the number of the ledger being applied. Simulation estimates both from the
  latest ledger, so time windows need some slack.

## Testing APIs (soroban-sdk 28)

**Auth**
- `env.set_auths(&[entries])` checks **real** signatures.
- `mock_auths(&[MockAuth])` enforces an exact tree without signatures. The spike used it.
- `env.auths()` returns the recorded tree.
- To build a real-signature entry: hash the XDR of
  `HashIdPreimage::SorobanAuthorization{WithAddress}` with SHA-256 and sign it with ed25519. A
  G-account's signature is `Vec[Map{public_key, signature}]`, and the account needs an
  `AccountEntry` in the ledger.
- `Address::generate` creates **only C-addresses**, so trustline paths need manual G-account setup.

**Tokens and costs**
- `register_stellar_asset_contract_v2(admin)` also gives access to issuer flags. For a custom
  SEP-41 token, implement `token::TokenInterface`.
- `env.cost_estimate()` replaces the deprecated `env.budget()`.

**Events and errors**
- Use `#[contractevent]`; `env.events().publish` is deprecated.
- Errors use `#[contracterror]` with `#[repr(u32)]`.
- If a function returns `()` and panics with `panic_with_error!`, its `try_` client reports the
  generic `soroban_sdk::Error`. Functions that return `Result<_, Error>` give a typed error.
