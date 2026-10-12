# UptoProxy testnet report

What `UptoProxy` ([README](../contracts/upto-proxy/README.md),
[ADR 0010](adr/0010-upto-proxy-design.md)) does and costs on Stellar testnet: the end-to-end run,
the cost of keeping the contract alive (task 0035), and the throughput measured in task 0006.

**58/58 scenarios passed** on 2026-10-09 at 13:03 UTC, with 21 settlement transactions on the
proxy in ledgers 5,105,444–5,105,479, and 2 more on a fresh instance of it. The contract settled real payments in three tokens with the signing model the
x402 facilitator will use. Every settlement, rejection and tampering case behaved as the contract
specifies, the paying client paid no settlement fees, and the proxy's instance and code stayed at
the network's maximum TTL. A fresh instance of the same code extended itself by exactly 720 ledgers
on each settlement.

- This run tests the WASM with self-extension and the one-day cap on the allowance expiry (task 0035) at a new address. Earlier runs are in the git history of this file: 49/49 on 2026-10-08
  against the WASM without self-extension (`CC3VX7N6…Z7OYU`), and 50/50 on 2026-10-09 against the
  self-extending WASM without the cap (`CDSWGHBU…HEPD`).
- New in this run (from the 0035 security review): the contract's cap on the allowance expiry, the
  client's refusal to sign a forged simulated tree, the facilitator's window and signature-expiry
  checks (an allowance that outlives the window or ends before the deadline, a signature that
  expires apart from it), and the self-extension observed on a fresh instance. The 57/57 run
  before the PR review's fixes is in the git history.
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
| Settles below the ceiling                             | success                                        | ✅ 43,982 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/056bf5bbba2370c487b1af37696c7111a9108bef1a02baa9e17bbaee491a1afc)                                                                                                                                           | ✅ 44,074 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/26facdf315982ae72b45cbe0aebd9027c5f49650d957e5b05031ca852c04fc47)                                                                                                                                           | ✅ 38,933 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/906ad60ea31c6a427b6a05fec3f6e96fbd4f64d7d1b8b33f07b2b776025c0379)                                                                                                                                           |
| Settles at the ceiling                                | success                                        | ✅ 40,944 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/d1cf109499ec20ccdff6f23f5528a643e891eb59f3a281b88dba859dc70800b5)                                                                                                                                           | ✅ 41,036 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/5f4fea5a34ab849fadb452d10356d74db28291bfd41b996029b2eae8cc552914)                                                                                                                                           | ✅ 35,955 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/a64792172ef79cf30512db7189ca9b7defa6a58e9f270a2db68c33ace02a1d72)                                                                                                                                           |
| Settles zero                                          | success, no transfer, event and nonce recorded | ✅ 30,426 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/fd6dd16e477feea8e2872fad6b843e7eecf2a0662222973f556782d0cce6d2b8)                                                                                                                                           | ✅ 30,427 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/154fe449963aa70444c3def6c14e57d6efbbb1074cf1c7df75a828a9662b106b)                                                                                                                                           | ✅ 29,265 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/c21ca861c49e6dd83a72ebd1663e9c41d47e29707ddbc6a36a804b2a4bac359a)                                                                                                                                           |
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
| Settles two authorizations one after the other        | both success                                   | ✅ 40,944 · 40,938 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/1aa3f1b68276ba6d74fa87b6bd0fba9970fffc2d7adbd83ad4470dca26e5bcf5) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/49b50c61ba79ea1b7faadfeaaf2475867d59b387303159bad2f84db91ebac5c2) | ✅ 41,036 · 41,030 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/307f8d265259014a3d8d4478b01031a1877c717f20ee29dc832c998185b54030) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/a2c75875d4ad05ae0f29f231d21b026375e81429cce41dbeea14ac63df6e9748) | ✅ 35,955 · 35,955 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/f4b42a49b78a27b20c1ae91b6086b228ea8914b35ca9b16e9e287bc88607b146) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/5bf43202566e778ff104073415ffbf9ff3a3ea306d522b09a6554074737f5edd) |
| Settles two authorizations in the same ledger         | both success, one ledger                       | ✅ 40,944 · 40,944 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/59872b9aabd37b2488a3e038f78c6fb4524324f629078e2b1ba9af8e1d68407c) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/830ae683d6de0754ebae0ef94ef8f705563aa622267b1fb7e2fecf21d2bcc4e5) | ✅ 41,036 · 41,036 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/5c9caadb53767f1092834960228f5524609cb3235b9bfb667d50e1de23064b3d) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/ca76e47e3851454b84ee7c9991d258d8537f0c13024e4f79d86429a3a4775825) | ✅ 35,955 · 35,955 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/007b0ae2f6ded15e12eb268a68c0fb7191593bda1a43107e22673834015a5590) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/3e590698de74566121c02966338236907e88008b3157cedfd581d75b44286bf2) |

