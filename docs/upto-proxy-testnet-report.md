# UptoProxy testnet report

What `UptoProxy` ([README](../contracts/upto-proxy/README.md),
[ADR 0010](adr/0010-upto-proxy-design.md)) does and costs on Stellar testnet: the end-to-end run,
the cost of keeping the contract alive (task 0035), and the throughput measured in task 0006.

**57/57 scenarios passed** on 2026-10-09 at 11:58 UTC, with 21 settlement transactions on the
proxy in ledgers 5,104,671–5,104,702, and 2 more on a fresh instance of it. The contract settled real payments in three tokens with the signing model the
x402 facilitator will use. Every settlement, rejection and tampering case behaved as the contract
specifies, the paying client paid no settlement fees, and the proxy's instance and code stayed at
the network's maximum TTL. A fresh instance of the same code extended itself by exactly 720 ledgers
on each settlement.

- This run tests the WASM with self-extension and the one-day cap on the allowance expiry (task 0035) at a new address. Earlier runs are in the git history of this file: 49/49 on 2026-10-08
  against the WASM without self-extension (`CC3VX7N6…Z7OYU`), and 50/50 on 2026-10-09 against the
  self-extending WASM without the cap (`CDSWGHBU…HEPD`).
- New in this run (from the 0035 security review): the contract's cap on the allowance expiry, the
  client's refusal to sign a forged simulated tree, the facilitator's window and signature-expiry
  checks, and the self-extension observed on a fresh instance.
- Data: [`testnet-results.json`](../contracts/upto-proxy/e2e/results/testnet-results.json),
  written by `pnpm contracts:e2e`. This report is a snapshot of the 2026-10-09 run; a new run
  rewrites the JSON, not this page.
- Interactive version of the 50/50 run, with the TTL measurements:
  <https://claude.ai/artifact/TNurkGqjefJWXtKCNPwkcE>. It is a claude.ai page shared by link; the
  JSON above is the source of record.

