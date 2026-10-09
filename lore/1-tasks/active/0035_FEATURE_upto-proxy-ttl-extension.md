---
id: "0035"
title: "Keep the UptoProxy instance and WASM alive: TTL extension"
type: FEATURE
status: active
milestone: 1
related_adr: ["0010"]
related_tasks: ["0005", "0004", "0026", "0027"]
tags: [upto, contract, operations, deploy, priority-medium, effort-small, payments]
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
---

# Keep the UptoProxy instance and WASM alive: TTL extension

## Summary

The UptoProxy contract instance and its WASM code are persistent ledger entries with a TTL.
Nothing extends that TTL today, so they will eventually be archived. After that, every `upto`
settlement needs a restore first, paid by the facilitator and possibly above `maxFeeStroops`, or
it fails. This task adds the extension to the deploy script and a scheduled check that keeps
both entries alive and alerts before they run low.

**Lane:** Payments

## Status: Active

> Started 2026-10-09 by okarcz. Nothing built yet.

## Context

- Found in Stan's PR #12 review. The G spec (§7) said the 0004 deploy scripts keep the instance
  alive; they don't. `deploy/scripts/deploy-contract.sh` only deploys, and the e2e suite only
  calls the contract.
- Documented in 0005 as the README's **Availability** section and the threat model's **Proxy
  archived** threat (both on PR #12 until it merges). Their mitigation is "none yet"; this task
  provides it.
- A redeployment is no way out: every open client authorization names the proxy's address
  (`CC3VX7N6…Z7OYU` on testnet), so the same entries must stay live or be restored.
- Rent depends on the entry size and the length of the extension (0006 measured 116,316 stroops
  for one TTL extension), so it is cheaper to extend on schedule from an ops account than to let
  a settlement pay for it.

## Implementation

1. **Deploy script.** After deploying, and on every rerun that finds the contract already
   deployed, extend the instance and the WASM code entry to a target TTL (configurable, close to
   the network's maximum). Use `stellar contract extend`, paid by the deployer.
2. **Scheduled check.** A job that reads `liveUntilLedgerSeq` for both entries over RPC
   (`getLedgerEntries`), extends them when the TTL left drops below a threshold, and reports the
   result. Where it runs (CI cron or the facilitator host) follows 0014/0026.
3. **Alert.** Feed "TTL below threshold" and "extension failed" into the alerts from 0027.
4. **Restore runbook.** Document what to do if the entries are archived anyway
   (`stellar contract restore`, who pays, how to check that settlements work again).
5. **Docs.** Update the README's Availability section and the threat model's "Proxy archived"
   mitigation and residual risk to point to the script, the job and the runbook.
6. **Mainnet.** The same job runs for the mainnet deployment, under the deployer key decided in
   0026.

## Acceptance Criteria

- [ ] `deploy-contract.sh upto-proxy` extends the instance and WASM TTL on deploy and on rerun
- [ ] A scheduled check extends both entries before they fall below the threshold, and its run
      on testnet is recorded with the ledger numbers before and after
- [ ] Low TTL and failed extension raise an alert (0027)
- [ ] A restore runbook exists and has been tried once on testnet, or the attempt is documented
- [ ] The README's Availability section and the threat model's "Proxy archived" entry describe
      the mitigation instead of "none yet"

## Notes

- Applies to `contracts/test-token` too if the e2e suite needs it long term, but only the proxy
  matters for payments.
- Lane is Payments (okarcz) because the contract is; the scheduled job may be handed to Platform
  with 0026/0027.
