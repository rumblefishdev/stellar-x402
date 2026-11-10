---
id: "0035"
title: "Keep the UptoProxy instance and WASM alive: TTL extension"
type: FEATURE
status: completed
milestone: 1
related_adr: ["0010"]
related_tasks: ["0005", "0004", "0034", "0026", "0015", "0027"]
tags: [upto, contract, deploy, priority-medium, effort-medium, payments]
links:
  - ../../../contracts/upto-proxy/README.md
  - ../../../docs/threat-model.md
history:
  - date: "2026-10-09"
    status: backlog
    who: claude
    note: "Spawned from 0005 future work (PR #12 review, Stan)."
  - date: "2026-10-09"
    status: active
    who: okarcz
    note: "Promoted and assigned to okarcz."
  - date: "2026-10-09"
    status: active
    who: okarcz
    note: "Plan changed from a keeper cron to contract self-extension (okarcz). Branch rebased onto lore-0005-upto-proxy-docs (PR #12)."
  - date: "2026-10-09"
    status: active
    who: okarcz
    note: >
      Security review of the branch (no fund-moving bug found) and its fixes, in three commits:
      review fixes and 10 new unit tests; the contract's one-day cap on allowance_expiration_ledger
      (ADR 0010 D11, new deployment CAL7SBTO…V2VC); the self-extension e2e on a fresh instance.
      42 unit tests, e2e 57/57. Verify rules added to 0015 and 0034.
  - date: "2026-10-09"
    status: active
    who: okarcz
    note: >
      PR #14 review (Adam approved; Stan's follow-up): all 10 points fixed without a contract
      change: re-entry test with a positive control, the window's lower bound, per-test ledger
      anchor, and the fee and signature-nonce claims corrected in the docs. e2e 58/58.
  - date: "2026-10-09"
    status: active
    who: okarcz
    note: >
      Stacked rent measured on testnet: 330,032 stroops, over the 250,000 ceiling. Recorded in the
      report, threat model and README; the upto fee ceiling and a token keeper added to 0015.
  - date: "2026-10-09"
    status: completed
    who: okarcz
    note: >
      PR #14 rebase-merged into develop (938f1eb), carrying 0005's PR #12 commits too. All 6
      acceptance criteria met. Contract: self-extension (D10) and the allowance-expiry cap (D11),
      proxy CAL7SBTO…V2VC. 42 unit tests (+11), e2e 58/58. Follow-ups live in 0015 (verify MUST
      rules, upto fee ceiling, token keeper), 0034 (spec and client rules, draft sync) and 0027
      (proxy TTL alert).

# Keep the UptoProxy instance and WASM alive: TTL extension

## Summary

The UptoProxy contract instance and its WASM code are persistent ledger entries with a TTL.
Nothing extends that TTL today, so they will be archived, and then every `upto` settlement needs
a restore first, paid by the facilitator and possibly above `maxFeeStroops`. This task makes the
contract extend its own TTL on every successful settlement, capped per call, and makes the deploy
script start each deployment at the network's maximum TTL. It means a new WASM and a new
testnet deployment.

**Lane:** Payments

## Status: Completed

> Completed 2026-10-09. PR #14 was rebase-merged into develop (938f1eb), with 0005's PR #12
> commits it was built on. The proxy on testnet is `CAL7SBTO…V2VC`; the last e2e run was 58/58.

## Context

- Found in Stan's PR #12 review. The G spec (§7) said the 0004 deploy scripts keep the instance
  alive; they don't. PR #12 documents the gap as the README's **Availability** section and the
  threat model's **Proxy archived** threat, with the mitigation "none yet".
- **Testnet state on 2026-10-09** (ledger 5,101,513): the instance of `CC3VX7N6…Z7OYU` lives
  until 5,206,393 (about 6 days), its WASM `be2ba121…0b34` until 5,101,900 (about 30 minutes).
  Network limits: `max_entry_ttl` 3,110,400 ledgers (about 180 days), `min_persistent_ttl`
  120,960 (about 7 days), target close time 5,000 ms.
- **The old proxy is dropped.** We are in testing, so a new WASM and a new contract ID are fine;
  `CC3VX7…` is left to expire. No real authorizations are bound to it.

## Implementation

