---
title: "Manual testnet verification of UptoProxy"
type: research
status: mature
tags: [upto, contracts, testnet, evidence]
links:
  - ../README.md
  - ../../../archive/0002_RESEARCH_upto-proxy-design-on-soroban/notes/G-upto-proxy-contract-spec.md
  - ../../../archive/0002_RESEARCH_upto-proxy-design-on-soroban/spike/README.md
history:
  - date: "2026-10-02"
    status: mature
    who: okarcz
    note: "Manual stellar:testnet run of the PR #2 WASM: 11 steps + spike S1-S8, all upto properties held"
---

# Manual testnet verification of UptoProxy

## Verdict

**Passed.** The UptoProxy contract was tested by hand on Stellar testnet on 2026-10-02, against the
exact WASM under review in PR #2. All five `upto` properties held on-chain:

- the client signs a ceiling once
- the bound facilitator settles any amount from 0 up to that ceiling
- the signed payload leaves out `actual_amount`
- a nonce or signature can't be used twice
- the client pays no fees

One step (8) settled when the test expected a rejection. The cause was the test's design, not the
contract, and a corrected step (8b) passed. The test itself changed no repo files.

All accounts and contracts below are public testnet addresses. No secret keys appear in this note:
the commands read them at run time from the local stellar-cli keystore (`stellar keys show`).

## Environment

The test used the code at `f3bd2b5`, the head of PR #2, on branch `lore-0003-upto-proxy-contract`.
CI on that commit was green: node 22, node 24 and contracts.

| Item | Value |
| --- | --- |
| Commit | `f3bd2b5` test(lore-0003): make actual_amount exclusion test real |
| Toolchain | stellar-cli 28.1.0, Rust 1.97.1 (from `contracts/rust-toolchain.toml`) |
| Network | Stellar testnet (protocol 29), RPC `soroban-testnet.stellar.org` |
| WASM | `upto_proxy.wasm`, 4,145 bytes, sha256 `be2ba12160a7e3e1a93ed0cb457b7e93cd6ed4c725cb51aeeb87313b45dd0b34` |
| Proxy contract | `CBEPV3F2FBNUXFSXFS6Q5R6D45KZADCUGCB62KBNWGFCCCMWL26TEGY7` (alias `upto-proxy-0003`) |
| Token (SAC, `UPSPIKE`) | `CCH46PUSMDVRYST4IC5QZ32OCSFGQV2SDM5MOJW3ETBYG5326OKHNQ2P` |
| Client (`upto-spike-client`) | `GB4HWP6UQU4MKFIS6N5JYYJ3H3KW2HFIMETW6WLHGXDIUSF6RNOOFL7I` |
| Facilitator (`upto-spike-facilitator`) | `GA2YE73MBZHOSSPZROCWNFRM2GFNW4QYRYJ3VQQ3XFJDIBBPVQMZTR5Z` |
| Seller (`upto-spike-seller`) | `GDZPXPQ73ACKG5GNRG5Z22UT46ATN4IF67UXCHNI542PT342SZ4JXLOY` |
| Token issuer | `GASBJVY5B2R4B2WYDXTFWQTIYQYM4FQMQIHBCPSUL4DOY3TM364JOXLD` |

The accounts, their trustlines and the token were reused from the 0002 spike. Before the run,
Horizon showed:

- client: 9,844.5 UPSPIKE and 9,999.99999 XLM
- seller: 255.5 UPSPIKE
- facilitator: about 9,998 XLM

Amounts are in stroops, and 1 UPSPIKE = 10,000,000 stroops. Any transaction can be looked up at
`https://stellar.expert/explorer/testnet/tx/<hash>`.

## Step 1: local quality gates

**Result: passed.** Lint, all 29 tests and the WASM build passed. The build reproduced the recorded
hash.

**Purpose:** prove the code under test is the PR head, is clean, and builds to the WASM that is
later deployed.

