# Conformance report

Our facilitator passes the x402 Foundation's own end-to-end suite on Stellar testnet: 18 of 18
`exact` scenarios, each one settled on chain and checked there. This page says what ran, against
what, what each payment was checked for, and what a pass does not show. It is the RFP's
"Conformance report with e2e results and settled transaction hashes"
([RFP](../docs/rfp/07-x402-facilitator-bazaar.md), Expected deliverables), as of Tranche 1.

## The run

|             |                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date        | 2026-11-10, 08:50–09:03 UTC (the suite itself: 11.0 minutes)                                                                                                                                                                                              |
| Suite       | [x402-foundation/x402](https://github.com/x402-foundation/x402) at `8827cf19fa9a7b120588b8cc56f56a3def13bb97`, unmodified: the gate stops if any tracked file of the checkout changed ([`src/upstream.ts`](src/upstream.ts), `assertClean`)               |
| Facilitator | `https://x402-facilitator.sorobanscan.com`, commit `5d2e26ba141747db0713efd9e4b2dfd1b2510f69` (the fourth run of the Deploy production workflow, on `deploy/production`; `/health` named this commit at the run)                                          |
| Fee payer   | `GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP`, the signer its `/supported` lists                                                                                                                                                             |
| Gate        | this repo's [`conformance/`](README.md) at `49e5b727d3993ac8cb63a232932839fae42d962a`                                                                                                                                                                     |
| Command     | `pnpm test --testnet --families=stellar --schemes=exact --facilitators=stellar-x402`                                                                                                                                                                      |
| Result      | 18 of 18 passed, suite exit code 0, the gate's checks passed with no problem                                                                                                                                                                              |
| Files       | [`results/testnet-hosted/suite.json`](results/testnet-hosted/suite.json) (the suite's own output, byte for byte) and [`gate.json`](results/testnet-hosted/gate.json) (the gate's checks, each transaction as the chain shows it, and its signed envelope) |

## What each scenario proves

Each scenario is one canonical x402 client paying one canonical x402 server, with our facilitator
settling the payment. The suite picks the scenarios: every TypeScript client and server it has for
Stellar, over HTTP and MCP, each on two routes. On the plain route the server asks the facilitator
to verify, serves, then settles: these 9 scenarios are the `exact` verify → settle of the Tranche 1
bar. On the `upfront` route it settles before it serves, with no verify, as upstream's resource
server does for that route (`typescript/packages/core/src/server/paymentFlow.ts` at the pinned
commit): these 9 show settle alone.

A scenario passes only when the suite says so and the gate, reading the transaction back from
Stellar RPC, finds that it:

- succeeded on chain, in a ledger after the last one closed before the run started;
- is one `transfer` of 0.001 testnet USDC from the suite's buyer to its seller;
- had its fee paid by our facilitator's signer, so the buyer paid no network fee;
- is reported by no other scenario.

## The settlements

| #   | Client                  | Server                    | Route or tool                         | Order                 | Transaction                                                                                                                        | Ledger  |
| --- | ----------------------- | ------------------------- | ------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `typescript/http/axios` | `typescript/http/express` | `/exact/stellar`                      | verify, serve, settle | [`259d727f5e31dce9…`](https://stellar.expert/explorer/testnet/tx/259d727f5e31dce9f76a075c965ab52ba756d30ade8c81ad11bfd53a0cdd9daf) | 5655406 |
| 2   | `typescript/http/axios` | `typescript/http/express` | `/exact/stellar/upfront`              | settle, serve         | [`79b2949d4f437251…`](https://stellar.expert/explorer/testnet/tx/79b2949d4f43725142a2496dd0eeb7b6f49e91576331336cb876c9bdfbbf1675) | 5655408 |
| 3   | `typescript/http/fetch` | `typescript/http/express` | `/exact/stellar`                      | verify, serve, settle | [`84ddd855c5ea9256…`](https://stellar.expert/explorer/testnet/tx/84ddd855c5ea92568d11bc8dcf324907d16945c85f39771f338f6af1101940ef) | 5655415 |
| 4   | `typescript/http/fetch` | `typescript/http/express` | `/exact/stellar/upfront`              | settle, serve         | [`f169897c47c05088…`](https://stellar.expert/explorer/testnet/tx/f169897c47c0508800613e80fe1ead8d68860402b5fa852e7e1c503aa22bea33) | 5655422 |
| 5   | `typescript/http/axios` | `typescript/http/fastify` | `/exact/stellar`                      | verify, serve, settle | [`c423f7fad5e02d03…`](https://stellar.expert/explorer/testnet/tx/c423f7fad5e02d0357ad7bda170f9c9092c6f69bd818879c758f922e6ec65b62) | 5655429 |
| 6   | `typescript/http/axios` | `typescript/http/fastify` | `/exact/stellar/upfront`              | settle, serve         | [`caf391cb39e787a3…`](https://stellar.expert/explorer/testnet/tx/caf391cb39e787a368825fc3bee72f61ff056d18df9e492b4664cbfb71e4b5c4) | 5655433 |
| 7   | `typescript/http/fetch` | `typescript/http/fastify` | `/exact/stellar`                      | verify, serve, settle | [`3afc9be14fa254e0…`](https://stellar.expert/explorer/testnet/tx/3afc9be14fa254e03891f6fb517e92ff49174f3ea2202cff3eaf51eb4f9a7024) | 5655442 |
| 8   | `typescript/http/fetch` | `typescript/http/fastify` | `/exact/stellar/upfront`              | settle, serve         | [`48d6ec07de9fefc4…`](https://stellar.expert/explorer/testnet/tx/48d6ec07de9fefc45dbb0b3d57b66279eb64b5b2d3411a6832f22122fa89bad3) | 5655448 |
| 9   | `typescript/http/axios` | `typescript/http/hono`    | `/exact/stellar`                      | verify, serve, settle | [`ee442bdc8232fead…`](https://stellar.expert/explorer/testnet/tx/ee442bdc8232feadc94518197bdb49b75be274099b93b90351c1f1c78c5912a7) | 5655461 |
| 10  | `typescript/http/axios` | `typescript/http/hono`    | `/exact/stellar/upfront`              | settle, serve         | [`613c9210ec04304b…`](https://stellar.expert/explorer/testnet/tx/613c9210ec04304bc1cd4a9f0e6ab0e99eaa7319b0d8488d6cf0860908e3799b) | 5655468 |
| 11  | `typescript/http/fetch` | `typescript/http/hono`    | `/exact/stellar`                      | verify, serve, settle | [`c3e9d83c7f35e7e0…`](https://stellar.expert/explorer/testnet/tx/c3e9d83c7f35e7e0d1850be16909c30d15e351cfd56bbe54441ef987552a06e7) | 5655473 |
| 12  | `typescript/http/fetch` | `typescript/http/hono`    | `/exact/stellar/upfront`              | settle, serve         | [`470c2a2ef39111a2…`](https://stellar.expert/explorer/testnet/tx/470c2a2ef39111a25b28a9f245a25a66c371c67f675f5f31456e5a2eca53d378) | 5655484 |
| 13  | `typescript/http/axios` | `typescript/http/next`    | `/api/exact/stellar/withx402`         | verify, serve, settle | [`2acd428b39ddf552…`](https://stellar.expert/explorer/testnet/tx/2acd428b39ddf552c385cc5d8e346a2eeb87b5911bf29fded5d50e11d9693e97) | 5655497 |
| 14  | `typescript/http/axios` | `typescript/http/next`    | `/api/exact/stellar/upfront/withx402` | settle, serve         | [`b75f72f4453b0496…`](https://stellar.expert/explorer/testnet/tx/b75f72f4453b049612d38ac7d3b62a611d67aa215bffe8c98a097c9df7a7acc4) | 5655502 |
| 15  | `typescript/http/fetch` | `typescript/http/next`    | `/api/exact/stellar/withx402`         | verify, serve, settle | [`6e2a5c6e6221d8b1…`](https://stellar.expert/explorer/testnet/tx/6e2a5c6e6221d8b16dd44a94d5aa062295ecf15fade0867bd8ddc1652e647e61) | 5655507 |
| 16  | `typescript/http/fetch` | `typescript/http/next`    | `/api/exact/stellar/upfront/withx402` | settle, serve         | [`3cad2faab726db44…`](https://stellar.expert/explorer/testnet/tx/3cad2faab726db447eef2c47a031633205e2039d49f0153a466c75543b391d6f) | 5655510 |
| 17  | `typescript/mcp`        | `typescript/mcp`          | `exact_stellar`                       | verify, serve, settle | [`b441ca223f8391c1…`](https://stellar.expert/explorer/testnet/tx/b441ca223f8391c142ecc9c3b8c1d5d491cef6d4ceeba7f876370a454106ad52) | 5655522 |
| 18  | `typescript/mcp`        | `typescript/mcp`          | `exact_stellar_upfront`               | settle, serve         | [`f3c0cc08af5da350…`](https://stellar.expert/explorer/testnet/tx/f3c0cc08af5da3506301e3f7f147b68ea6557a50f5bf095dbe1f5ad28b6ace65) | 5655524 |

## What a pass does not show

- **Refusals.** Every scenario is one good payment. No scenario sends a bad signature, a short
  amount, an expired authorization or a replay, so a pass says nothing about how the facilitator
  refuses one. Our own tests ([`apps/facilitator/test/`](../apps/facilitator/test/)) cover the
  refusals the facilitator makes itself: an authorization that expires too soon, a repeat of a
  settled payment, a zero amount, a wrong network, a fee above the limit, a channel or source
  misused. A bad signature or a short amount is refused by upstream's `@x402/stellar`; our tests
  only check that its answer is passed on. End-to-end refusals against the deployed facilitator
  are task 0116.
- **Discovery.** The suite's Bazaar check (`--extensions=bazaar`) is not run. It calls
  `/discovery/search`, which comes after Tranche 1, and it looks for the suite's own
  `http://localhost:<port>` and `mcp://tool/<name>` entries, which the hosted catalog refuses
  (task 0054); the gate's proxy forwards only `/verify`, `/settle` and `/supported`.
- **Other languages and schemes.** At this commit the suite's Stellar routes are TypeScript only,
  and `exact` only (upstream `e2e/config/mechanisms_stellar.json`); `upto` is not in them.
- **Mainnet.** Testnet only. The facilitator serves `stellar:testnet` alone.
- **Load.** The scenarios run one after another, one payment each.

## How to check it

- **A transaction:** open any link above; stellar.expert shows the transfer, the amount and the fee
  account.
- **After the testnet reset of 2026-12-16** ([Stellar networks](https://developers.stellar.org/docs/networks)),
  the links stop resolving: the reset removes every transaction. Each signed envelope stays in
  `gate.json`, and a transaction's hash can be recomputed from it. An envelope shows what was
  signed, not that the network applied it, in which ledger, or that it succeeded: after the reset
  only a fresh run shows that, and the grant's final handover needs one.
- **The run again:** [`README.md`](README.md), "Run", with `GATE_FACILITATOR_URL` set to the
  facilitator above. It needs two funded testnet accounts and takes about 15 minutes, 11 of them
  the suite. Each run against our deployed facilitator overwrites `results/testnet-hosted/`. Git keeps the runs of record
  (2026-11-06 and this one); trial runs made while the gate was being fixed, on 2026-11-05 and 2026-11-06, were not committed, and their settlements are on chain under the same fee payer (task 0029).