These checks cover the whole run. The first four run off chain, on the client's and the
facilitator's side; the self-extension check settles twice on a fresh instance of the proxy:

| Check                                                                  | Expected                                             | Result                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client refuses a simulated tree that differs from the terms            | not signed                                           | ✅ a forged `token.transfer` tree refused, the honest tree signed                                                                                                                                                       |
| Facilitator refuses an allowance that outlives the window              | refused before settlement                            | ✅ an expiry 100,000 ledgers ahead refused (the window is 204)                                                                                                                                                          |
| Facilitator refuses an allowance that ends before the deadline         | refused before settlement                            | ✅ an allowance 2 ledgers long refused for a 15-minute deadline (the deadline's ledger was 5,105,646)                                                                                                                   |
| Facilitator refuses a signature expiry that differs from the allowance | refused before settlement                            | ✅ refused                                                                                                                                                                                                              |
| Fresh proxy extends its instance by the cap per settlement             | instance +720 ledgers per settlement, code unchanged | ✅ [`CBPUP5…W4MBGA`](https://testnet.sorobanscan.rumblefish.dev/contracts/CBPUP5UONTDW5FXCX6FE5PWXT5M4LA7BF5NIM7PDHEAU4UFYCDW4MBGA): instance live until 5,226,440 → 5,227,160 → 5,227,880; code unchanged at 8,215,837 |
| Client pays no settlement fee                                          | client XLM balance unchanged                         | ✅ unchanged at 99,999,999,800 stroops                                                                                                                                                                                  |
| Proxy instance and code stay alive                                     | TTL ≥ 518,280 ledgers                                | ✅ instance 3,110,351, code 3,110,353 ledgers left at ledger 5,105,484                                                                                                                                                  |

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
- **Two payments from one payer can land in the same ledger.** USDC: both in ledger 5,105,452 ·
  UPTOE2E: both in 5,105,465 · TEST: both in 5,105,479, each on the first attempt. Each went
  through its own channel account.
- **Replays are refused twice over.** Reusing a signed entry fails in Soroban's own auth
  (`ExistingValue`). Re-signing the same payment nonce fails in the contract (`NonceUsed`).
- **The proxy stays alive.** After the run its instance and code had 3,110,351 and 3,110,353
  ledgers left, the network maximum set at deployment.
- **The proxy extends itself.** On a fresh instance, which starts at the network's minimum TTL,
  each of two settlements added exactly 720 ledgers to the instance. The WASM code is shared with
  the main proxy and was already above the target, so it didn't move. Those settlements cost
  46,886 and 43,849 stroops against 40,944 for the same USDC payment on the main proxy: about 2,900
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
settlement is about 44,000 + 5,800 + 720 × 198.8 ≈ 193,000 stroops, plus about 21,500 for an
allowance expiry at the contract's 17,280-ledger cap: about 215,000, 86% of the default
250,000-stroop fee ceiling. Rent the token charges in the same settlement comes on top (see
[Known limits](#known-limits)). Below the target every settlement extends, as the fresh instance
shows; once the TTL is at the target, at most about one settlement every 10 minutes extends under
steady traffic, paying about 30,000 extra. Keeping the proxy alive costs about 3.4 million stroops (0.34 XLM) of
rent a day, whoever pays it. The first design, a 7-day cap, made one settlement cost 24 million
stroops, and the submitter refused it.

**The stacked worst case, measured.** Rent the token charges comes on top of the proxy's. Three
real settlements on 2026-10-09 (ledgers 5,105,712–5,105,714) measured it, with the fee ceiling
raised so the first could go through:

- **Proxy:** a fresh instance and a fresh code entry of the same contract (a 4,260-byte build
  with one extra metadata entry, so it has its own code entry), both at the network's minimum
  TTL, so every settlement extends both by 720 ledgers.
- **Token:** the 0006 bench SAC (`CCH46PUS…`), whose instance had 3.84 days left, below its own
  6-day threshold.
- **Accounts:** 0006 bench accounts as payer and seller, settling 1 unit.

| Settlement                                                                                                                                          | Paid for                                                                                           | Fee charged | Of which rent |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------: | ------------: |
| [A: everything stacked](https://testnet.sorobanscan.rumblefish.dev/transactions/ee7c200af14ac4878f81b317f5bdb8c2c098d51e12fcd59a0c5b322987fa6ac7)   | proxy and code +720, SAC instance +54,689 ledgers, a new allowance entry, expiry at the 17,280 cap |     330,032 |       294,530 |
| [B: SAC already extended](https://testnet.sorobanscan.rumblefish.dev/transactions/af64c124bdd6958d0b08436f5a8110ed7c6b66224c469cef70d21a0388ecbaa6) | proxy and code +720, expiry at the cap                                                             |     185,818 |       150,295 |
| [C: short expiry](https://testnet.sorobanscan.rumblefish.dev/transactions/12eedf4c668018b740382e3feb3657bfffeea72014f52fc1404f211d31a1ec31)         | proxy and code +720, expiry 200 ledgers ahead                                                      |     173,317 |       137,803 |

- **The stack is over the ceiling.** A costs 330,032 stroops, 132% of the default 250,000-stroop
  ceiling: with default settings the facilitator refuses this valid payment before sending it.
- **Where it comes from.** About 132,000 is the proxy's own extension (C less a normal 41,000
  settlement), a little under the 149,000 estimate above. About 12,500 is the expiry at the cap
  (B − C). About 144,000 is the SAC extending its 480-byte instance plus the new allowance entry
  (A − B): 2.4 stroops per ledger of SAC extension.
- **It can be worse.** A SAC instance close to expiry extends by up to 7 days (120,960 ledgers),
  about 290,000 on its own; stacked with B that is about 480,000. That is an extrapolation, not a
  measurement.
- **It isn't specific to `upto`.** Any call into a SAC pays its instance extension, `exact`
  included; the proxy's extension is what takes the total over. Busy tokens rarely hit it:
  Circle's testnet USDC instance had 120 days left. Task 0015 sizes the `upto` fee ceiling for it
  and keeps the accepted tokens' instances alive outside settlements.

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
  extension. No settlement in this run cost more than 46,886.
- **The proxy's own extension.** Once its TTL is below 30 days, a settlement can pay up to about
  149,000 stroops for it; every settlement while the TTL is well below the target, and about once
  per 10 minutes under steady traffic once it is there (above). If the token extends its own
  instance in the same settlement, the total passes 250,000 and a valid payment is refused:
  330,032 measured, up to about 480,000 extrapolated (above). The rent rate
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
| USDC    | settles below the ceiling                                  | 5,105,444 |        43,982 |    1,576,277 |        2,500 | `GB7CH4…MK7Q7G` | [056bf5bbba…](https://testnet.sorobanscan.rumblefish.dev/transactions/056bf5bbba2370c487b1af37696c7111a9108bef1a02baa9e17bbaee491a1afc) |
| USDC    | settles at the ceiling                                     | 5,105,445 |        40,944 |    1,606,530 |        2,500 | `GDWHQT…HR7ON2` | [d1cf109499…](https://testnet.sorobanscan.rumblefish.dev/transactions/d1cf109499ec20ccdff6f23f5528a643e891eb59f3a281b88dba859dc70800b5) |
| USDC    | settles zero                                               | 5,105,446 |        30,426 |    1,395,837 |        2,332 | `GB7CH4…MK7Q7G` | [fd6dd16e47…](https://testnet.sorobanscan.rumblefish.dev/transactions/fd6dd16e477feea8e2872fad6b843e7eecf2a0662222973f556782d0cce6d2b8) |
| USDC    | settles two authorizations one after the other             | 5,105,449 |        40,944 |    1,606,530 |        2,500 | `GDWHQT…HR7ON2` | [1aa3f1b682…](https://testnet.sorobanscan.rumblefish.dev/transactions/1aa3f1b68276ba6d74fa87b6bd0fba9970fffc2d7adbd83ad4470dca26e5bcf5) |
| USDC    | settles two authorizations one after the other             | 5,105,450 |        40,938 |    1,597,743 |        2,500 | `GB7CH4…MK7Q7G` | [49b50c61ba…](https://testnet.sorobanscan.rumblefish.dev/transactions/49b50c61ba79ea1b7faadfeaaf2475867d59b387303159bad2f84db91ebac5c2) |
| USDC    | settles two authorizations in the same ledger              | 5,105,452 |        40,944 |    1,606,530 |        2,500 | `GDWHQT…HR7ON2` | [59872b9aab…](https://testnet.sorobanscan.rumblefish.dev/transactions/59872b9aabd37b2488a3e038f78c6fb4524324f629078e2b1ba9af8e1d68407c) |
| USDC    | settles two authorizations in the same ledger              | 5,105,452 |        40,944 |    1,606,530 |        2,500 | `GB7CH4…MK7Q7G` | [830ae683d6…](https://testnet.sorobanscan.rumblefish.dev/transactions/830ae683d6de0754ebae0ef94ef8f705563aa622267b1fb7e2fecf21d2bcc4e5) |
| UPTOE2E | settles below the ceiling                                  | 5,105,454 |        44,074 |    1,581,077 |        2,516 | `GB7CH4…MK7Q7G` | [26facdf315…](https://testnet.sorobanscan.rumblefish.dev/transactions/26facdf315982ae72b45cbe0aebd9027c5f49650d957e5b05031ca852c04fc47) |
| UPTOE2E | settles at the ceiling                                     | 5,105,456 |        41,036 |    1,611,331 |        2,516 | `GDWHQT…HR7ON2` | [5f4fea5a34…](https://testnet.sorobanscan.rumblefish.dev/transactions/5f4fea5a34ab849fadb452d10356d74db28291bfd41b996029b2eae8cc552914) |
| UPTOE2E | settles zero                                               | 5,105,458 |        30,427 |    1,397,198 |        2,332 | `GB7CH4…MK7Q7G` | [154fe44996…](https://testnet.sorobanscan.rumblefish.dev/transactions/154fe449963aa70444c3def6c14e57d6efbbb1074cf1c7df75a828a9662b106b) |
| UPTOE2E | settles two authorizations one after the other             | 5,105,462 |        41,036 |    1,611,331 |        2,516 | `GDWHQT…HR7ON2` | [307f8d2652…](https://testnet.sorobanscan.rumblefish.dev/transactions/307f8d265259014a3d8d4478b01031a1877c717f20ee29dc832c998185b54030) |
| UPTOE2E | settles two authorizations one after the other             | 5,105,463 |        41,030 |    1,602,544 |        2,516 | `GB7CH4…MK7Q7G` | [a2c75875d4…](https://testnet.sorobanscan.rumblefish.dev/transactions/a2c75875d4ad05ae0f29f231d21b026375e81429cce41dbeea14ac63df6e9748) |
| UPTOE2E | settles two authorizations in the same ledger              | 5,105,465 |        41,036 |    1,611,331 |        2,516 | `GDWHQT…HR7ON2` | [5c9caadb53…](https://testnet.sorobanscan.rumblefish.dev/transactions/5c9caadb53767f1092834960228f5524609cb3235b9bfb667d50e1de23064b3d) |
| UPTOE2E | settles two authorizations in the same ledger              | 5,105,465 |        41,036 |    1,611,331 |        2,516 | `GB7CH4…MK7Q7G` | [ca76e47e38…](https://testnet.sorobanscan.rumblefish.dev/transactions/ca76e47e3851454b84ee7c9991d258d8537f0c13024e4f79d86429a3a4775825) |
| TEST    | settles below the ceiling                                  | 5,105,467 |        38,933 |    2,243,088 |        2,560 | `GDWHQT…HR7ON2` | [906ad60ea3…](https://testnet.sorobanscan.rumblefish.dev/transactions/906ad60ea31c6a427b6a05fec3f6e96fbd4f64d7d1b8b33f07b2b776025c0379) |
| TEST    | settles at the ceiling                                     | 5,105,469 |        35,955 |    2,259,801 |        2,560 | `GB7CH4…MK7Q7G` | [a64792172e…](https://testnet.sorobanscan.rumblefish.dev/transactions/a64792172ef79cf30512db7189ca9b7defa6a58e9f270a2db68c33ace02a1d72) |
| TEST    | settles zero                                               | 5,105,471 |        29,265 |    1,651,532 |        2,328 | `GDWHQT…HR7ON2` | [c21ca861c4…](https://testnet.sorobanscan.rumblefish.dev/transactions/c21ca861c49e6dd83a72ebd1663e9c41d47e29707ddbc6a36a804b2a4bac359a) |
| TEST    | settles two authorizations one after the other             | 5,105,475 |        35,955 |    2,259,801 |        2,560 | `GB7CH4…MK7Q7G` | [f4b42a49b7…](https://testnet.sorobanscan.rumblefish.dev/transactions/f4b42a49b78a27b20c1ae91b6086b228ea8914b35ca9b16e9e287bc88607b146) |
| TEST    | settles two authorizations one after the other             | 5,105,477 |        35,955 |    2,259,801 |        2,560 | `GDWHQT…HR7ON2` | [5bf4320256…](https://testnet.sorobanscan.rumblefish.dev/transactions/5bf43202566e778ff104073415ffbf9ff3a3ea306d522b09a6554074737f5edd) |
| TEST    | settles two authorizations in the same ledger              | 5,105,479 |        35,955 |    2,259,801 |        2,560 | `GB7CH4…MK7Q7G` | [007b0ae2f6…](https://testnet.sorobanscan.rumblefish.dev/transactions/007b0ae2f6ded15e12eb268a68c0fb7191593bda1a43107e22673834015a5590) |
| TEST    | settles two authorizations in the same ledger              | 5,105,479 |        35,955 |    2,259,801 |        2,560 | `GDWHQT…HR7ON2` | [3e590698de…](https://testnet.sorobanscan.rumblefish.dev/transactions/3e590698de74566121c02966338236907e88008b3157cedfd581d75b44286bf2) |
| USDC    | fresh proxy extends its instance by the cap per settlement | 5,105,483 |        46,886 |    1,576,611 |        2,500 | `GDWHQT…HR7ON2` | [999ac4b94a…](https://testnet.sorobanscan.rumblefish.dev/transactions/999ac4b94a396089f683374535338a8a116618f3647dbac5d6c5819a86aa45cf) |
| USDC    | fresh proxy extends its instance by the cap per settlement | 5,105,484 |        43,849 |    1,606,865 |        2,500 | `GB7CH4…MK7Q7G` | [0389a4a605…](https://testnet.sorobanscan.rumblefish.dev/transactions/0389a4a605e1b8528a6cd9517901f163ebb01ffe4993dbdea595048140e4deb3) |