```sh
git checkout lore-0003-upto-proxy-contract && git pull --ff-only
git log -1 --oneline
pnpm contracts:lint && pnpm contracts:test && pnpm contracts:test:wasm
sha256sum contracts/target/wasm32v1-none/release/upto_proxy.wasm
```

| Check | Result |
| --- | --- |
| HEAD | `f3bd2b5`, equal to `origin/lore-0003-upto-proxy-contract`, working tree clean |
| `contracts:lint` (fmt + clippy `-D warnings`) | passed |
| `contracts:test` | 27 passed, 0 failed, 2 ignored |
| `contracts:test:wasm` | 2 passed (`wasm_interface_has_only_the_spec_functions`, `wasm_settlement_cost`) |
| WASM | 4,145 bytes (4,596 before optimization), hash `be2ba121…0b34` |
| Exported functions | `is_nonce_used`, `settle_upto` only |
| Local cost, `actual` = 500 | 903,417 instructions, 6 writes / 1,052 B, 31,889 stroops without rent |
| Local cost, `actual` = 0 | 670,907 instructions, 4 writes / 604 B, 20,462 stroops without rent |

**Checkpoint:** the test counts, hash and costs match the values recorded in task 0003.

## Steps 2–4: setup and deploy

**Result: passed.** The deployed contract is byte-for-byte the WASM from Step 1.

**Purpose:** put the reviewed WASM on testnet, and define the shell helpers that the later steps
call.

**Step 2, session variables and helpers:**

```sh
N=testnet
TOKEN=CCH46PUSMDVRYST4IC5QZ32OCSFGQV2SDM5MOJW3ETBYG5326OKHNQ2P
UNIT=10000000
ledger() { curl -s -X POST https://soroban-testnet.stellar.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq -r .result.sequence; }
bal() { stellar contract invoke --id $TOKEN --source upto-spike-facilitator --network $N --send=no -- balance --id $1; }
```

**Step 3, deploy:**

```sh
PROXY=$(stellar contract deploy --wasm contracts/target/wasm32v1-none/release/upto_proxy.wasm \
  --source upto-spike-facilitator --network $N --alias upto-proxy-0003)
stellar contract invoke --id $PROXY --source upto-spike-facilitator --network $N -- settle_upto --help
```

| Result | Value |
| --- | --- |
| WASM upload tx | `69515c14ea5d1ef3c8a8b9ee7909b9518af08f116cdc78a44446682fa1a0e6be` |
| Deploy tx | `770cff5877fe2e46f86447c15f2e3853fa6d49a6fd9f4af2f83ed21641120db5` |
| Proxy | `CBEPV3F2FBNUXFSXFS6Q5R6D45KZADCUGCB62KBNWGFCCCMWL26TEGY7` |
| Argument names | snake_case: `token`, `from`, `to`, `facilitator`, `max_amount`, `actual_amount`, `nonce`, `valid_after`, `deadline`, `allowance_expiration_ledger` |

**Checkpoint:** the WASM was fetched back from testnet with `stellar contract fetch`. It is 4,145
bytes with sha256 `be2ba121…0b34`, and its interface lists only `settle_upto` and `is_nonce_used`.

**Step 4, settle helper:** the facilitator is the transaction source, so its signature on the
transaction covers `facilitator.require_auth()`. Passing the identity `upto-spike-client` as
`--from` makes the CLI sign the client's address auth entry, `approve` included.

```sh
settle() { # settle <max> <actual> <nonce> [deadline] [source] [to] [facilitator]
  stellar contract invoke --id $PROXY --network $N --auto-sign \
    --source ${5:-upto-spike-facilitator} -- settle_upto \
    --token $TOKEN --from upto-spike-client --to ${6:-upto-spike-seller} \
    --facilitator ${7:-upto-spike-facilitator} \
    --max_amount $1 --actual_amount $2 --nonce $3 \
    --valid_after 0 --deadline ${4:-$(( $(date +%s) + 3600 ))} \
    --allowance_expiration_ledger $(( $(ledger) + 1000 ))
}
```