|                     |                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UptoProxy contract  | [`CAL7SBTOECJ6HXXO3ST43LM2HJJFSZ3ZDEEZBIWHJPB7DRF5MXS5V2VC`](https://testnet.sorobanscan.rumblefish.dev/contracts/CAL7SBTOECJ6HXXO3ST43LM2HJJFSZ3ZDEEZBIWHJPB7DRF5MXS5V2VC) |
| WASM hash           | `00a06b1683557a60d2822bbab4e1fee9012e9b521d52b22a8ab22fd47cd4b79c`                                                                                                          |
| RPC                 | `https://soroban-testnet.stellar.org`                                                                                                                                       |
| Facilitator account | [`GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM`](https://testnet.sorobanscan.rumblefish.dev/accounts/GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM)  |
| Client account      | [`GCADNNOZTTKEGX3Z2TA6O2MLPVPMPXL3OLI6UWWQNWZSEANFDOMNE6F6`](https://testnet.sorobanscan.rumblefish.dev/accounts/GCADNNOZTTKEGX3Z2TA6O2MLPVPMPXL3OLI6UWWQNWZSEANFDOMNE6F6)  |
| Seller account      | [`GARJEZ3CMPI6UJ7OAAX3GIQ5OVX3FJTCLC2DEZVLTUA2K62GY3HDKGTK`](https://testnet.sorobanscan.rumblefish.dev/accounts/GARJEZ3CMPI6UJ7OAAX3GIQ5OVX3FJTCLC2DEZVLTUA2K62GY3HDKGTK)  |

## How each payment was submitted

- **Client: signs one auth entry.** Simulates `settle_upto` with the ceiling as a placeholder and
  signs only its own authorization: the ceiling, recipient, token, facilitator, nonce and time
  window. It never builds, signs or pays for a transaction.
- **Facilitator: checks, then settles.** Compares the signed tree with the payment terms, swaps in
  the actual amount and submits through `SettlementSubmitter`. It is the operation source and pays
  the fee bump.
- **Channel account: provides the sequence number.** Each transaction uses one of 2 channel accounts
  as its source, so payments don't queue behind one account. The facilitator key is the channels'
  only signer.

## Scenario results

✅ settled on chain as expected (fee in stroops, with transaction links). ⛔ refused in the
submitter's enforcing simulation against live testnet state with the expected error, so nothing was
sent.

| Scenario                                              | Expected                                       | USDC (Circle testnet USDC, SAC)                                                                                                                                                                                                                                                      | UPTOE2E (self-issued asset, SAC)                                                                                                                                                                                                                                                     | TEST (in-repo non-SAC SEP-41)                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Settlements**                                       |                                                |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| Settles below the ceiling                             | success                                        | ✅ 40,944 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/78f72ec696fbd0641a5b563b86545cd1710ff52df982a4ac11e0628eecb323a5)                                                                                                                                           | ✅ 41,036 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/2875f322779ebd5ddae70a6ba039ffa17740940cfdbc5f5219ecf732f4d8591d)                                                                                                                                           | ✅ 35,955 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/c8eccf900053210ab2e2194195f79f24da7494ec157cf758bda30bb9dec5979d)                                                                                                                                           |
| Settles at the ceiling                                | success                                        | ✅ 40,944 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/514b9b0eed9f19dc8bdb3654486b0a32b82aca284b1542a00d29cde690728e38)                                                                                                                                           | ✅ 41,036 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/605565bcd8148b04b84b4811227911070e0e888ec373164049f3c4d8f9b7624d)                                                                                                                                           | ✅ 35,955 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/b1bfb173784a11cb7940dfa043ac10ba8b2deeb8f4546864e34a6cadf10d5a06)                                                                                                                                           |
| Settles zero                                          | success, no transfer, event and nonce recorded | ✅ 30,426 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/302ccab9a74cf9f8f6956df245d6144deeef3a156e988f97e24a14f365a8ac94)                                                                                                                                           | ✅ 30,427 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/27b9d47146bed5c300be9c318d03f971e030ef7c58f5bd9979a729c950de5404)                                                                                                                                           | ✅ 29,265 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/395f01bb8883e88669efda78610f28a89a6acd1fa77b0656e9b8beb49475b35e)                                                                                                                                           |
| **Rejections**                                        |                                                |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| Rejects an amount over the ceiling                    | AmountExceedsMax (#2)                          | ⛔ `Contract #2` AmountExceedsMax                                                                                                                                                                                                                                                    | ⛔ `Contract #2` AmountExceedsMax                                                                                                                                                                                                                                                    | ⛔ `Contract #2` AmountExceedsMax                                                                                                                                                                                                                                                    |
| Rejects a replayed auth entry                         | Error(Auth, ExistingValue)                     | ⛔ `Auth ExistingValue`                                                                                                                                                                                                                                                              | ⛔ `Auth ExistingValue`                                                                                                                                                                                                                                                              | ⛔ `Auth ExistingValue`                                                                                                                                                                                                                                                              |
| Rejects a reused nonce with a new signature           | NonceUsed (#7)                                 | ⛔ `Contract #7` NonceUsed                                                                                                                                                                                                                                                           | ⛔ `Contract #7` NonceUsed                                                                                                                                                                                                                                                           | ⛔ `Contract #7` NonceUsed                                                                                                                                                                                                                                                           |
| Rejects a settlement before valid_after               | NotYetValid (#4)                               | ⛔ `Contract #4` NotYetValid                                                                                                                                                                                                                                                         | ⛔ `Contract #4` NotYetValid                                                                                                                                                                                                                                                         | ⛔ `Contract #4` NotYetValid                                                                                                                                                                                                                                                         |
| Rejects a settlement after the deadline               | Expired (#5)                                   | ⛔ `Contract #5` Expired                                                                                                                                                                                                                                                             | ⛔ `Contract #5` Expired                                                                                                                                                                                                                                                             | ⛔ `Contract #5` Expired                                                                                                                                                                                                                                                             |
| Rejects an allowance expiry beyond the contract's cap | InvalidAllowanceExpiration (#6)                | ⛔ `Contract #6` InvalidAllowanceExpiration                                                                                                                                                                                                                                          | ⛔ `Contract #6` InvalidAllowanceExpiration                                                                                                                                                                                                                                          | ⛔ `Contract #6` InvalidAllowanceExpiration                                                                                                                                                                                                                                          |
| Rejects a different facilitator                       | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| **Tampering**                                         |                                                |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| Rejects a changed recipient                           | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| Rejects a changed token                               | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| Rejects a changed ceiling                             | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| Rejects a changed nonce                               | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| Rejects a changed facilitator                         | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| **Concurrency**                                       |                                                |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| Settles two authorizations one after the other        | both success                                   | ✅ 40,944 · 40,938 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/9f4906ce5bf5ab3a423d7fd1bc2f13c1e9741f810a0e07a46711707f1fb5f529) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/19068808195a31b40ba018a32052ebfa7169aa68974d41e294ec8fccd7bf111d) | ✅ 41,036 · 41,030 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/d01d43f8e6731a7632469fdf5ae968e355eae087de2804195e05b59845e79501) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/20b50a5cf217496b8bb5b46cc4e1582b958e69aefe623e5aee72c5ff7bf7249d) | ✅ 35,955 · 35,955 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/f4cd714692811a121a57de4e2cfbbffb76e487d348e499a49178c5b206aa3bb1) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/1cc5df6c70d022f5465261d2e605c96e7e5ca135e72761fcc77ab9b5643c6e4b) |
| Settles two authorizations in the same ledger         | both success, one ledger                       | ✅ 40,944 · 40,944 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/43751fdde1c0cba74d539f627e4b2873ff77c57b7ef24c33049f2e231782d3ff) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/e360563cbcbc422a62ef5b84bdf6ff8605bfc0b936922811b4be28e3ec73b746) | ✅ 41,036 · 41,036 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/bd5c54ca3ca9760b77af8be5093c083af030a438a9cbf89b86613b3ebfad075b) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/194105312d0d8c5605473f8216113743a5c612bed563f1c7842ddc525327a2c4) | ✅ 35,955 · 35,955 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/99871266c21d77ab99e12855170a5fe648b9ed42d76dbdb9a0eddf66cb531680) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/a219f9de3e5e7e6314581b5c2278ad445a3824c0910632c55a9ec6409b9214f4) |

