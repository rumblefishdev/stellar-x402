# UptoProxy testnet report

What `UptoProxy` ([README](../contracts/upto-proxy/README.md),
[ADR 0010](adr/0010-upto-proxy-design.md)) does and costs on Stellar testnet: the end-to-end run,
the cost of keeping the contract alive (task 0035), and the throughput measured in task 0006.

**50/50 scenarios passed** on 2026-10-09 at 09:03 UTC, with 21 settlement transactions in ledgers
5,102,576–5,102,601. The contract settled real payments in three tokens with the signing model the
x402 facilitator will use. Every settlement, rejection and tampering case behaved as the contract
specifies, the paying client paid no settlement fees, and the proxy's instance and code stayed at
the network's maximum TTL.

- This run tests the WASM with self-extension (task 0035) at a new address. The first run, on
  2026-10-08 against the previous WASM (`CC3VX7N6…Z7OYU`), passed 49/49 with the same results; it
  is in the git history of this file.
- Data: [`testnet-results.json`](../contracts/upto-proxy/e2e/results/testnet-results.json),
  written by `pnpm contracts:e2e`. This report is a snapshot of the 2026-10-09 run; a new run
  rewrites the JSON, not this page.

|                     |                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UptoProxy contract  | [`CDSWGHBULAYAQX77CPHYOUDDUFMT6ZJBCY5FPUK7N3B2JFS32VNYHEPD`](https://testnet.sorobanscan.rumblefish.dev/contracts/CDSWGHBULAYAQX77CPHYOUDDUFMT6ZJBCY5FPUK7N3B2JFS32VNYHEPD) |
| WASM hash           | `8019c086e6e1aabe8295c010f1167a87e33d23c3292e3e4620e82c273ac9ed6d`                                                                                                          |
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

| Scenario                                       | Expected                                       | USDC (Circle testnet USDC, SAC)                                                                                                                                                                                                                                                      | UPTOE2E (self-issued asset, SAC)                                                                                                                                                                                                                                                     | TEST (in-repo non-SAC SEP-41)                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Settlements**                                |                                                |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| Settles below the ceiling                      | success                                        | ✅ 43,965 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/87326a08a8641025dc0fd30d9c6475f06d12f2b590b24da991f18df1b6073bac)                                                                                                                                           | ✅ 44,057 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/ab040ac35b8cc9fd5a21a660b9f4f3627945cbe011a516ed612e262244559036)                                                                                                                                           | ✅ 38,918 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/5f19eb04c9d576d8ddd279bdc95c1d951cda108cea2b2a7f84a8577f7212d51a)                                                                                                                                           |
| Settles at the ceiling                         | success                                        | ✅ 40,930 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/a7de409e934cfc409c634290c5417a42b454d20c48a05643eaaf6f8d0fe70c8a)                                                                                                                                           | ✅ 41,023 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/68e06afcf378f26b4c4a0004cbf4d51030893b7e68ba966f0e5d7c01a059d859)                                                                                                                                           | ✅ 35,948 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/7909c8a0f386316d25323d1515597ec3afd64b53f76838f1d95ca9afb21b11b6)                                                                                                                                           |
| Settles zero                                   | success, no transfer, event and nonce recorded | ✅ 30,413 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/2686b1839af27a84678e6161c7cef28fb036f5917cbd55197b0e4a0e8fb2f02f)                                                                                                                                           | ✅ 30,414 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/207de99615e85a4d9d346a3284ad8cb116ee398c83110ef41783bb0b9297c9b1)                                                                                                                                           | ✅ 29,258 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/d95faf6f7611941e6c9084bba467811b6503fd520e6c80d4706c203c50ac3af1)                                                                                                                                           |
| **Rejections**                                 |                                                |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| Rejects an amount over the ceiling             | AmountExceedsMax (#2)                          | ⛔ `Contract #2` AmountExceedsMax                                                                                                                                                                                                                                                    | ⛔ `Contract #2` AmountExceedsMax                                                                                                                                                                                                                                                    | ⛔ `Contract #2` AmountExceedsMax                                                                                                                                                                                                                                                    |
| Rejects a replayed auth entry                  | Error(Auth, ExistingValue)                     | ⛔ `Auth ExistingValue`                                                                                                                                                                                                                                                              | ⛔ `Auth ExistingValue`                                                                                                                                                                                                                                                              | ⛔ `Auth ExistingValue`                                                                                                                                                                                                                                                              |
| Rejects a reused nonce with a new signature    | NonceUsed (#7)                                 | ⛔ `Contract #7` NonceUsed                                                                                                                                                                                                                                                           | ⛔ `Contract #7` NonceUsed                                                                                                                                                                                                                                                           | ⛔ `Contract #7` NonceUsed                                                                                                                                                                                                                                                           |
| Rejects a settlement before valid_after        | NotYetValid (#4)                               | ⛔ `Contract #4` NotYetValid                                                                                                                                                                                                                                                         | ⛔ `Contract #4` NotYetValid                                                                                                                                                                                                                                                         | ⛔ `Contract #4` NotYetValid                                                                                                                                                                                                                                                         |
| Rejects a settlement after the deadline        | Expired (#5)                                   | ⛔ `Contract #5` Expired                                                                                                                                                                                                                                                             | ⛔ `Contract #5` Expired                                                                                                                                                                                                                                                             | ⛔ `Contract #5` Expired                                                                                                                                                                                                                                                             |
| Rejects a different facilitator                | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| **Tampering**                                  |                                                |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| Rejects a changed recipient                    | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| Rejects a changed token                        | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| Rejects a changed ceiling                      | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| Rejects a changed nonce                        | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| Rejects a changed facilitator                  | Error(Auth, InvalidAction)                     | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              | ⛔ `Auth InvalidAction`                                                                                                                                                                                                                                                              |
| **Concurrency**                                |                                                |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                      |
| Settles two authorizations one after the other | both success                                   | ✅ 40,930 · 40,930 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/6d65d151a56cd1ab54c0e1040451fc299a4516e30826caee4da69ca11db645a2) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/2689bd9e7383771c113493ade6b8aec440017f6b5b4485617f8cd60639070845) | ✅ 41,023 · 41,023 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/e974122f8853fdffad96a714305f9872e379c6e951f3549f05e1ec9e0dbc8750) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/18240f9428c683907769f0506b764ae23134ccb161baff5d1cff4bc5cfa580bd) | ✅ 35,948 · 35,948 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/ed5848cdbfbd05bd7158b73322500bd63b188fc507900a6f7629c0974fc7aeea) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/3276fdc55de322935c99ce9702918ee1e8a5584099c45843a2a2e0acdf2c57de) |
| Settles two authorizations in the same ledger  | both success, one ledger                       | ✅ 40,930 · 40,930 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/a147897720b1fcc0fe343ecde3fcb3eac3a27d719f62d10aa6cb52ed3679868e) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/4215556b9f410baf7b19e02c8e32b8c0472d20c17f77909a8c9d8a878a97a8b7) | ✅ 41,023 · 41,023 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/7aea0d8c48c53060c41e8584c7955e793880ba389a6ab55f51b6d71aa7417f45) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/1a9d3c7be0091383c06d0d4893a27ee5bfd4f7e02a217962645810eedc188b73) | ✅ 35,948 · 35,948 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/434aea51b91052ed41d4deefd9045c5260dc395fcbcdf4dd695f5e758c4cdbd5) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/204ffc721c9feef34d8d7e06b0b97f36e58b4699655ee873c4e24e9e61cc4340) |