## Step 5: partial settlement, 37.5 of 100

**Result: passed.** Exactly 37.5 UPSPIKE moved from the client to the seller under a 100 UPSPIKE
ceiling. The facilitator paid the whole fee.

**Purpose:** the first real settlement. It shows the client's signed payload and the `approve` call
it signs, and checks the settlement's events, balances and fee payer.

```sh
N1=$(openssl rand -hex 32)   # ea19555483c590f80e4dc699ed58047b968b3024f4c21532e9cf1d847c0b0f08
settle $((100*UNIT)) 375000000 $N1
echo "client $(bal upto-spike-client)"; echo "seller $(bal upto-spike-seller)"
```

The client's signed auth entry, as the CLI printed it:

```text
settle_upto(token CCH46P…, to GDZPXP…, facilitator GA2YE7…, max_amount 1000000000,
            nonce ea195554…0f08, valid_after 0, deadline 1790932061)
  approve(from GB4HWP…, spender CBEPV3… (proxy), amount 1000000000, expiration_ledger 4981975)
```

Those are the 7 signed arguments in spec order. `actual_amount` and `from` are not among them, and
`approve` binds the allowance expiration ledger.

| Result | Value |
| --- | --- |
| Tx | `b49cec5f61d0bf4ba140fc2e93a8200fa2a61650fe7e2a9df5ac06a35fe76067`, ledger 4,980,976, successful |
| Events | `approve` 1,000,000,000 until ledger 4,981,975; `transfer` of 375,000,000 from the client to the seller; `upto_settled` with `max_amount` 1,000,000,000, `actual_amount` 375,000,000 and nonce `ea195554…0f08` |
| Balances after | client 98,070,000,000, seller 2,930,000,000 |
| Source and fee account | facilitator `GA2YE7…` |
| Fee charged | 97,963 stroops |
| Client XLM | 9,999.99999, unchanged |

**Checkpoint:** the event, the balance changes and the fee payer were checked on Horizon.

## Steps 6–7: nonce reuse and input rejections

**Result: passed.** Each invalid call failed with the error code the spec gives it. Each was refused
during simulation, so nothing was submitted and no fee was paid.

**Purpose:** show that a used nonce can't settle again, and that each input check from spec §4
steps 1–7 rejects on testnet.

```sh
# Step 6
stellar contract invoke --id $PROXY --source upto-spike-facilitator --network $N --send=no -- \
  is_nonce_used --from upto-spike-client --nonce $N1
settle $((100*UNIT)) $UNIT $N1
# Step 7
settle $((10*UNIT)) $((10*UNIT+1)) $(openssl rand -hex 32)
settle 0 0 $(openssl rand -hex 32)
settle $((10*UNIT)) $UNIT $(openssl rand -hex 32) $(( $(date +%s) - 60 ))
settle $((10*UNIT)) $UNIT $(openssl rand -hex 32) "" upto-spike-facilitator upto-spike-client
settle $((10*UNIT)) $UNIT $(openssl rand -hex 32) "" upto-spike-facilitator $PROXY
```

| Case | Input | Expected | Got |
| --- | --- | --- | --- |
| Nonce consumed | `is_nonce_used(client, ea195554…)` | `true` | `true` |
| Nonce replayed | Step 5 nonce, 1 UPSPIKE | `#7` NonceUsed | `Error(Contract, #7)` |
| Over the ceiling | max 100,000,000, actual 100,000,001 | `#2` AmountExceedsMax | `Error(Contract, #2)` |
| Zero ceiling | max 0, actual 0 | `#1` InvalidAmount | `Error(Contract, #1)` |
| Past deadline | deadline 1790928519 (now − 60 s) | `#5` Expired | `Error(Contract, #5)` |
| Paying yourself | `to` = client | `#3` SelfPayment | `Error(Contract, #3)` |
| Paying the proxy | `to` = proxy `CBEPV3…` | `#8` InvalidRecipient | `Error(Contract, #8)` |

