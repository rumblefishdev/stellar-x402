---
id: "0035"
title: "Keep the UptoProxy instance and WASM alive: TTL extension"
type: FEATURE
status: active
milestone: 1
related_adr: ["0010"]
related_tasks: ["0005", "0004", "0034", "0026"]
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
---

# Keep the UptoProxy instance and WASM alive: TTL extension

## Summary

The UptoProxy contract instance and its WASM code are persistent ledger entries with a TTL.
Nothing extends that TTL today, so they will be archived, and then every `upto` settlement needs
a restore first, paid by the facilitator and possibly above `maxFeeStroops`. This task makes the
contract extend its own TTL on every successful settlement, capped per call, and makes the deploy
script start each deployment at the network's maximum TTL. It means a new WASM and a new
testnet deployment.

**Lane:** Payments

## Status: Active

> Started 2026-10-09 by okarcz on `lore-0035-upto-proxy-ttl`, rebased onto
> `lore-0005-upto-proxy-docs` (PR #12) because the docs it changes exist only there. Built,
> measured and deployed on testnet (`CDSWGHBU…HEPD`); e2e 50/50. In review as a draft PR.

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

## Notes

- Mainnet: the deploy-time extension runs under the deployer key decided in 0026.
- A facilitator-side warning when the proxy's TTL runs low would still help; it belongs in 0027.
