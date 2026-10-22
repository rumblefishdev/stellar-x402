/* global console, fetch, Buffer, URL */
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../../../apps/facilitator/package.json", import.meta.url));
const { Keypair, StrKey, TransactionBuilder, Networks, Operation, Horizon } = require("@stellar/stellar-sdk");
const addr = "http://127.0.0.1:18300";
const api = async (m, p, b) => (await fetch(`${addr}/v1/${p}`, { method: m, headers: { "X-Vault-Token": "root", "content-type": "application/json" }, body: b && JSON.stringify(b) })).json();
await api("POST", "transit/keys/stellar-onchain2", { type: "ed25519" });
const pub = Buffer.from((await api("GET", "transit/keys/stellar-onchain2")).data.keys["1"].public_key, "base64");
const source = StrKey.encodeEd25519PublicKey(pub);
await fetch(`https://friendbot.stellar.org?addr=${source}`);
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const account = await horizon.loadAccount(source);
const tx = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.createAccount({ destination: Keypair.random().publicKey(), startingBalance: "1" }))
  .setTimeout(60).build();
const sig = (await api("POST", "transit/sign/stellar-onchain2", { input: tx.hash().toString("base64") })).data.signature.split(":")[2];
tx.addSignature(source, sig);
const res = await horizon.submitTransaction(tx).catch((e) => ({ error: e?.response?.data?.extras?.result_codes ?? String(e) }));
console.log(JSON.stringify({ source, hash: res.hash, successful: res.successful, ledger: res.ledger, error: res.error }, null, 2));