1. **Contract.** At the end of `settle_upto`, after the transfer and before the event:
   `env.storage().instance().extend_ttl_with_limits(EXTEND_TO, MIN_EXTENSION, MAX_EXTENSION)`
   (SDK 28 argument order). It extends the instance and the WASM code together.

   | Constant        | Ledgers | About (5 s ledgers) |
   | --------------- | ------: | ------------------- |
   | `EXTEND_TO`     | 518,400 | 30 days             |
   | `MIN_EXTENSION` |     120 | 10 minutes          |
   | `MAX_EXTENSION` |     720 | 1 hour              |

   (First planned as 1 day and 7 days; changed after the measurement, see decision 4.)

   Constants are ledgers, not days: a faster close time makes them shorter but breaks nothing.
   No new function, no admin; I1–I7 unchanged.
2. **Unit tests** (`src/test/`), with `get_contract_instance_ttl` / `get_contract_code_ttl`:
   no extension when the TTL is high, an extension capped at `MAX_EXTENSION` when it is low, and
   both entries extended. Regenerate the test snapshots.
3. **Deploy script.** After deploying (and on a rerun), extend the instance and the WASM to the
   network maximum with `stellar contract extend`, so a new deployment starts at about 180 days.
4. **Testnet.**
   - Deploy the new WASM (new contract ID).
   - Measure what a settlement pays for the extension, by ledgers extended, and check it against
     `maxFeeStroops` (250,000).
   - Run the max extension, then rerun the 49-scenario e2e suite against the new ID.
5. **Docs.**
   - ADR 0010: add D10 (self-extension, with limits) and drop self-extension from the rejected
     alternatives.
   - Contract README: execution order, the constants, Availability, new deployment row.
   - Threat model, "Proxy archived": covered, except a contract nobody uses for months.
   - Testnet report: new IDs, the rerun, the measured extension cost.
   - `deploy/testnet.env.example`: new contract ID and WASM hash.
   - 0034's `scheme_upto_stellar.md` draft: interface, IDs. (On the 0034 branch.)

## Acceptance Criteria

- [x] `settle_upto` extends the instance and WASM with `extend_ttl_with_limits` and the agreed
      constants; unit tests cover no-op, capped and both-entries cases
- [x] The deploy script extends a new deployment to the network maximum
- [x] New proxy deployed on testnet; the capped extension's fee is measured and fits under
      `maxFeeStroops`
- [x] The e2e suite passes against the new proxy (50/50 with the new availability check) and the
      report shows it
- [x] ADR 0010 (D10), the contract README and the threat model explain the self-extension and
      why it uses limits
- [x] Security review findings fixed: the client checks the simulated tree, the facilitator
      check bounds the allowance window, the contract caps the expiry (D11), the self-extension
      is shown on chain

## Implementation Notes

- **Contract** (`src/lib.rs`): constants `TTL_EXTEND_TO`, `TTL_MIN_EXTENSION`, `TTL_MAX_EXTENSION`,
  and one `extend_ttl_with_limits` call after the transfer, before the event. New WASM 4,192 bytes,
  hash `8019c086…ed6d`.
- **Unit tests** (`src/test/ttl.rs`, 4 tests): capped extension for a normal and a zero
  settlement, extension stops at the target, gains under the minimum are skipped, a failed
  settlement extends nothing. 31 pass; the WASM tests pass.
- **Deploy script**: extends the instance and WASM to `max_entry_ttl - 1` (read from the network
  settings) on every run; `EXTEND_TTL=0` skips it.
- **e2e**: `contractTtls` in `chain.ts` and an availability check (instance and code TTL at least
  `TTL_EXTEND_TO - TTL_MIN_EXTENSION`). Full run 2026-10-09 09:03 UTC: **50/50**, 21 settlements in
  ledgers 5,102,576–5,102,601, proxy `CDSWGHBULAYAQX77CPHYOUDDUFMT6ZJBCY5FPUK7N3B2JFS32VNYHEPD` at
  3,110,368 ledgers of TTL. Settlements cost 23 stroops more than with the previous WASM (the
  no-op check).
- **Measurement** (simulated `settle_upto` on `CA6FI7OV…HXXWV`, the first build with a 120,960 cap,
  TTL raised step by step with the CLI): rent 198.8 stroops per ledger extended plus about 5,800
  per extension; the 4,288-byte WASM code is almost all of it. Script in the session scratchpad
  only; numbers in the testnet report.
- **Testnet spend** (friendbot XLM, deployer `x402-testnet-deployer`): about 13 XLM for the
  measurement extensions, 108.6 XLM for the max extension of the proxy and the test token.
- **Docs**: testnet report (new run, "Keeping the contract alive"), contract README
  (deployments, execution order step 11, Availability), ADR 0010 (D10, two rejected alternatives,
  consequence), threat model ("Proxy archived", "Fee inflation by rent"), `deploy/README.md`,
  `testnet.env.example`, e2e README, G spec §7.