These checks cover the whole run. The first three run off chain, on the client's and the
facilitator's side; the self-extension check settles twice on a fresh instance of the proxy:

| Check                                                                  | Expected                                             | Result                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client refuses a simulated tree that differs from the terms            | not signed                                           | ✅ a forged `token.transfer` tree refused, the honest tree signed                                                                                                                                                       |
| Facilitator refuses an allowance that outlives the window              | refused before settlement                            | ✅ an expiry 100,000 ledgers ahead refused (the window is 204)                                                                                                                                                          |
| Facilitator refuses a signature expiry that differs from the allowance | refused before settlement                            | ✅ refused                                                                                                                                                                                                              |
| Fresh proxy extends its instance by the cap per settlement             | instance +720 ledgers per settlement, code unchanged | ✅ [`CA64DB…XBJTCH`](https://testnet.sorobanscan.rumblefish.dev/contracts/CA64DBBNBZSBGSMAIJTKQA6SC3Z2HZTQHMN4BVUBSU75ZPO2OLXBJTCH): instance live until 5,225,663 → 5,226,383 → 5,227,103; code unchanged at 8,215,065 |
| Client pays no settlement fee                                          | client XLM balance unchanged                         | ✅ unchanged at 99,999,999,800 stroops                                                                                                                                                                                  |
| Proxy instance and code stay alive                                     | TTL ≥ 518,280 ledgers                                | ✅ instance 3,110,355, code 3,110,357 ledgers left at ledger 5,104,708                                                                                                                                                  |

## Cost per settlement

Fee charged to the facilitator for one settlement at the ceiling, and for a zero settlement, which
still records the nonce and the event but moves no tokens. The proxy's TTL was above its target,
so no settlement here paid for an extension.

| Token   | Contract                                                                                                                         | Settlement fee (stroops) | Zero settlement (stroops) | CPU instructions |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | -----------------------: | ------------------------: | ---------------: |
| USDC    | [`CBIELT…XQDAMA`](https://testnet.sorobanscan.rumblefish.dev/contracts/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |                   40,944 |                    30,426 |        1,606,530 |
| UPTOE2E | [`CCEAOQ…QG7DM5`](https://testnet.sorobanscan.rumblefish.dev/contracts/CCEAOQFKZWE2UXIU3CHKLCABAWP2QTK5IA46FMNTPTLFPWE27ZQG7DM5) |                   41,036 |                    30,427 |        1,611,331 |
| TEST    | [`CAFLGB…3HMQEO`](https://testnet.sorobanscan.rumblefish.dev/contracts/CAFLGBBXESMRLBFNTG3USDML66437G74EACP3LVOUZPUUJDJQT3HMQEO) |                   35,955 |                    29,265 |        2,259,801 |

Against the 2026-10-08 run of the WASM without self-extension, a settlement costs about 36 stroops
and 24,000 instructions more: the extension check when it does nothing, and the cap check on the
allowance expiry.

## What the run confirmed

- **The client pays no settlement fees.** Its XLM balance stayed at 99,999,999,800 stroops across
  every scenario; its only fees were for its two trustlines during setup. On each transaction the
  fee-bump payer and the operation source were the facilitator, and the source was a channel
  account.
- **Two payments from one payer can land in the same ledger.** USDC: both in ledger 5,104,680 ·
  UPTOE2E: both in 5,104,691 · TEST: both in 5,104,702, each on the first attempt. Each went
  through its own channel account.
- **Replays are refused twice over.** Reusing a signed entry fails in Soroban's own auth
  (`ExistingValue`). Re-signing the same payment nonce fails in the contract (`NonceUsed`).
- **The proxy stays alive.** After the run its instance and code had 3,110,355 and 3,110,357
  ledgers left, the network maximum set at deployment.
- **The proxy extends itself.** On a fresh instance, which starts at the network's minimum TTL,
  each of two settlements added exactly 720 ledgers to the instance. The WASM code is shared with
  the main proxy and was already above the target, so it didn't move. Those settlements cost
  46,888 and 43,850 stroops against 40,944 for the same USDC payment on the main proxy: about 2,900
  for extending the 96-byte instance by 720 ledgers, and about 3,000 more on the first one for the
  client's new allowance entry with the new proxy.
- **The allowance expiry is capped.** An expiry 17,380 ledgers ahead was refused with
  `InvalidAllowanceExpiration` (#6) for all three tokens; the facilitator's own check refuses
  anything past the payment window (204 ledgers here) before that.
- **Finding for the threat model: leftover allowance.** After a settlement, the proxy keeps the
  unused part of the ceiling as allowance until the allowance expiration ledger. Every settlement
  checks it: settling a quarter of a 1,000,000 ceiling left 750,000, and a zero settlement leaves
  the full ceiling. Only the proxy can spend it, and only with a new client signature and an unused
  nonce.

## Keeping the contract alive

The proxy's instance and WASM code are persistent entries that the network archives when their TTL
runs out. Two things keep them alive (task 0035, [ADR 0010](adr/0010-upto-proxy-design.md) D10):

- **At deployment**, `deploy-contract.sh` extends both to the network's maximum TTL, 3,110,399
  ledgers (about 180 days). For the first self-extending deployment the deployer paid 108.6 XLM to extend the proxy
  and the test token, an estimated 59 XLM of it for the proxy.
- **On every settlement**, the contract calls
  `extend_ttl_with_limits(518_400, 120, 720)`: toward 30 days, skipping gains under 120 ledgers
  (about 10 minutes), adding at most 720 ledgers (about 1 hour). The facilitator pays it inside
  the settlement fee.

**Measured rent.** Simulated `settle_upto` calls on a measurement deployment
(`CA6FI7OV…HXXWV`, same code with a 120,960-ledger cap), at four starting TTLs. Only the TTL
changed between them; the baseline is the call with no extension.

| Ledgers extended | Resource fee (stroops) | Above the baseline |
| ---------------: | ---------------------: | -----------------: |
|      0 (skipped) |                697,246 |           baseline |
|           17,280 |              4,138,691 |          3,441,445 |
|           60,000 |             12,632,250 |         11,935,004 |
|          120,960 |             24,752,273 |         24,055,027 |

The three extensions fit one line: **198.8 stroops per ledger** plus **about 5,800 per extension**.
Almost all of it is the 4,288-byte WASM code entry; the 96-byte instance costs about 0.6 stroops
per ledger. The baseline is high because simulation ran in recording-auth mode, which charges the
client's auth nonce differently from a signed settlement; it is the same in every row.

**What it means for a settlement.** With the cap at 720 ledgers, the costliest extending
settlement is about 44,000 + 5,800 + 720 × 198.8 ≈ 193,000 stroops, 77% of the default
250,000-stroop fee ceiling. Under steady traffic, at most one settlement every 10 minutes extends,
paying about 30,000 extra. Keeping the proxy alive costs about 3.4 million stroops (0.34 XLM) of
rent a day, whoever pays it. The first design, a 7-day cap, made one settlement cost 24 million
stroops, and the submitter refused it.

## Throughput and limits

Measured on testnet on 2026-10-05 in task 0006, against an earlier deployment of the same WASM
(proxy `CBEPV3F2…TEGY7`). The details and transaction hashes are in 0006's
[R-testnet-throughput-measurements](../lore/1-tasks/archive/0006_RESEARCH_upto-settlement-scaling/notes/R-testnet-throughput-measurements.md).

**Cost by transaction shape:**

| Shape                                                                                  |        Size | Fee charged (stroops) | Instructions |
| -------------------------------------------------------------------------------------- | ----------: | --------------------: | -----------: |
| Facilitator as transaction source                                                      |     2,352 B |                40,709 |       1.60 M |
| Channel transaction source, facilitator as operation source                            |     2,460 B |                41,180 |       1.60 M |
| The same, with a fee bump                                                              |     2,588 B |                41,279 |       1.60 M |
| Channel transaction source, facilitator address auth entry                             |     2,680 B |                49,368 |       2.15 M |
| **Recommended:** channel with the facilitator as signer, operation source and fee bump | **2,516 B** |            **40,965** |       1.60 M |

The recommended shape is `delegated-bump` ([ADR 0003](adr/0003-settlement-channel-account-pool.md)),
which the 0004 run above used.

**Throughput:**

| Setup                                                    | Result                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Single source account                                    | 1 pending transaction per account: 1 settlement per ledger, about 0.2/s                         |
| 5 / 20 / 50 channels                                     | 5 / 20 / 50 per ledger, no failures                                                             |
| 120 channels, many sellers                               | 478 of 480 settled on the first try (the other 2 failed on the bench side), peak 103 per ledger |
| 120 channels, one seller                                 | 480 of 480, peak 102 per ledger: no same-seller penalty                                         |
| Network ceiling (transaction size, 266,240 B per ledger) | about 105 settlements per ledger, about 20/s network-wide                                       |
| Mainnet free share (1 h sample, about 59% already used)  | about 43 per ledger, about 8/s                                                                  |
| `/verify` simulation (public testnet RPC)                | 0.3 s p50 at low load; levels off at about 150/s                                                |

## Known limits

- **One payment is one transaction.** A contract-call transaction holds one operation, and the
  contract has no batch entry point, so `upto` can't go beyond the network share above: about
  105 settlements per ledger on testnet, about 43 of mainnet's free share. Higher request rates
  need off-chain aggregation or a separate `batch-settlement` binding (0006's
  [S-session-aggregation](../lore/1-tasks/archive/0006_RESEARCH_upto-settlement-scaling/notes/S-session-aggregation.md),
  task 0008).
- **One-time rent.** The settlement that first creates or extends a ledger entry pays its rent. In
  0006 the first settlement of the day cost 151,550 stroops in total, 116,316 of it rent for a TTL
  extension. No settlement in this run cost more than 46,888.
- **The proxy's own extension.** Once its TTL is below 30 days, a settlement can pay up to about
  149,000 stroops for it, at most once per 10 minutes under steady traffic (above). The rent rate
  rises with the network's total state, so the cap's margin under the fee ceiling should be
  checked again before mainnet.
- **Rent on the allowance window.** The facilitator pays temporary rent on the nonce entry and the
  allowance until `allowance_expiration_ledger`: about 1.3 stroops per ledger, measured by
  simulation on this proxy's predecessor. A day ahead, the contract's cap, costs about 25,000; the
  network's maximum would have cost 3.9 million, which is why the contract caps it (ADR 0010, D11)
  and the facilitator holds it to the payment window.
- **Leftover allowance.** After a settlement the proxy keeps `max_amount - actual_amount` of
  allowance until `allowance_expiration_ledger` (750,000 after settling 250,000 of a 1,000,000
  ceiling here). Only the proxy can spend it, under a new client signature. See the
  [threat model](threat-model.md#upto-contract).
- **Rejections are caught before sending.** They were refused in the submitter's enforcing
  simulation against live testnet state, so they have no transaction hash. A payload whose state
  changes between simulation and inclusion would fail on chain and still be charged.
- **Testnet resets** wipe the accounts, contracts and transactions in this report. The deploy
  script restores the proxy at the same ID; the links stop working.

## All settlement transactions

| Token   | Scenario                                                   |    Ledger | Fee (stroops) | Instructions | Size (bytes) | Channel         | Transaction                                                                                                                             |
| ------- | ---------------------------------------------------------- | --------: | ------------: | -----------: | -----------: | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| USDC    | settles below the ceiling                                  | 5,104,671 |        40,944 |    1,606,530 |        2,500 | `GB7CH4…MK7Q7G` | [78f72ec696…](https://testnet.sorobanscan.rumblefish.dev/transactions/78f72ec696fbd0641a5b563b86545cd1710ff52df982a4ac11e0628eecb323a5) |
| USDC    | settles at the ceiling                                     | 5,104,673 |        40,944 |    1,606,530 |        2,500 | `GDWHQT…HR7ON2` | [514b9b0eed…](https://testnet.sorobanscan.rumblefish.dev/transactions/514b9b0eed9f19dc8bdb3654486b0a32b82aca284b1542a00d29cde690728e38) |
| USDC    | settles zero                                               | 5,104,674 |        30,426 |    1,395,837 |        2,332 | `GB7CH4…MK7Q7G` | [302ccab9a7…](https://testnet.sorobanscan.rumblefish.dev/transactions/302ccab9a74cf9f8f6956df245d6144deeef3a156e988f97e24a14f365a8ac94) |
| USDC    | settles two authorizations one after the other             | 5,104,677 |        40,944 |    1,606,530 |        2,500 | `GDWHQT…HR7ON2` | [9f4906ce5b…](https://testnet.sorobanscan.rumblefish.dev/transactions/9f4906ce5bf5ab3a423d7fd1bc2f13c1e9741f810a0e07a46711707f1fb5f529) |
| USDC    | settles two authorizations one after the other             | 5,104,678 |        40,938 |    1,597,743 |        2,500 | `GB7CH4…MK7Q7G` | [1906880819…](https://testnet.sorobanscan.rumblefish.dev/transactions/19068808195a31b40ba018a32052ebfa7169aa68974d41e294ec8fccd7bf111d) |
| USDC    | settles two authorizations in the same ledger              | 5,104,680 |        40,944 |    1,606,530 |        2,500 | `GDWHQT…HR7ON2` | [43751fdde1…](https://testnet.sorobanscan.rumblefish.dev/transactions/43751fdde1c0cba74d539f627e4b2873ff77c57b7ef24c33049f2e231782d3ff) |
| USDC    | settles two authorizations in the same ledger              | 5,104,680 |        40,944 |    1,606,530 |        2,500 | `GB7CH4…MK7Q7G` | [e360563cbc…](https://testnet.sorobanscan.rumblefish.dev/transactions/e360563cbcbc422a62ef5b84bdf6ff8605bfc0b936922811b4be28e3ec73b746) |
| UPTOE2E | settles below the ceiling                                  | 5,104,682 |        41,036 |    1,611,331 |        2,516 | `GDWHQT…HR7ON2` | [2875f32277…](https://testnet.sorobanscan.rumblefish.dev/transactions/2875f322779ebd5ddae70a6ba039ffa17740940cfdbc5f5219ecf732f4d8591d) |
| UPTOE2E | settles at the ceiling                                     | 5,104,684 |        41,036 |    1,611,331 |        2,516 | `GB7CH4…MK7Q7G` | [605565bcd8…](https://testnet.sorobanscan.rumblefish.dev/transactions/605565bcd8148b04b84b4811227911070e0e888ec373164049f3c4d8f9b7624d) |
| UPTOE2E | settles zero                                               | 5,104,685 |        30,427 |    1,397,198 |        2,332 | `GDWHQT…HR7ON2` | [27b9d47146…](https://testnet.sorobanscan.rumblefish.dev/transactions/27b9d47146bed5c300be9c318d03f971e030ef7c58f5bd9979a729c950de5404) |
| UPTOE2E | settles two authorizations one after the other             | 5,104,688 |        41,036 |    1,611,331 |        2,516 | `GB7CH4…MK7Q7G` | [d01d43f8e6…](https://testnet.sorobanscan.rumblefish.dev/transactions/d01d43f8e6731a7632469fdf5ae968e355eae087de2804195e05b59845e79501) |
| UPTOE2E | settles two authorizations one after the other             | 5,104,689 |        41,030 |    1,602,544 |        2,516 | `GDWHQT…HR7ON2` | [20b50a5cf2…](https://testnet.sorobanscan.rumblefish.dev/transactions/20b50a5cf217496b8bb5b46cc4e1582b958e69aefe623e5aee72c5ff7bf7249d) |
| UPTOE2E | settles two authorizations in the same ledger              | 5,104,691 |        41,036 |    1,611,331 |        2,516 | `GB7CH4…MK7Q7G` | [bd5c54ca3c…](https://testnet.sorobanscan.rumblefish.dev/transactions/bd5c54ca3ca9760b77af8be5093c083af030a438a9cbf89b86613b3ebfad075b) |
| UPTOE2E | settles two authorizations in the same ledger              | 5,104,691 |        41,036 |    1,611,331 |        2,516 | `GDWHQT…HR7ON2` | [194105312d…](https://testnet.sorobanscan.rumblefish.dev/transactions/194105312d0d8c5605473f8216113743a5c612bed563f1c7842ddc525327a2c4) |
| TEST    | settles below the ceiling                                  | 5,104,693 |        35,955 |    2,259,801 |        2,560 | `GDWHQT…HR7ON2` | [c8eccf9000…](https://testnet.sorobanscan.rumblefish.dev/transactions/c8eccf900053210ab2e2194195f79f24da7494ec157cf758bda30bb9dec5979d) |
| TEST    | settles at the ceiling                                     | 5,104,694 |        35,955 |    2,259,801 |        2,560 | `GB7CH4…MK7Q7G` | [b1bfb17378…](https://testnet.sorobanscan.rumblefish.dev/transactions/b1bfb173784a11cb7940dfa043ac10ba8b2deeb8f4546864e34a6cadf10d5a06) |
| TEST    | settles zero                                               | 5,104,696 |        29,265 |    1,651,532 |        2,328 | `GDWHQT…HR7ON2` | [395f01bb88…](https://testnet.sorobanscan.rumblefish.dev/transactions/395f01bb8883e88669efda78610f28a89a6acd1fa77b0656e9b8beb49475b35e) |
| TEST    | settles two authorizations one after the other             | 5,104,699 |        35,955 |    2,259,801 |        2,560 | `GB7CH4…MK7Q7G` | [f4cd714692…](https://testnet.sorobanscan.rumblefish.dev/transactions/f4cd714692811a121a57de4e2cfbbffb76e487d348e499a49178c5b206aa3bb1) |
| TEST    | settles two authorizations one after the other             | 5,104,700 |        35,955 |    2,259,801 |        2,560 | `GDWHQT…HR7ON2` | [1cc5df6c70…](https://testnet.sorobanscan.rumblefish.dev/transactions/1cc5df6c70d022f5465261d2e605c96e7e5ca135e72761fcc77ab9b5643c6e4b) |
| TEST    | settles two authorizations in the same ledger              | 5,104,702 |        35,955 |    2,259,801 |        2,560 | `GB7CH4…MK7Q7G` | [99871266c2…](https://testnet.sorobanscan.rumblefish.dev/transactions/99871266c21d77ab99e12855170a5fe648b9ed42d76dbdb9a0eddf66cb531680) |
| TEST    | settles two authorizations in the same ledger              | 5,104,702 |        35,955 |    2,259,801 |        2,560 | `GDWHQT…HR7ON2` | [a219f9de3e…](https://testnet.sorobanscan.rumblefish.dev/transactions/a219f9de3e5e7e6314581b5c2278ad445a3824c0910632c55a9ec6409b9214f4) |
| USDC    | fresh proxy extends its instance by the cap per settlement | 5,104,706 |        46,888 |    1,577,755 |        2,500 | `GB7CH4…MK7Q7G` | [a73a1d9eab…](https://testnet.sorobanscan.rumblefish.dev/transactions/a73a1d9eab55191d462fa2f00c974471b220c15a65fc5c57a34f82601aa77176) |
| USDC    | fresh proxy extends its instance by the cap per settlement | 5,104,708 |        43,850 |    1,608,009 |        2,500 | `GDWHQT…HR7ON2` | [e683bd80d7…](https://testnet.sorobanscan.rumblefish.dev/transactions/e683bd80d73840886e76a1b5d873876c6ec793a54636f3cce5277e83a5e460ba) |