Two checks cover the whole run:

| Check                              | Expected                     | Result                                                                 |
| ---------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| Client pays no settlement fee      | client XLM balance unchanged | ✅ unchanged at 99,999,999,800 stroops                                 |
| Proxy instance and code stay alive | TTL ≥ 518,280 ledgers        | ✅ instance 3,110,368, code 3,110,369 ledgers left at ledger 5,102,601 |

## Cost per settlement

Fee charged to the facilitator for one settlement at the ceiling, and for a zero settlement, which
still records the nonce and the event but moves no tokens. The proxy's TTL was above its target,
so no settlement here paid for an extension.

| Token   | Contract                                                                                                                         | Settlement fee (stroops) | Zero settlement (stroops) | CPU instructions |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | -----------------------: | ------------------------: | ---------------: |
| USDC    | [`CBIELT…XQDAMA`](https://testnet.sorobanscan.rumblefish.dev/contracts/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |                   40,930 |                    30,413 |        1,596,639 |
| UPTOE2E | [`CCEAOQ…QG7DM5`](https://testnet.sorobanscan.rumblefish.dev/contracts/CCEAOQFKZWE2UXIU3CHKLCABAWP2QTK5IA46FMNTPTLFPWE27ZQG7DM5) |                   41,023 |                    30,414 |        1,601,439 |
| TEST    | [`CAFLGB…3HMQEO`](https://testnet.sorobanscan.rumblefish.dev/contracts/CAFLGBBXESMRLBFNTG3USDML66437G74EACP3LVOUZPUUJDJQT3HMQEO) |                   35,948 |                    29,258 |        2,259,736 |

Against the 2026-10-08 run of the previous WASM, a settlement costs 23 stroops and about 14,000
instructions more: the cost of the extension check when it does nothing.

## What the run confirmed

- **The client pays no settlement fees.** Its XLM balance stayed at 99,999,999,800 stroops across
  every scenario; its only fees were for its two trustlines during setup. On each transaction the
  fee-bump payer and the operation source were the facilitator, and the source was a channel
  account.
- **Two payments from one payer can land in the same ledger.** USDC: both in ledger 5,102,582 ·
  UPTOE2E: both in 5,102,591 · TEST: both in 5,102,601, each on the first attempt. Each went
  through its own channel account.
- **Replays are refused twice over.** Reusing a signed entry fails in Soroban's own auth
  (`ExistingValue`). Re-signing the same payment nonce fails in the contract (`NonceUsed`).
- **The proxy stays alive.** After the run its instance and code had 3,110,368 and 3,110,369
  ledgers left, the network maximum set at deployment.
- **Finding for the threat model: leftover allowance.** After a settlement, the proxy keeps the
  unused part of the ceiling as allowance until the allowance expiration ledger. Every settlement
  checks it: settling a quarter of a 1,000,000 ceiling left 750,000, and a zero settlement leaves
  the full ceiling. Only the proxy can spend it, and only with a new client signature and an unused
  nonce.

## Keeping the contract alive

The proxy's instance and WASM code are persistent entries that the network archives when their TTL
runs out. Two things keep them alive (task 0035, [ADR 0010](adr/0010-upto-proxy-design.md) D10):

- **At deployment**, `deploy-contract.sh` extends both to the network's maximum TTL, 3,110,399
  ledgers (about 180 days). For this deployment the deployer paid 108.6 XLM to extend the proxy
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
  extension. No settlement in this run cost more than 44,057.
- **The proxy's own extension.** Once its TTL is below 30 days, a settlement can pay up to about
  149,000 stroops for it, at most once per 10 minutes under steady traffic (above). The rent rate
  rises with the network's total state, so the cap's margin under the fee ceiling should be
  checked again before mainnet.
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

| Token   | Scenario                                       |    Ledger | Fee (stroops) | Instructions | Size (bytes) | Channel         | Transaction                                                                                                                             |
| ------- | ---------------------------------------------- | --------: | ------------: | -----------: | -----------: | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| USDC    | settles below the ceiling                      | 5,102,576 |        43,965 |    1,575,172 |        2,500 | `GB7CH4…MK7Q7G` | [87326a08a8…](https://testnet.sorobanscan.rumblefish.dev/transactions/87326a08a8641025dc0fd30d9c6475f06d12f2b590b24da991f18df1b6073bac) |
| USDC    | settles at the ceiling                         | 5,102,577 |        40,930 |    1,596,639 |        2,500 | `GDWHQT…HR7ON2` | [a7de409e93…](https://testnet.sorobanscan.rumblefish.dev/transactions/a7de409e934cfc409c634290c5417a42b454d20c48a05643eaaf6f8d0fe70c8a) |
| USDC    | settles zero                                   | 5,102,578 |        30,413 |    1,388,493 |        2,332 | `GB7CH4…MK7Q7G` | [2686b1839a…](https://testnet.sorobanscan.rumblefish.dev/transactions/2686b1839af27a84678e6161c7cef28fb036f5917cbd55197b0e4a0e8fb2f02f) |
| USDC    | settles two authorizations one after the other | 5,102,580 |        40,930 |    1,596,639 |        2,500 | `GB7CH4…MK7Q7G` | [6d65d151a5…](https://testnet.sorobanscan.rumblefish.dev/transactions/6d65d151a56cd1ab54c0e1040451fc299a4516e30826caee4da69ca11db645a2) |
| USDC    | settles two authorizations one after the other | 5,102,581 |        40,930 |    1,596,639 |        2,500 | `GDWHQT…HR7ON2` | [2689bd9e73…](https://testnet.sorobanscan.rumblefish.dev/transactions/2689bd9e7383771c113493ade6b8aec440017f6b5b4485617f8cd60639070845) |
| USDC    | settles two authorizations in the same ledger  | 5,102,582 |        40,930 |    1,596,639 |        2,500 | `GB7CH4…MK7Q7G` | [a147897720…](https://testnet.sorobanscan.rumblefish.dev/transactions/a147897720b1fcc0fe343ecde3fcb3eac3a27d719f62d10aa6cb52ed3679868e) |
| USDC    | settles two authorizations in the same ledger  | 5,102,582 |        40,930 |    1,596,639 |        2,500 | `GDWHQT…HR7ON2` | [4215556b9f…](https://testnet.sorobanscan.rumblefish.dev/transactions/4215556b9f410baf7b19e02c8e32b8c0472d20c17f77909a8c9d8a878a97a8b7) |
| UPTOE2E | settles below the ceiling                      | 5,102,584 |        44,057 |    1,579,973 |        2,516 | `GDWHQT…HR7ON2` | [ab040ac35b…](https://testnet.sorobanscan.rumblefish.dev/transactions/ab040ac35b8cc9fd5a21a660b9f4f3627945cbe011a516ed612e262244559036) |
| UPTOE2E | settles at the ceiling                         | 5,102,586 |        41,023 |    1,601,439 |        2,516 | `GB7CH4…MK7Q7G` | [68e06afcf3…](https://testnet.sorobanscan.rumblefish.dev/transactions/68e06afcf378f26b4c4a0004cbf4d51030893b7e68ba966f0e5d7c01a059d859) |
| UPTOE2E | settles zero                                   | 5,102,587 |        30,414 |    1,389,854 |        2,332 | `GDWHQT…HR7ON2` | [207de99615…](https://testnet.sorobanscan.rumblefish.dev/transactions/207de99615e85a4d9d346a3284ad8cb116ee398c83110ef41783bb0b9297c9b1) |
| UPTOE2E | settles two authorizations one after the other | 5,102,589 |        41,023 |    1,601,439 |        2,516 | `GDWHQT…HR7ON2` | [e974122f88…](https://testnet.sorobanscan.rumblefish.dev/transactions/e974122f8853fdffad96a714305f9872e379c6e951f3549f05e1ec9e0dbc8750) |
| UPTOE2E | settles two authorizations one after the other | 5,102,590 |        41,023 |    1,601,439 |        2,516 | `GB7CH4…MK7Q7G` | [18240f9428…](https://testnet.sorobanscan.rumblefish.dev/transactions/18240f9428c683907769f0506b764ae23134ccb161baff5d1cff4bc5cfa580bd) |
| UPTOE2E | settles two authorizations in the same ledger  | 5,102,591 |        41,023 |    1,601,439 |        2,516 | `GDWHQT…HR7ON2` | [7aea0d8c48…](https://testnet.sorobanscan.rumblefish.dev/transactions/7aea0d8c48c53060c41e8584c7955e793880ba389a6ab55f51b6d71aa7417f45) |
| UPTOE2E | settles two authorizations in the same ledger  | 5,102,591 |        41,023 |    1,601,439 |        2,516 | `GB7CH4…MK7Q7G` | [1a9d3c7be0…](https://testnet.sorobanscan.rumblefish.dev/transactions/1a9d3c7be0091383c06d0d4893a27ee5bfd4f7e02a217962645810eedc188b73) |
| TEST    | settles below the ceiling                      | 5,102,592 |        38,918 |    2,243,024 |        2,560 | `GDWHQT…HR7ON2` | [5f19eb04c9…](https://testnet.sorobanscan.rumblefish.dev/transactions/5f19eb04c9d576d8ddd279bdc95c1d951cda108cea2b2a7f84a8577f7212d51a) |
| TEST    | settles at the ceiling                         | 5,102,594 |        35,948 |    2,259,736 |        2,560 | `GB7CH4…MK7Q7G` | [7909c8a0f3…](https://testnet.sorobanscan.rumblefish.dev/transactions/7909c8a0f386316d25323d1515597ec3afd64b53f76838f1d95ca9afb21b11b6) |
| TEST    | settles zero                                   | 5,102,596 |        29,258 |    1,651,468 |        2,328 | `GDWHQT…HR7ON2` | [d95faf6f76…](https://testnet.sorobanscan.rumblefish.dev/transactions/d95faf6f7611941e6c9084bba467811b6503fd520e6c80d4706c203c50ac3af1) |
| TEST    | settles two authorizations one after the other | 5,102,599 |        35,948 |    2,259,736 |        2,560 | `GDWHQT…HR7ON2` | [ed5848cdbf…](https://testnet.sorobanscan.rumblefish.dev/transactions/ed5848cdbfbd05bd7158b73322500bd63b188fc507900a6f7629c0974fc7aeea) |
| TEST    | settles two authorizations one after the other | 5,102,600 |        35,948 |    2,259,736 |        2,560 | `GB7CH4…MK7Q7G` | [3276fdc55d…](https://testnet.sorobanscan.rumblefish.dev/transactions/3276fdc55de322935c99ce9702918ee1e8a5584099c45843a2a2e0acdf2c57de) |
| TEST    | settles two authorizations in the same ledger  | 5,102,601 |        35,948 |    2,259,736 |        2,560 | `GDWHQT…HR7ON2` | [434aea51b9…](https://testnet.sorobanscan.rumblefish.dev/transactions/434aea51b91052ed41d4deefd9045c5260dc395fcbcdf4dd695f5e758c4cdbd5) |
| TEST    | settles two authorizations in the same ledger  | 5,102,601 |        35,948 |    2,259,736 |        2,560 | `GB7CH4…MK7Q7G` | [204ffc721c…](https://testnet.sorobanscan.rumblefish.dev/transactions/204ffc721c9feef34d8d7e06b0b97f36e58b4699655ee873c4e24e9e61cc4340) |
