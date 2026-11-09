---
id: "0029"
title: "Gate run against our testnet facilitator"
type: FEATURE
status: active
milestone: 1
related_adr: ["0009"]
related_tasks: ["0012", "0028", "0026", "0009", "0020", "0059"]
tags: [conformance, e2e, priority-high, effort-small, platform]
links:
  - ../../../docs/planning/m1-epics.md
  - ../../../docs/architecture/m1-spine.md
history:
  - date: "2026-10-07"
    status: backlog
    who: claude
    note: "Created by 0012 from M1 Story 3.2 (Platform lane)."
  - date: "2026-11-05"
    status: active
    who: karolkow
    note: >
      Started now that the facilitator is deployed. A trial run at the old pin failed all 18
      scenarios; at upstream 8827cf1 all 18 settled through the deployed facilitator.
  - date: "2026-11-09"
    status: completed
    who: karolkow
    note: >
      Run of record on the deployed testnet facilitator: 18 of 18 scenarios, upstream 8827cf1,
      facilitator 68e778e (#148). The gate fixed and simplified (#133, #138), another
      facilitator's dry run removed (#139). The final run on the T1 build and the conformance
      report moved to 0119; the upstream change alarm (#149) is still open.
  - date: "2026-11-09"
    status: active
    who: karolkow
    note: >
      Reopened for its last criterion: the rerun on the finished T1 build, with the conformance
      report written from it, both before the M1 handover. 0119, which held them, is folded back
      in and removed.
---

# Gate run against our testnet facilitator

## Summary

As a reviewer of the grant, I want e2e results with real settled transaction hashes committed to the repo, so that the T1 exit criterion is met and can be checked by anyone.

**Story:** [M1 Story 3.2](../../../docs/planning/m1-epics.md#story-32-gate-run-against-our-testnet-facilitator) · **Lane:** Platform · **Covers:** FR21 (AD-13, AD-15)

## Context

- First run around day 12, final rerun at the end of T1.
- Related tasks: 0028, 0026, 0009, 0020.
- Run the gate of record while nothing else pays from the same testnet accounts (the MCP e2e suite uses them too): a concurrent run could hand the gate a valid transfer it did not make (0059 review).
- The 0059 over-engineering review left ~15 minutes of cuts in `conformance/src/gate.ts` that change no behaviour; take them with this task's edits there.
- The gate is pinned to upstream `10b2d06`. By 2026-10-22 upstream main was 63 commits ahead: the e2e harness unchanged, but the Stellar mechanism changed (client `exact` scheme, facilitator settle errors, typed simulation errors, x402-foundation/x402#3293, #2975). Decide whether to bump the pin before the run of record; a bump means a fresh gate run. 0059 (raw result file, signals, ledger check) should land first.
- `/supported` (0020) must list `exact` on `stellar:testnet` with `extra.areFeesSponsored: true`: the canonical client throws without it (found in the 0028 recon).
- From the 0028 review: the gate also needs `/supported` to list the facilitator key under a `stellar:` signer, because it fails any settlement whose fee another account paid.
- From the 0028 review: the saved run holds the upstream commit, date, facilitator URL, its signers and each transaction, but no facilitator version; the facilitator has to expose one for this task's results.
- From 0054 (replacing 0053's note): the catalog refuses the suite's `http://localhost:<port>/…`
  and `mcp://tool/<name>` URLs on every network (`resource_not_public`; the payments settle), so
  a run against the hosted testnet facilitator leaves no entries. The suite's Bazaar check, once
  `/discovery/search` exists, needs them listed: decide whether it runs against a facilitator of
  its own with `CATALOG_LIST_LOCAL=true`, or turns the switch on for the hosted testnet one, which
  brings back the entries 0054 keeps out of the public catalog (0054 review).
- From the PR #50 review: once the Bazaar check runs, it reads one `?limit=1000` page and looks
  for its resources there (upstream `e2e/extensions/bazaar.ts:290`), while our route clamps to 100
  (spec v2 §8.1) and lists oldest first. With more than 100 entries in the catalog the check
  misses its own; run it against a catalog under 100 entries.
- From the 0028 review: the first criterion says "verify → settle" for each scenario, but the 9 `upfront` scenarios settle without a `/verify` (answered in 0028); reword it before starting.

## Decisions so far

| # | What is done | From | Vs the task | Who does the same (checked) |
| --- | --- | --- | --- | --- |
| 1 | The pin moves from `10b2d06` to `8827cf1` | measured: testnet is on protocol 30 (`getVersionInfo`); `getLatestLedger` fails on stellar-sdk 16.3.0, the old pin's, and works on 16.4.1; 18 of 18 scenarios failed at the old pin, 18 of 18 passed at the new one (one run each, 2026-11-05) | settles the open bump | upstream requires `^16.4.1` at `8827cf1`; [Stellar's Protocol 30 guide](https://stellar.org/blog/developers/bell-protocol-30-upgrade-guide) says to upgrade the SDK |
| 2 | `/health` reports the running commit as `commit`, set when the image is built; the gate saves it | the owner's decision, 2026-11-05 | as the task says: the facilitator exposes its version | upstream's e2e facilitator has `version` in `/health` (`e2e/facilitators/typescript/index.ts:1215@8827cf1`) |
| 3 | The gate waits for the suite without blocking its process, and a signal to the gate stops the suite's whole process group | measured: after 780 s under `spawnSync` the first RPC read fails with `fetch failed` and the second works; after 780 s of plain waiting it works, and a new `rpc.Server` doesn't help (one process each). Two real runs failed so on their first read; two runs after the fix read all 18 | beyond it: needed for a passing run | no standard |
| 5 | One results folder per environment, overwritten, with git holding the history: `conformance/results/testnet-hosted/`; local runs are ignored by git (changes ADR 0009) | the owner's decision, 2026-11-05 | beyond it | upstream keeps CI artifacts only; no standard |
| 6 | The gate fails a run whose facilitator names no commit, and one whose own code has uncommitted changes, and saves its commit | the owner's decisions, 2026-11-05 | as the task's version criterion, and beyond it | no standard |
| 7 | The proxy forwards the facilitator's response headers | the owner's decision, 2026-11-05 | beyond it | no standard |
| 8 | On testnet gateway.fm's RPC comes first and SDF's second, once a measurement from the server agrees | the owner's decision, 2026-11-05; measured from one machine, 25 calls each | beyond it | no standard |
| 9 | The gate runs all 18 scenarios, not the suite's `--min` sample | the owner's decision, 2026-11-06 | as the task says | upstream's CI runs `--min` (`.github/workflows/e2e_tests.yml@8827cf1`) |
| 10 | Every passed scenario must carry a transaction hash | the owner's decision, 2026-11-06 | as the task says | no standard |
| 11 | The gate keeps reading each transaction from the chain: status, transfer, fee payer, ledger | the owner's decision, 2026-11-06 | as the task says | no standard |
| 12 | The gate saves each signed envelope | the owner's decision, 2026-11-06 | beyond it | no standard |
| 13 | No fixed scenario count: the gate takes the scenarios the suite selects, which records each one, a server that fails to start as failed (`e2e/test.ts:1783-1795@8827cf1`) | the owner's decision, 2026-11-06 | as the task says | no standard |
| 14 | The gate fails a hash that two scenarios report | the owner's decision, 2026-11-06 | as the task says | no standard |
| 15 | No file of forwarded calls: the settlements are proven on chain (rows 11 and 14), and the suite's `-v` shows the calls when debugging | the owner's decision, 2026-11-06 | as the task says | no standard |
| 16 | The off-server check's Lambda (0027) compares, on the hour, the three upstream files the suite rests on (the x402 spec, the Stellar `exact` scheme, the suite's Stellar routes) at the gate's pin with upstream main, and the `upstream-changed` alarm fires to the team's alarm channel while one differs; it replaces the weekly issue | the owner's decision, 2026-11-06 | beyond it (RFP: track spec evolution) | no standard |

## Not yet decided

- How often the gate runs after T1.

## Out of scope

- End-to-end tests of refusals against the deployed facilitator: task 0116, the project's full end-to-end suite.

## Implementation

- Run the 0028 harness against the deployed facilitator.
- Commit results; triage failures into lane tasks; rerun on the final build.

## Run of record

2026-11-06, 13:31 UTC, `conformance/results/testnet-hosted/`: 18 of 18 scenarios passed, each
settled on chain with the facilitator's signer as fee payer. Upstream `8827cf1`, facilitator
`68e778e`, gate `a2fdfb0`. The final run on the finished T1 build is still to come.

## Implementation Notes

- #133: `/health` names the image's commit (`GIT_COMMIT`), the gate saves it, and the pin moved from
  `10b2d06` to `8827cf1`.
- #138: the gate waits for the suite without blocking its process, stops the suite's process group
  on a signal, fails a run with no facilitator commit or with uncommitted gate code, saves each
  signed envelope and its own commit, the proxy forwards response headers, and each run overwrites
  `results/testnet-hosted/` (`testnet-local/` is ignored by git).
- #139: another facilitator's dry run removed from `conformance/results/`.
- #148: the run of record.
- #149 (open): the `upstream-changed` alarm in the off-server check (decision 16).

## Issues Encountered

- **Testnet moved to protocol 30 on 2026-11-03.** The old pin's stellar-sdk 16.3.0 can't read its
  ledgers, so all 18 scenarios failed; the pin moved to `8827cf1` (stellar-sdk 16.4.1).
- **The gate failed good runs.** Under `spawnSync` the gate's process couldn't see RPC close its
  idle connection during a 13-minute suite, and its first chain read failed. Measured: 780 s of
  `spawnSync` failed the first read, 780 s of plain waiting didn't. Fixed in #138.
- **SDF's testnet RPC is slow since about 2026-11-02:** median 0.3–6 s and up to 9.5 s from one
  machine, against 0.1–0.2 s for gateway.fm. That made the suite take 13 minutes instead of 5.
  Which RPC the server uses first is 0026's.

## Future Work

- 0116: the project's full end-to-end suite, with refusals.
- #149: the upstream change alarm; it needs a review, a merge and two infra deploys (0119 checks
  it first).

## Before the M1 handover

- After the last deploy before the M1 handover: rerun the gate and commit `results/testnet-hosted/`.
- Write the conformance report from that run: what ran and against which commits, each scenario
  with its transaction hash, and what the suite doesn't cover (one good payment per scenario, no
  refusals, no Bazaar check).
- First: the `upstream-changed` alarm (#149) merged and deployed (`make deploy-production-watch`,
  `make check-series GROUP=watch`, `make deploy-production-alarms` in `infra/`).
- The testnet reset of 2026-12-16 (developers.stellar.org, Networks) removes the transactions from
  the network: the grant's final handover needs a fresh run and the report's table refreshed.

## Acceptance Criteria

- [x] Given our facilitator deployed at its public URL (0026), when the gate runs, then the canonical client settles `exact` for each Stellar scenario (the 9 `upfront` ones without a `/verify`) and every run records a real transaction hash
- [x] Given a finished run, when results are saved, then `conformance/results/` gets the run JSON with the upstream commit, the date, our facilitator version and the transaction hashes
- [x] Given a failing scenario, when it is analysed, then a backlog task is created for the owning lane (no scenario failed in the run of record)
- [ ] Given the finished T1 build, including Bazaar and spend budgets, when the gate reruns, then it passes and the final results are committed
- [ ] Given the final results, when the conformance report is written, then it lists the e2e results and the settled transaction hashes, with the upstream and facilitator commits (RFP, expected deliverables)
