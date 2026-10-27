---
title: "How other x402 facilitators handle restore rent"
type: research
status: mature
spawns: [notes/S-option-b-design.md]
tags: [facilitator, exact, fees, x402]
links:
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_stellar.md
  - https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
  - https://github.com/x402-foundation/x402/blob/main/specs/extensions/erc20_gas_sponsoring.md
  - https://github.com/qntx/r402
  - https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator
  - https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival
history:
  - date: "2026-10-27"
    status: mature
    who: akot
    note: "Survey of the x402 specs and three Stellar facilitators."
---

# How other x402 facilitators handle restore rent

None of them pays restore rent; all refuse.

| Who | Behaviour |
| --- | --- |
| x402 `exact` Stellar spec | `maxTransactionFeeStroops` is optional, default 50,000. Over it the facilitator MUST refuse with `invalid_exact_stellar_payload_fee_exceeds_maximum`. Archived state isn't mentioned. |
| `@x402/stellar` (upstream, `main` and 2.28.0) | Refuses on the fee; no archive detection, no restore. |
| r402 (Rust) | Answers `simulation_failed` when the simulation has a `restorePreamble`, i.e. the pre-Protocol 23 model. |
| OpenZeppelin Relayer x402 plugin (hosted for SDF) | No restore handling. Its ceiling is optional and checks the client's fee bid, not the simulated fee; without one it would pay any rent. |
| x402 `exact` SVM spec | The fee payer "pays only the network fee" and MUST NOT appear in any instruction, so it can't even create the recipient's token account. Rent is never the facilitator's. |
| x402 `exact` EVM, `erc20ApprovalGasSponsoring` | The only case of a facilitator paying a one-time setup cost: an opt-in extension advertised in the 402, run as one atomic bundle with the payment. |

## What follows for 0066

- The spec fixes the reason code; the detail can only go in `invalidMessage` and `extra`.
- Refusing matches every implementation and the SVM rule.
- If restore rent is ever sponsored, it follows the EVM pattern: an advertised extension, inside
  AD-18's budgets.
- Stellar's state archival docs still describe `restorePreamble`; 0021's run on Protocol 23 saw
  the archived entries in `archivedSorobanEntries` instead, so read both.
- `stellar contract restore` (`--id`, `--key-xdr`, `--wasm-hash`, `--source-account`) restores an
  entry from any account.
- `@x402/core`'s resource server puts only `invalidReason` into the buyer's 402
  (`PaymentRequired.error`); `invalidMessage` reaches sellers' hooks, direct `/verify` callers and
  logs.
