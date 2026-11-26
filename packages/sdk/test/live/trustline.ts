/**
 * `checkTrustline` against Stellar testnet's public RPC: the cases a unit test reads from made-up
 * ledger entries, read from the real ledger. Run by hand:
 *
 *   SELLER=G... pnpm exec tsx test/live/trustline.ts
 *
 * `SELLER` is an account holding a testnet USDC trustline, such as the e2e run's
 * `E2E_SELLER_PUBLIC`. The run funds one fresh account with friendbot; nothing else is written.
 */
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { checkTrustline, type TrustlineCheck } from "../../src/seller/index.js";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const XLM = Asset.native().contractId(Networks.TESTNET);

const seller = process.env.SELLER;
if (!seller) throw new Error("SELLER is required: a testnet account with a USDC trustline");

const funded = Keypair.random().publicKey();
const friendbot = await fetch(`https://friendbot.stellar.org/?addr=${funded}`);
if (!friendbot.ok) throw new Error(`friendbot answered ${friendbot.status}`);

const cases: [string, Parameters<typeof checkTrustline>[0], TrustlineCheck["status"]][] = [
  [
    "the seller's USDC",
    { account: seller, asset: USDC_TESTNET_ADDRESS, network: "stellar:testnet" },
    "ok",
  ],
  [
    "USDC's issuer",
    { account: USDC_ISSUER, asset: USDC_TESTNET_ADDRESS, network: "stellar:testnet" },
    "ok",
  ],
  [
    "an account without the trustline",
    { account: funded, asset: USDC_TESTNET_ADDRESS, network: "stellar:testnet" },
    "missing",
  ],
  [
    "an account that doesn't exist",
    {
      account: Keypair.random().publicKey(),
      asset: USDC_TESTNET_ADDRESS,
      network: "stellar:testnet",
    },
    "missing",
  ],
  [
    "XLM for an existing account",
    { account: funded, asset: XLM, network: "stellar:testnet" },
    "ok",
  ],
  [
    "a contract account",
    { account: USDC_TESTNET_ADDRESS, asset: USDC_TESTNET_ADDRESS, network: "stellar:testnet" },
    "unknown",
  ],
];

let failed = 0;
for (const [name, options, expected] of cases) {
  const answer = await checkTrustline(options);
  const pass = answer.status === expected;
  if (!pass) failed += 1;
  console.log(`${pass ? "pass" : "FAIL"}  ${name}: ${JSON.stringify(answer)}`);
}
console.log(`${cases.length - failed} of ${cases.length} as expected`);
process.exitCode = failed === 0 ? 0 : 1;