### Security review (2026-10-09)

An adversarial review of the branch found no way to move funds without the payer's signature.
The report (local page, then a private claude.ai artifact) listed 2 medium, 3 low and 4
informational findings. All fixed or documented on this branch:

- **M1, rent by allowance expiry.** The payer picks `allowance_expiration_ledger` and the
  facilitator pays temporary rent on the nonce and the allowance until then. Measured by
  simulation on testnet: 1.3 stroops per ledger (+2,200 fixed above the 720-ledger minimum);
  17,280 ledgers ≈ 25,000, the network maximum ≈ 3.9 million. Fixed three ways: the e2e
  `checkClientAuth` refuses expiries past the window (204 ledgers); the contract refuses more than
  `MAX_ALLOWANCE_LEDGERS` = 17,280 ahead (`InvalidAllowanceExpiration`, D11); `/verify` rules
  added to 0015 and 0034.
- **M2, blind signing.** `clientSign` signed whatever simulation returned. Now
  `signSimulatedEntry` compares the tree with the terms first; e2e scenario with a forged
  `token.transfer` tree.
- **L1.** The availability check passed on the deploy-time extension alone. New scenario: a fresh
  instance (random salt, no deploy-time extension) gains exactly 720 ledgers per settlement.
- **L2.** The e2e allowance lived 42 minutes for a 15-minute window; it now expires with each
  payment's deadline (+12 ledgers), and the signature with it.