In the replay case the CLI signed a new auth entry, so this tests the contract's own nonce check.
Step 11 S2 tests replaying the original signature.

## Steps 8 and 8b: facilitator binding

**Result: passed after one correction.** Step 8 settled when the test expected a rejection. That
was right, because the facilitator really did sign. Step 8b, the corrected version, showed that
settling requires the bound facilitator's authorization.

**Purpose:** show that only the facilitator named in the client's signed payload can complete a
settlement.

**Step 8 (test design was wrong):** the seller submits, and the facilitator is given as a raw `G…`
address. The assumption was that the CLI could not sign for it.

```sh
settle $((10*UNIT)) $UNIT $(openssl rand -hex 32) "" upto-spike-seller upto-spike-seller GA2YE73MBZHOSSPZROCWNFRM2GFNW4QYRYJ3VQQ3XFJDIBBPVQMZTR5Z
```

- Tx `e05a48a0fa0e12a69492b3ebdde6b665c7d7324b51b8fd540c960bf657b7ea41` succeeded and moved 1
  UPSPIKE. The source was the seller, which paid 51,955 stroops.
- Decoding the envelope showed two address auth entries, one signed by the client `GB4HWP…` and
  one by the facilitator `GA2YE7…`.
- The cause: the CLI matched the facilitator's address to `upto-spike-facilitator` in the local
  keystore and signed its entry without saying so.
- So the contract behaved correctly. The facilitator authorized, as in spike scenario S8, where
  another account submits and the facilitator signs its own address entry.

**Step 8b (corrected):** bind the token contract as the facilitator. Nobody can sign for a contract
address from outside.

```sh
settle $((10*UNIT)) $UNIT $(openssl rand -hex 32) "" upto-spike-seller upto-spike-seller $TOKEN
```

- Simulation asked for auth from the bound facilitator `CCH46P…`, as well as from the client.
- The CLI stopped with `Missing signing key for account
  CCH46PUSMDVRYST4IC5QZ32OCSFGQV2SDM5MOJW3ETBYG5326OKHNQ2P`, and nothing was submitted.
- Balances afterwards: client 98,060,000,000, seller 2,940,000,000. That's Step 5 minus the 1
  UPSPIKE from Step 8, and unchanged by 8b.

**Checkpoint:** the facilitator's auth entry is only requested because the contract calls
`facilitator.require_auth()`, so the binding is enforced. Two other tests cover testnet refusing a
submitted transaction that lacks that entry: spike S5 in Step 11, and the unit test for missing
facilitator auth.

## Step 9: zero settlement

**Result: passed.** A settlement of 0 under a 10 UPSPIKE ceiling succeeded. It used up the nonce
and emitted the event, and no tokens moved.

**Purpose:** show that `actual_amount` = 0 is a valid settlement (spec §6). The contract approves
the ceiling and emits `upto_settled`, but makes no `transfer_from`.

```sh
settle $((10*UNIT)) 0 $(openssl rand -hex 32)
```

| Result | Value |
| --- | --- |
| Tx | `175903815ba110eb7466b4812d35c13d4425ded2bb497c243612e9fd9433188a`, successful |
| Events | `approve` 100,000,000 until ledger 4,982,009; `upto_settled` with `actual_amount` 0 and nonce `6b996033…dec9`; no `transfer` |
| Source and fee account | facilitator `GA2YE7…` |
| Fee charged | 32,664 stroops |
| Balances | client 98,060,000,000, seller 2,940,000,000, unchanged (confirmed in Step 8b) |

## Step 10: resource cost and real fees

**Result: recorded.** A normal settlement costs the facilitator about 30,000–41,000 stroops
(0.003–0.004 XLM). The client's first settlement through a proxy cost 97,963.

**Purpose:** measure the real cost of one settlement on testnet, for 0005. The local estimate in
Step 1 left out rent and signature checks.

**What was run:** the planned command, `stellar contract invoke --send=no --cost`, printed no cost
block. stellar-cli 28.1 doesn't print `--cost` output together with `--send=no`. The numbers below
come instead from two sources:

