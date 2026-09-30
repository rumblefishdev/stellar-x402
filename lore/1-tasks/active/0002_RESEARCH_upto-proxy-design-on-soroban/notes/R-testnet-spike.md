---
title: "Spike results: unit tests and stellar:testnet"
type: research
status: mature
tags: [spike, testnet, evidence]
links:
  - ../spike/README.md
  - ../spike/results/testnet-run.json
history:
  - date: "2026-09-30"
    status: mature
    who: claude
    note: "7 unit tests + 8 testnet scenarios, all as expected"
    spawned_from: ["notes/I-section-6-2-review-findings.md"]
---

# Spike results: unit tests and stellar:testnet

The spike code is in [`../spike/`](../spike/README.md). The contract is a minimal prototype of
`settle_upto`, with `token` added and the approve-in-tree mechanism. The client script plays the
x402 roles.

## Unit tests (soroban-sdk 28, `mock_auths`, which enforces an exact tree)

| Test | Proves |
|---|---|
| `same_client_tree_settles_any_amount_up_to_max` | One tree settles 0, 1, 400 and 1000 of 1000; leftover allowance = `max - actual` |
| `over_max_is_rejected` | `Error(Contract, #1)` AmountExceedsMax |
| `replay_is_rejected` | Contract nonce: `Error(Contract, #5)` NonceUsed |
| `changed_recipient_does_not_match_client_tree` | Recipient binding |
| `missing_facilitator_auth_is_rejected` | Facilitator binding |
| `approve_before_require_auth_does_not_match_the_same_tree` | Call order matters (F7) |
| `recorded_tree_has_no_actual_amount` | Exact recorded tree; `transfer_from` needs no auth entry |

## Testnet (protocol 29, run 2026-09-30)

**Setup**

| Item | Value |
|---|---|
| Spike contract | `CDBXX22H4G5OZIBPBZ76GNI2CW7W2F3P2V356W5AORLHXJD7OK33VJAK` (WASM sha256 `d055cac9…e891`) |
| Token | SAC for `UPSPIKE:GASBJVY5…OXLD` = `CCH46PUSMDVRYST4IC5QZ32OCSFGQV2SDM5MOJW3ETBYG5326OKHNQ2P` |
| Client | `GB4HWP6U…FL7I` |
| Facilitator | `GA2YE73M…TR5Z` |
| Seller | `GDZPXPQ7…XLOY` |
| Channel | a fourth funded account |

**How each authorization is used.** The client simulates with `actual = max` and signs only its
own entry. The facilitator rebuilds the transaction with the real amount, re-simulates (with
auth enforced) and submits.

Final run (V2 credentials). Fees are in stroops.

| # | Scenario | Result | Tx / error | Fee |
|---|---|---|---|---|
| S1 | Partial: 37.5 of 100 | SUCCESS; client −37.5, seller +37.5 | `507b60b1c45ba68dda9c364799fe848650b1e4032e0f4edb5fbbe9c20e98e488` | 38,628 |
| S2 | Replay of the S1 entry, other amount | rejected in simulation | `Error(Auth, ExistingValue)`, the built-in nonce | – |
| S3 | Redirect `to` to the facilitator | rejected in simulation | `Error(Auth, InvalidAction)` | – |
| S4 | `actual = max + 1` | rejected in simulation | `Error(Contract, #1)` | – |
| S5 | Seller settles instead of the facilitator | rejected in simulation | `Error(Auth, InvalidAction)` | – |
| S6 | Same unused authorization, `actual = 0` | SUCCESS | `f4a6ce4c271793e2ee288c03db9f290eed9ba74adb240218588d735f47025570` | 28,019 |
| S7b | Second of two open authorizations settles first, 20 of 50 | SUCCESS | `eb601fa32b41d0250be97541a3f35eee0fbce3f595542565e7afc210cfe5ceed` | 38,628 |
| S7a | First authorization settles at max, 50 of 50 | SUCCESS | `681abad3072a365f258f93a8fbb7692d784f060425be965879b1857d6807fa26` | 38,622 |
| S8 | Channel account as source, facilitator signs a V2 entry | SUCCESS; channel paid, facilitator 0 | `48f5a10a8c86a3ccdb8c50790ffd13d5118d7949d79d8059b3758bf3376399aa` | 47,286 |

- The client's XLM balance did not change across the run (delta 0). **Buyers never pay fees.**
- An earlier run with **V1** (`ADDRESS`) credentials also settled S1:
  `7d31654b90cf9dd62795c89f1e2cfa55cedfac5eaeb2b7242861f970b5840649`. So both credential kinds are
  accepted.

## Findings the spike surfaced

1. **The client draft cannot use the client as source.** It then receives source-account
   credentials. Use the facilitator address as the draft source.
2. **Simulating with `actual = max` needs a balance of at least max.** The first run failed with
   `Error(Contract, #10)` (balance) once the client held less than max. This matches the EVM
   verify rule that the balance must cover the maximum.
3. **The testnet RPC returns V1 or V2 credentials, varying between runs.** Only
   `@stellar/stellar-sdk` 17.x can parse V2; 15.x throws.
4. **Settlement costs 28k–39k stroops, or 47k through a channel account.** The channel figure is
   close to `exact`'s default ceiling of 50k.
5. **Replays are caught first by the built-in auth nonce.** The contract's own nonce is a second
   layer, proven in the unit tests.

## Reproduce

See [`../spike/README.md`](../spike/README.md). Accounts are created with
`stellar keys generate upto-spike-* --fund`. Testnet resets delete all of the above.
