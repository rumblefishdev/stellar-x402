# UptoProxy end-to-end run on testnet

Task 0004 · Stellar testnet · 2026-10-08 at 13:41 UTC · 21 settlement transactions in ledgers 5,088,624–5,088,662

**49/49 scenarios passed.** Interactive version: <https://claude.ai/artifact/67u2tEX1kTCkcJLQAYgfKY>. Data: [`testnet-results.json`](testnet-results.json), written by `pnpm contracts:e2e`. This page is a snapshot of that run; a new run rewrites the JSON but not this page.

The `upto` proxy contract was deployed to testnet and settled real payments in three tokens, using the signing model the x402 facilitator will use. Every settlement, rejection and tampering case behaved as the contract specifies, and the paying client never spent any XLM on fees.

| | |
|---|---|
| UptoProxy contract | [`CC3VX7N6ILD63V7FS2JA7XUDX4DMHYEJXRZDOMU7GVW76XYINOAZ7OYU`](https://testnet.sorobanscan.rumblefish.dev/contracts/CC3VX7N6ILD63V7FS2JA7XUDX4DMHYEJXRZDOMU7GVW76XYINOAZ7OYU) |
| WASM hash | `be2ba12160a7e3e1a93ed0cb457b7e93cd6ed4c725cb51aeeb87313b45dd0b34` |
| RPC | `https://soroban-testnet.stellar.org` |
| Facilitator account | [`GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM`](https://testnet.sorobanscan.rumblefish.dev/accounts/GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM) |
| Client account | [`GCADNNOZTTKEGX3Z2TA6O2MLPVPMPXL3OLI6UWWQNWZSEANFDOMNE6F6`](https://testnet.sorobanscan.rumblefish.dev/accounts/GCADNNOZTTKEGX3Z2TA6O2MLPVPMPXL3OLI6UWWQNWZSEANFDOMNE6F6) |
| Seller account | [`GARJEZ3CMPI6UJ7OAAX3GIQ5OVX3FJTCLC2DEZVLTUA2K62GY3HDKGTK`](https://testnet.sorobanscan.rumblefish.dev/accounts/GARJEZ3CMPI6UJ7OAAX3GIQ5OVX3FJTCLC2DEZVLTUA2K62GY3HDKGTK) |

Testnet resets wipe these accounts, contracts and transactions.

## How each payment was submitted

- **Client: signs one auth entry.** Simulates `settle_upto` with the ceiling as a placeholder and signs only its own authorization: the ceiling, recipient, token, facilitator, nonce and time window. It never builds, signs or pays for a transaction.
- **Facilitator: checks, then settles.** Compares the signed tree with the payment terms, swaps in the actual amount and submits through `SettlementSubmitter`. It is the operation source and pays the fee bump.
- **Channel account: provides the sequence number.** Each transaction uses one of 2 channel accounts as its source, so payments don't queue behind one account. The facilitator key is the channels' only signer.

## Scenario results

✅ settled on chain as expected (fee in stroops, with transaction links). ⛔ refused in the submitter's enforcing simulation against live testnet state with the expected error, so nothing was sent.

| Scenario | Expected | USDC (Circle testnet USDC, SAC) | UPTOE2E (self-issued asset, SAC) | TEST (in-repo non-SAC SEP-41) |
|---|---|---|---|---|
| **Settlements** | | | | |
| Settles below the ceiling | success | ✅ 43,926 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/0158fa323f6bd0696856449d0719bb3646282dbc94eea1fd5bfdd570856e21b2) | ✅ 44,019 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/cd7d3348f8b59f19b5e870f994e7725bd0d222537299a49650c4088c8ce3a6be) | ✅ 38,882 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/51cff0d16344db3ec4f30c25a3c0da82cc37aab6d59b257327c31ac7cebc1ccf) |
| Settles at the ceiling | success | ✅ 40,907 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/c408aeeb7efed1e51e69532c2ed4da790b11aef6f5450db01cc7de007ec2a3b8) | ✅ 41,000 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/faa7f37a45a24ea46bd73ddee8991b9d7753b687ff075da386791372141f7590) | ✅ 35,925 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/e6b7647b3c494a210ac32607c751c4b98a852d072e00ea2e7eff610ad5e44e98) |
| Settles zero | success, no transfer, event and nonce recorded | ✅ 30,391 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/bb4fc785943fdad4e1ee68df3412b21267d19f45232d7ad7996fdcd2d20b3250) | ✅ 30,392 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/c91bdd01dba0dca827e1a5e7f80e5c6a844568feab272bf55d50c5342bec02a5) | ✅ 29,235 · [tx](https://testnet.sorobanscan.rumblefish.dev/transactions/ae16b397ff55f67b5f71df40b7b0f088039d0ae2936b96844541c11a139751ee) |
| **Rejections** | | | | |
| Rejects an amount over the ceiling | AmountExceedsMax (#2) | ⛔ `Contract #2` AmountExceedsMax | ⛔ `Contract #2` AmountExceedsMax | ⛔ `Contract #2` AmountExceedsMax |
| Rejects a replayed auth entry | Error(Auth, ExistingValue) | ⛔ `Auth ExistingValue` | ⛔ `Auth ExistingValue` | ⛔ `Auth ExistingValue` |
| Rejects a reused nonce with a new signature | NonceUsed (#7) | ⛔ `Contract #7` NonceUsed | ⛔ `Contract #7` NonceUsed | ⛔ `Contract #7` NonceUsed |
| Rejects a settlement before valid_after | NotYetValid (#4) | ⛔ `Contract #4` NotYetValid | ⛔ `Contract #4` NotYetValid | ⛔ `Contract #4` NotYetValid |
| Rejects a settlement after the deadline | Expired (#5) | ⛔ `Contract #5` Expired | ⛔ `Contract #5` Expired | ⛔ `Contract #5` Expired |
| Rejects a different facilitator | Error(Auth, InvalidAction) | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` |
| **Tampering** | | | | |
| Rejects a changed recipient | Error(Auth, InvalidAction) | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` |
| Rejects a changed token | Error(Auth, InvalidAction) | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` |
| Rejects a changed ceiling | Error(Auth, InvalidAction) | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` |
| Rejects a changed nonce | Error(Auth, InvalidAction) | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` |
| Rejects a changed facilitator | Error(Auth, InvalidAction) | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` | ⛔ `Auth InvalidAction` |
| **Concurrency** | | | | |
| Settles two authorizations one after the other | both success | ✅ 40,907 · 40,907 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/d66a76ffa2198e7c78ae67e6ad04202bf81633f95986c81debc86fa76cd8d672) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/ffd8179459ad5c4fbcb2a608bee94fc925e27c04c08f66640321a227aae023c0) | ✅ 41,000 · 41,000 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/75cb6aa664a6607ffb643ed844a5068c95de676aec63aff35f1c83e035e2b612) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/04d593a8e168e0f1c719ab70428689b7272e4abc279bae3440a05faafb2bc714) | ✅ 35,925 · 35,925 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/d6e2a3c7c7e4ac981802ac7025c88dd12a56b9b67e312384bbba72c55579c4db) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/b3f99f52a61560b41bf7e8bfd2057584a457eebd4a40965b4f560bdb3049ef23) |
| Settles two authorizations in the same ledger | both success, one ledger | ✅ 40,907 · 40,907 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/bb09d106f6b7fcc000c3f744c74c37687a8e9796faa94fbb27752a22e7b4b1f5) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/fd9808ba419a28355a345d38559c3d535decc8052b6a8a1e91ea5b5360918800) | ✅ 41,000 · 41,000 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/17a17c560a6cbe75256e6c9e808ccd4cddafe627713f6fbe081df9c283756bd7) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/eb88f6e56b1b78cf63781f735e9eef7f98a5c741aadca746370bd6419f23e9c1) | ✅ 35,925 · 35,925 · [tx1](https://testnet.sorobanscan.rumblefish.dev/transactions/0a39fa7467472c3eea0105fcf752e7c7fe07a415af44b9139fbd9189c076ff8f) [tx2](https://testnet.sorobanscan.rumblefish.dev/transactions/45e2ed3cc6d885e1a39225a01a6e9589407a9278fb80c160aa5bc3447d7053ae) |

## Cost per settlement

Fee charged to the facilitator for one settlement at the ceiling, and for a zero settlement, which still records the nonce and the event but moves no tokens.

| Token | Contract | Settlement fee (stroops) | Zero settlement (stroops) | CPU instructions |
|---|---|--:|--:|--:|
| USDC | [`CBIELT…XQDAMA`](https://testnet.sorobanscan.rumblefish.dev/contracts/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) | 40,907 | 30,391 | 1,582,440 |
| UPTOE2E | [`CCEAOQ…QG7DM5`](https://testnet.sorobanscan.rumblefish.dev/contracts/CCEAOQFKZWE2UXIU3CHKLCABAWP2QTK5IA46FMNTPTLFPWE27ZQG7DM5) | 41,000 | 30,392 | 1,587,240 |
| TEST | [`CAFLGB…3HMQEO`](https://testnet.sorobanscan.rumblefish.dev/contracts/CAFLGBBXESMRLBFNTG3USDML66437G74EACP3LVOUZPUUJDJQT3HMQEO) | 35,925 | 29,235 | 2,245,537 |

## What the run confirmed

- **The client pays no settlement fees.** Client XLM unchanged at 99999999800 stroops, across every scenario; its only fees were for its two trustlines during setup. On each transaction the fee-bump payer and the operation source were the facilitator, and the source was a channel account.
- **Two payments from one payer can land in the same ledger.** USDC: both in ledger 5088635 (attempt 1) · UPTOE2E: both in ledger 5088648 (attempt 1) · TEST: both in ledger 5088662 (attempt 1). Each went through its own channel account.
- **Replays are refused twice over.** Reusing a signed entry fails in Soroban's own auth (`ExistingValue`). Re-signing the same payment nonce fails in the contract (`NonceUsed`).
- **Finding for the threat model (task 0005): leftover allowance.** After a settlement, the proxy keeps the unused part of the ceiling as allowance until the allowance expiration ledger. Every settlement asserts it: settling a quarter of a 1,000,000 ceiling left 750,000, and a zero settlement leaves the full ceiling. Only the proxy can spend it, and only with a new client signature and an unused nonce.

## All settlement transactions

| Token | Scenario | Ledger | Fee (stroops) | Instructions | Size (bytes) | Channel | Transaction |
|---|---|--:|--:|--:|--:|---|---|
| USDC | settles below the ceiling | 5,088,624 | 43,926 | 1,560,973 | 2,500 | `GB7CH4…MK7Q7G` | [`0158fa323f…`](https://testnet.sorobanscan.rumblefish.dev/transactions/0158fa323f6bd0696856449d0719bb3646282dbc94eea1fd5bfdd570856e21b2) |
| USDC | settles at the ceiling | 5,088,626 | 40,907 | 1,582,440 | 2,500 | `GDWHQT…HR7ON2` | [`c408aeeb7e…`](https://testnet.sorobanscan.rumblefish.dev/transactions/c408aeeb7efed1e51e69532c2ed4da790b11aef6f5450db01cc7de007ec2a3b8) |
| USDC | settles zero | 5,088,628 | 30,391 | 1,374,404 | 2,332 | `GB7CH4…MK7Q7G` | [`bb4fc78594…`](https://testnet.sorobanscan.rumblefish.dev/transactions/bb4fc785943fdad4e1ee68df3412b21267d19f45232d7ad7996fdcd2d20b3250) |
| USDC | settles two authorizations one after the other | 5,088,632 | 40,907 | 1,582,440 | 2,500 | `GB7CH4…MK7Q7G` | [`d66a76ffa2…`](https://testnet.sorobanscan.rumblefish.dev/transactions/d66a76ffa2198e7c78ae67e6ad04202bf81633f95986c81debc86fa76cd8d672) |
| USDC | settles two authorizations one after the other | 5,088,633 | 40,907 | 1,582,440 | 2,500 | `GDWHQT…HR7ON2` | [`ffd8179459…`](https://testnet.sorobanscan.rumblefish.dev/transactions/ffd8179459ad5c4fbcb2a608bee94fc925e27c04c08f66640321a227aae023c0) |
| USDC | settles two authorizations in the same ledger | 5,088,635 | 40,907 | 1,582,440 | 2,500 | `GB7CH4…MK7Q7G` | [`bb09d106f6…`](https://testnet.sorobanscan.rumblefish.dev/transactions/bb09d106f6b7fcc000c3f744c74c37687a8e9796faa94fbb27752a22e7b4b1f5) |
| USDC | settles two authorizations in the same ledger | 5,088,635 | 40,907 | 1,582,440 | 2,500 | `GDWHQT…HR7ON2` | [`fd9808ba41…`](https://testnet.sorobanscan.rumblefish.dev/transactions/fd9808ba419a28355a345d38559c3d535decc8052b6a8a1e91ea5b5360918800) |
| UPTOE2E | settles below the ceiling | 5,088,637 | 44,019 | 1,565,774 | 2,516 | `GB7CH4…MK7Q7G` | [`cd7d3348f8…`](https://testnet.sorobanscan.rumblefish.dev/transactions/cd7d3348f8b59f19b5e870f994e7725bd0d222537299a49650c4088c8ce3a6be) |
| UPTOE2E | settles at the ceiling | 5,088,638 | 41,000 | 1,587,240 | 2,516 | `GDWHQT…HR7ON2` | [`faa7f37a45…`](https://testnet.sorobanscan.rumblefish.dev/transactions/faa7f37a45a24ea46bd73ddee8991b9d7753b687ff075da386791372141f7590) |
| UPTOE2E | settles zero | 5,088,640 | 30,392 | 1,375,766 | 2,332 | `GB7CH4…MK7Q7G` | [`c91bdd01db…`](https://testnet.sorobanscan.rumblefish.dev/transactions/c91bdd01dba0dca827e1a5e7f80e5c6a844568feab272bf55d50c5342bec02a5) |
| UPTOE2E | settles two authorizations one after the other | 5,088,644 | 41,000 | 1,587,240 | 2,516 | `GB7CH4…MK7Q7G` | [`75cb6aa664…`](https://testnet.sorobanscan.rumblefish.dev/transactions/75cb6aa664a6607ffb643ed844a5068c95de676aec63aff35f1c83e035e2b612) |
| UPTOE2E | settles two authorizations one after the other | 5,088,646 | 41,000 | 1,587,240 | 2,516 | `GDWHQT…HR7ON2` | [`04d593a8e1…`](https://testnet.sorobanscan.rumblefish.dev/transactions/04d593a8e168e0f1c719ab70428689b7272e4abc279bae3440a05faafb2bc714) |
| UPTOE2E | settles two authorizations in the same ledger | 5,088,648 | 41,000 | 1,587,240 | 2,516 | `GB7CH4…MK7Q7G` | [`17a17c560a…`](https://testnet.sorobanscan.rumblefish.dev/transactions/17a17c560a6cbe75256e6c9e808ccd4cddafe627713f6fbe081df9c283756bd7) |
| UPTOE2E | settles two authorizations in the same ledger | 5,088,648 | 41,000 | 1,587,240 | 2,516 | `GDWHQT…HR7ON2` | [`eb88f6e56b…`](https://testnet.sorobanscan.rumblefish.dev/transactions/eb88f6e56b1b78cf63781f735e9eef7f98a5c741aadca746370bd6419f23e9c1) |
| TEST | settles below the ceiling | 5,088,650 | 38,882 | 2,228,825 | 2,560 | `GB7CH4…MK7Q7G` | [`51cff0d163…`](https://testnet.sorobanscan.rumblefish.dev/transactions/51cff0d16344db3ec4f30c25a3c0da82cc37aab6d59b257327c31ac7cebc1ccf) |
| TEST | settles at the ceiling | 5,088,652 | 35,925 | 2,245,537 | 2,560 | `GDWHQT…HR7ON2` | [`e6b7647b3c…`](https://testnet.sorobanscan.rumblefish.dev/transactions/e6b7647b3c494a210ac32607c751c4b98a852d072e00ea2e7eff610ad5e44e98) |
| TEST | settles zero | 5,088,654 | 29,235 | 1,637,268 | 2,328 | `GB7CH4…MK7Q7G` | [`ae16b397ff…`](https://testnet.sorobanscan.rumblefish.dev/transactions/ae16b397ff55f67b5f71df40b7b0f088039d0ae2936b96844541c11a139751ee) |
| TEST | settles two authorizations one after the other | 5,088,658 | 35,925 | 2,245,537 | 2,560 | `GB7CH4…MK7Q7G` | [`d6e2a3c7c7…`](https://testnet.sorobanscan.rumblefish.dev/transactions/d6e2a3c7c7e4ac981802ac7025c88dd12a56b9b67e312384bbba72c55579c4db) |
| TEST | settles two authorizations one after the other | 5,088,660 | 35,925 | 2,245,537 | 2,560 | `GDWHQT…HR7ON2` | [`b3f99f52a6…`](https://testnet.sorobanscan.rumblefish.dev/transactions/b3f99f52a61560b41bf7e8bfd2057584a457eebd4a40965b4f560bdb3049ef23) |
| TEST | settles two authorizations in the same ledger | 5,088,662 | 35,925 | 2,245,537 | 2,560 | `GB7CH4…MK7Q7G` | [`0a39fa7467…`](https://testnet.sorobanscan.rumblefish.dev/transactions/0a39fa7467472c3eea0105fcf752e7c7fe07a415af44b9139fbd9189c076ff8f) |
| TEST | settles two authorizations in the same ledger | 5,088,662 | 35,925 | 2,245,537 | 2,560 | `GDWHQT…HR7ON2` | [`45e2ed3cc6…`](https://testnet.sorobanscan.rumblefish.dev/transactions/45e2ed3cc6d885e1a39225a01a6e9589407a9278fb80c160aa5bc3447d7053ae) |
