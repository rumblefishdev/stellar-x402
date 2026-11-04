// Creates channels for a facilitator key that may live elsewhere (OpenBao, ADR 0013): an ordinary
// wallet funds each channel's reserve and is the transaction source, and each channel's own fresh
// key makes the facilitator key its only signer. The facilitator key signs nothing here. Prints
// the new channel addresses, comma-separated, for the facilitator's CHANNELS.
//
// Env: FUNDER_SECRET (the funding wallet's S… key), NETWORK (testnet | pubnet),
//      [RPC_URL] (default the public testnet RPC; required on pubnet)
// Usage: tsx scripts/create-channels.ts <facilitator G… address> <channels>
import { Account, Keypair, Networks, StrKey, rpc } from "@stellar/stellar-sdk";
import {
  MAX_CHANNELS_PER_TX,
  buildCreateChannelsTx,
  checkChannel,
  readAccountEntry,
} from "../src/index.js";

/** A guard against a typo: each channel locks 1.5 XLM. An assumption; launch needs about 20. */
const MAX_CHANNELS = 100;
/** A batch is valid for 120 s, polled once a second; past that, NOT_FOUND means it can't land. */
const POLL_ATTEMPTS = 130;

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const network = need("NETWORK");
if (network !== "testnet" && network !== "pubnet")
  throw new Error(`NETWORK must be testnet or pubnet, not ${network}`);
const passphrase = network === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
const rpcUrl =
  process.env.RPC_URL ??
  (network === "testnet" ? "https://soroban-testnet.stellar.org" : need("RPC_URL"));
const server = new rpc.Server(rpcUrl);
const funder = Keypair.fromSecret(need("FUNDER_SECRET"));

const [signer, count] = process.argv.slice(2);
if (!signer || !StrKey.isValidEd25519PublicKey(signer))
  throw new Error("the first argument must be the facilitator's G… address");
if (!count || !/^[1-9]\d*$/.test(count) || Number(count) > MAX_CHANNELS)
  throw new Error(`the second argument must be a channel count from 1 to ${MAX_CHANNELS}`);
const n = Number(count);

const channels = Array.from({ length: n }, () => Keypair.random());
try {
  for (let i = 0; i < n; i += MAX_CHANNELS_PER_TX) {
    const batch = channels.slice(i, i + MAX_CHANNELS_PER_TX);
    const entry = await readAccountEntry(server, funder.publicKey());
    if (!entry) throw new Error("the funding account does not exist");
    const tx = buildCreateChannelsTx({
      funder: new Account(funder.publicKey(), entry.seqNum().toString()),
      signer,
      channels: batch,
      networkPassphrase: passphrase,
      fee: 1000,
    });
    tx.sign(funder, ...batch);
    const sent = await server.sendTransaction(tx);
    if (sent.status !== "PENDING") {
      const code = sent.errorResult?.result().switch().name;
      throw new Error(`channel setup ${sent.hash}: ${sent.status} ${code ?? ""}`);
    }
    const done = await server.pollTransaction(sent.hash, { attempts: POLL_ATTEMPTS });
    if (done.status !== "SUCCESS") {
      const code = done.status === "FAILED" ? done.resultXdr.result().switch().name : "";
      throw new Error(`channel setup ${sent.hash} ended ${done.status} ${code}`);
    }
    // Printed per batch: if a later one fails, these channels already exist and hold their reserve.
    const addresses = batch.map((k) => k.publicKey()).join(",");
    console.error(`channel setup ${sent.hash} landed: ${addresses}`);
  }
  // The same check the facilitator runs before it starts (AD-12).
  for (const channel of channels) {
    const problem = await checkChannel(server, channel.publicKey(), signer);
    if (problem) throw new Error(`channel ${channel.publicKey()}: ${problem}`);
  }
} catch (error) {
  // The message only, without the endpoint: a whole RPC error prints the URL, API key included
  // (ADR 0011).
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  const safe = message
    .replaceAll(rpcUrl, "<RPC_URL>")
    .replaceAll(new URL(rpcUrl).hostname, "<RPC>");
  console.error(`create-channels failed: ${safe}`);
  process.exit(1);
}
console.log(channels.map((k) => k.publicKey()).join(","));