- a read-only `simulateTransaction` on testnet RPC, using a transaction built with `--build-only`
  (actual = 500 of 100 UPSPIKE)
- the envelopes and charged fees of the transactions sent in Steps 5, 8 and 9

| Transaction | Case | Fee charged (stroops) | Instructions declared | Disk read / write (B) |
| --- | --- | --- | --- | --- |
| `b49cec5f…6067` | Step 5, 37.5 of 100, the client's first `approve` to this proxy | 97,963 | 1,569,128 | 392 / 792 |
| `e05a48a0…ea41` | Step 8, 1 of 10, seller as source with facilitator address auth | 51,955 | 2,163,413 | 536 / 868 |
| `17590381…188a` | Step 9, 0 of 10 | 32,664 | 1,391,795 | 144 / 544 |
| simulation | 500 stroops of 100 | (resource fee estimate 603,206) | 1,597,188 | 392 / 792 |

The declared instructions are the simulation's limits, which include RPC headroom and the client's
signature check. They are therefore above the local 903,417. The fee charged is the real cost, and
the unused part of the resource fee is refunded. A fair guess at why Step 5 cost more is that it
created the client → proxy allowance entry, which later settlements only update. Step 11 fits
that: later settlements cost 30,090–40,699 stroops.

## Step 11: x402 flow, spike scenarios S1–S8

**Result: passed, 9 of 9.** One client signature settled amounts different from the one simulated,
and replaying, redirecting or taking over that signature was refused.

**Purpose:** the CLI simulates and signs again on every call, so Steps 5–9 can't show one signature
being used for a different amount. The 0002 spike client (`spike.ts`, `@stellar/stellar-sdk`
17.2.0) runs the real x402 flow:

1. The client simulates with `actual = max` and signs only its own auth entry.
2. The facilitator swaps in the actual amount, simulates again and submits.

Its `settle_upto` interface is identical to this contract's, so it ran against the new proxy
unchanged. The secrets are read from the local keystore at run time and are not recorded.

```sh
cd lore/1-tasks/archive/0002_RESEARCH_upto-proxy-design-on-soroban/spike/client
CLIENT_SECRET=$(stellar keys show upto-spike-client) \
FACILITATOR_SECRET=$(stellar keys show upto-spike-facilitator) \
SELLER_SECRET=$(stellar keys show upto-spike-seller) \
CHANNEL_SECRET=$(stellar keys show upto-spike-channel) \
TOKEN_ID=$TOKEN PROXY_ID=$PROXY node spike.ts
```

The run started at 2026-10-02 08:16:38 UTC. The client-signed tree was
`settle_upto(token, to, facilitator, 1000000000, nonce 0x4a0417ad…, 1790928910, 1790929570)` with
`approve(client, proxy, 1000000000, 4981196)`.

| Scenario | Expected | Result | Tx | Fee (stroops) |
| --- | --- | --- | --- | --- |
| S1: settle 37.5 of 100 (signed at 100) | success | success; client −375,000,000, seller +375,000,000 | `b45b1b74bbf240c222aee048842f8febeef242f8e1be43bbc94f7ef0a27594b1` | 40,693 |
| S2: replay the S1 entry at 1 | reject | `Error(Auth, ExistingValue)` | — | — |
| S3: change the recipient | reject | `Error(Auth, InvalidAction)` | — | — |
| S4: actual above max | reject | `Error(Contract, #2)` | — | — |
| S5: a different party settles | reject | `Error(Auth, InvalidAction)` | — | — |
| S6: zero amount | success | success | `cb711fde33b5efa1f01fc4be8ce65cec96bf0b35ac1573eb67b1b348a031be84` | 30,090 |
| S7b: second authorization settles first, 20 | success | success | `e39674393d8ce24cb63a4db4477e461421c98d6276d3aa8628705c6d4853a8de` | 40,699 |
| S7a: first authorization settles at max, 50 | success | success | `b1bc1a657bf7c784dcfbc8ef28d358d85ef96e4c5e7819d605636de5c59127b5` | 40,693 |
| S8: channel account as source, facilitator address auth | success | success; channel paid, facilitator paid 0 | `5707ab115961e4b68555b745f26de5170f93ee28720da889b87f98e2cfdfdbd5` | 49,356 |