- **L3.** The deploy script's `max_entry_ttl` error was unreachable under `pipefail`.
- **Info.** `from == facilitator` is refused by the host (documented in the README's Verify);
  no-op tokens and nonce reuse after expiry are pinned by tests.
- **Tests added:** `src/test/adversarial.rs` (7 tests), `settlement_properties.rs` (window check
  order, value conservation), a TTL model property in `ttl.rs`, the network-limit case in
  `mod.rs`. 42 unit tests. e2e: 7 new scenarios, 57/57 on 2026-10-09 11:58 UTC.
- **Deployment:** `CAL7SBTOECJ6HXXO3ST43LM2HJJFSZ3ZDEEZBIWHJPB7DRF5MXS5V2VC`, WASM
  `00a06b16…b79c` (4,211 bytes); `CDSWGHBU…HEPD` retired.

### PR #14 review (2026-10-09)

Adam approved with six comments; Stan added four. All were valid and fixed in one commit, with
no contract change (the WASM hash is unchanged):

- **Signature nonce rent (Stan 1).** The host keeps a nonce for the client's entry until
  `signatureExpirationLedger`, which the contract never sees, so D11 doesn't bound it. The
  facilitator's `signatureExpirationLedger == allowance_expiration_ledger` check is required, not
  defence in depth: said in D11, the threat model, `lib.rs`, the README, and as a MUST in 0015
  and 0034.
- **Lower bound on the window (Stan 2).** An allowance that ends before the deadline passes verify
  and then fails with `Expired` after the seller has served. `checkClientAuth` now refuses it; new
  e2e scenario; MUST in 0015 and 0034.
- **Stacked rent (Stan 3, Adam 1).** The worst case without token rent is about 215,000 (86%),
  not 193,000 (77%). "Never refused" dropped. Then measured on testnet with three real
  settlements on a fresh proxy and code (a 4,260-byte build with one extra metadata entry, so it
  has its own code entry) and the 0006 bench SAC, whose instance was below its 6-day threshold:
  **330,032 stroops** with everything stacked (proxy and code +720, SAC instance +54,689 ledgers,
  expiry at the cap), 185,818 without the SAC extension, 173,317 with a short expiry as well.
  About 480,000 is possible for a SAC instance close to expiry (extrapolated). Not a contract
  fix: 0015 gets a separate `upto` fee ceiling (about 500,000) and a keeper for the accepted
  tokens' instances. The measurement script was temporary and not committed; its results are in
  the testnet report.
- **Re-entry test (Stan 4).** It passed for the wrong reason (`facilitator == from`). It now runs
  the same inner call against another proxy instance as a positive control (it settles) and
  against the proxy on the stack (host error).
- **"Once per 10 minutes" (Adam 2)** only holds at the target; corrected everywhere.
- **`EXTEND_TTL=0` (Adam 3):** the availability check is skipped in that mode, comment fixed.
- **Ledger estimate (Adam 4):** re-anchored with `getLatestLedger()` before every test.
- **`signSimulatedEntry` (Adam 5)** is now `async`.
- **Protocol (Adam 6):** `extend_ttl_with_limits` needs protocol 26+; noted for mainnet.

## Issues Encountered

- **The agreed 1-day/7-day constants failed on testnet.** The first settlement on a fresh
  deployment tried a 7-day extension and simulated at 24,032,038 stroops; the submitter refused it
  (`FeeLimitError`, limit 250,000). Rent on the WASM code entry is far higher than expected, so the
  cap had to be sized from a measurement (decision 4).
- **The measurement baseline is inflated.** Simulating in recording-auth mode gives 697,246 stroops
  with no extension, much more than a signed settlement (about 41,000). It is constant across the
  measurements, so only the differences were used.
- **`stellar-cli` 28.1 warns that testnet runs protocol 29.** It worked for `extend`, `deploy` and
  `network settings`.

## Design Decisions

### Emerged

1. **The contract extends itself, not a keeper cron** (okarcz). The first proposal kept the old
   address and added an extension script, a scheduled GitHub workflow and a keeper key. Since
   testnet deployments are free to replace, self-extension wins: one call, no key or secret, no
   operator, and the same behaviour on mainnet and upstream. Its gap, a contract nobody settles
   on, is covered by the deploy-time max extension and by restore, which anyone can do (and which
   a settlement does by itself since protocol 23).
2. **`extend_ttl_with_limits` over `extend_ttl(threshold, extend_to)`** (okarcz). In steady use
   both add about a day per day. They differ after a quiet period or on a fresh deployment:
   plain `extend_ttl` makes one settlement pay to refill the whole gap (23 days on a fresh
   deployment, up to 30 after idling), which can push a valid payment over `maxFeeStroops` and
   get it refused. The cap bounds what one settlement pays (7 days); the minimum avoids paying
   the per-extension write cost on every call. The total rent is the same; the cap only spreads
   it. This reasoning goes into ADR 0010's D10.
3. **Branch based on PR #12**, not develop, because the README and threat-model sections it
   changes are only there. Retarget to develop once #12 merges.
4. **Constants from measurement: 518,400 / 120 / 720** (okarcz, after reviewing the data). MAX
   720: the costliest extending settlement is about 44,000 + 5,800 + 720 × 198.8 ≈ 193,000, 77%
   of the 250,000 ceiling, leaving headroom for a rising rent rate. MIN 120: one extension per 10
   minutes under steady traffic, about 30,000 extra each, fixed overhead about +24% of rent
   (0.08 XLM a day). The facilitator, never the client, pays.
5. **Self-extension kept after the cost finding** (okarcz). Option A (no contract change, deploy
   extension plus a keeper) was weighed against it. Rent is the same either way; with steady
   traffic the contract keeps itself alive with no operator, and the deploy-time maximum covers
   quiet periods.
6. **An e2e availability check** was added, making the run 50 scenarios, so every run shows the
   proxy's TTL.
7. **Allowance expiry cap of 17,280 ledgers (a day)** (okarcz asked for the contract cap as
   defence in depth; Claude picked N from the testnet measurement). 4,320 (6 h) was the
   alternative: ~8,000 instead of ~25,000 stroops of rent. A day was chosen because the contract
   is immutable and `/verify`'s window is the real bound, so the cap should not restrict longer
   legitimate windows. The costliest settlement, extension plus a day of expiry, is about
   218,000 stroops (87% of the ceiling); only a facilitator that skips the window check reaches it.
8. **The verify notes went to 0015 and 0034, not 0016 and 0027.** The review page said "0016/0027"
   by mistake: 0016 is the signer-pool prerequisites and 0027 alerts. 0015 owns the facilitator's
   `upto` path, 0034 the scheme spec and the client classes.
9. **The fresh-instance e2e deploys a new contract every run** (random salt, same WASM). It costs
   one deploy and leaves an instance that expires in about 7 days; the alternative, a second
   deployer key, would keep one long-lived instance that is eventually above the target too.

## Future Work

Each item is recorded in its task; no new tasks were needed.

- **0015** (facilitator `upto` path): the `/verify` MUST rules (signature expiry equals the
  allowance, allowance no earlier than the deadline and no later than the window), a separate
  `upto` fee ceiling of about 500,000, and a keeper for the accepted tokens' instances.
- **0034** (upstream spec and client classes): the same verify rules, the expiry cap, no blind
  signing of simulated entries, and syncing the drafts with the new proxy.
- **0027** (alerts): an alert when the proxy's instance or code TTL runs low (added there).

## Notes

- Mainnet: the deploy-time extension runs under the deployer key decided in 0026, and
  `extend_ttl_with_limits` needs protocol 26 or later.
