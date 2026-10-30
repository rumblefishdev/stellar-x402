// Creates channels for a facilitator key that may live elsewhere (OpenBao, ADR 0013): an ordinary
// wallet funds each channel's reserve and is the transaction source, and each channel's own fresh
// key makes the facilitator key its only signer. The facilitator key signs nothing here. Prints
// the new channel addresses, comma-separated, for the facilitator's CHANNELS.
//
// Env: FUNDER_SECRET (the funding wallet's S… key), NETWORK (testnet | pubnet),
//      [RPC_URL] (default the public testnet RPC; required on pubnet)
// Usage: tsx scripts/create-channels.ts <facilitator G… address> <channels>
import { Keypair, Networks, StrKey, rpc } from "@stellar/stellar-sdk";
import { MAX_CHANNELS_PER_TX, buildCreateChannelsTx, checkChannel } from "../src/index.js";

const need = (k: string) =>
  process.env[k] ??
  (() => {
    throw new Error(`missing ${k}`);
  })();
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
const n = Number(count);
if (!Number.isInteger(n) || n < 1) throw new Error("the second argument must be a channel count");

const channels = Array.from({ length: n }, () => Keypair.random());
for (let i = 0; i < n; i += MAX_CHANNELS_PER_TX) {
  const batch = channels.slice(i, i + MAX_CHANNELS_PER_TX);
  const tx = buildCreateChannelsTx({
    funder: await server.getAccount(funder.publicKey()),
    signer,
    channels: batch,
    networkPassphrase: passphrase,
    fee: 1000,
  });
  tx.sign(funder, ...batch);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`channel setup ${sent.hash}: ${sent.status}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== "SUCCESS") throw new Error(`channel setup ${sent.hash} ended ${done.status}`);
  console.error(`channel setup ${sent.hash} landed`);
}
// The same check the facilitator runs before it starts (AD-12).
for (const channel of channels) {
  const problem = await checkChannel(server, channel.publicKey(), signer);
  if (problem) throw new Error(`channel ${channel.publicKey()}: ${problem}`);
}
console.log(channels.map((k) => k.publicKey()).join(","));