Over the whole run, the client's XLM changed by 0 and the facilitator's by −152,175 stroops.

**Checkpoint:** each successful transaction was decoded from Horizon. All five target `CBEPV3…`.

- **S1, S6, S7b, S7a:** source `GA2YE7…` (the facilitator), with the client's address entry plus
  source-account auth. `actual_amount` was 375,000,000, 0, 200,000,000 and 500,000,000
  respectively.
- **S8:** source `GCKKQX…` (the channel account), with two address entries (client and
  facilitator) and `actual_amount` 30,000,000.

## Property coverage

Every `upto` property has at least one on-chain result above, and so do 6 of the 8 spec error
codes.

| Property | Proven by | Evidence |
| --- | --- | --- |
| Settle any amount from 0 to the signed ceiling | Steps 5, 9; S1, S6, S7a, S7b | 37.5, 0, 20 and 50 (= max) settled; tx `b49cec5f…`, `17590381…`, `b45b1b74…`, `cb711fde…`, `e3967439…`, `b1bc1a65…` |
| The signed payload leaves out `actual_amount` | Step 5 auth entry; S1 | 7 signed args without `actual_amount` or `from`; one signature settled 37.5 after simulating with 100 |
| The ceiling holds | Step 7; S4 | `Error(Contract, #2)` |
| One-time use (nonce and signature) | Step 6; S2 | `is_nonce_used` = `true`, `#7`, `Error(Auth, ExistingValue)` |
| Bound to the recipient and terms | S3 | `Error(Auth, InvalidAction)` |
| Bound to the facilitator | Step 8b; S5; S8 | missing facilitator auth requested and not signable; `Error(Auth, InvalidAction)`; channel source works only with the facilitator's own entry |
| Time window and allowance expiration | Steps 5, 7 | inclusive window accepted; past deadline `#5`; `approve` carries the signed expiration ledger |
| Input checks | Step 7 | `#1` InvalidAmount, `#3` SelfPayment, `#8` InvalidRecipient |
| Client pays no fees | Steps 5, 9; Step 11 total | the facilitator or channel is the source and fee account; client XLM delta 0 |
| Settlement event | Steps 5, 9 | `upto_settled` with token, from, to, facilitator, max, actual and nonce |
| Deployed code = reviewed code | Steps 1, 3 | the fetched on-chain WASM hash is `be2ba121…0b34` |

Errors `#4` NotYetValid and `#6` InvalidAllowanceExpiration were not hit on testnet. The unit tests
cover both.

## Deviations, limits and cleanup

**Deviations from the plan.** Two, neither caused by the contract:

- **Step 8:** the CLI signs auth entries for any address it holds a key for, even when the address
  is given as a raw `G…`. The test was replaced by Step 8b. The Step 8 transaction still stands as
  valid proof that a different account can submit when the facilitator signs its own address
  entry.
- **Step 10:** `--cost` prints nothing together with `--send=no` in stellar-cli 28.1. The cost was
  taken instead from RPC simulation and from the sent transactions.

**Limits.**

- One token, a SAC. The non-SAC SEP-41 token is covered only by the unit tests.
- `#4` NotYetValid and `#6` InvalidAllowanceExpiration were not tested on testnet.
- The script-driven, repeatable version of this test, with recorded hashes and fees, is task 0004.

**Cleanup.**

- `spike.ts` overwrote `spike/results/testnet-run.json`, the archived 0002 evidence. It was
  restored with `git checkout --`, and `git status` was clean afterwards.
- The proxy `CBEPV3…` stays on testnet as reference until the next testnet reset.
