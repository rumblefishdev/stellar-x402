/* global console, fetch, performance, Buffer, process, URL */
// Spike for task 0047: can Vault / OpenBao Transit sign Stellar transactions?
// Usage: node transit-spike.mjs <name> <addr>   (dev server, root token "root")
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(new URL("../../../../../apps/facilitator/package.json", import.meta.url));
const { Keypair, StrKey, TransactionBuilder, Networks, Operation, Asset, Account } =
  require("@stellar/stellar-sdk");

const [name, addr] = process.argv.slice(2);
const api = async (method, path, body) => {
  const res = await fetch(`${addr}/v1/${path}`, {
    method,
    headers: { "X-Vault-Token": "root", "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
};

const out = { backend: name, version: (await api("GET", "sys/health")).version };
await api("POST", "sys/mounts/transit", { type: "transit" }).catch(() => {});

/** The G-address of a Transit ed25519 key, from its exported raw 32-byte public key. */
async function address(key) {
  const read = await api("GET", `transit/keys/${key}`);
  const raw = Buffer.from(read.data.keys["1"].public_key, "base64");
  return { address: StrKey.encodeEd25519PublicKey(raw), rawLength: raw.length };
}

/** A testnet payment from `source`, signed through Transit; does Stellar accept the signature? */
async function signAndCheck(key, source) {
  const tx = new TransactionBuilder(new Account(source, "41"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }),
    )
    .setTimeout(60)
    .build();
  const hash = tx.hash(); // 32 bytes: what Stellar signs, with pure Ed25519
  const signed = await api("POST", `transit/sign/${key}`, { input: hash.toString("base64") });
  const [prefix, version, b64] = signed.data.signature.split(":");
  const signature = Buffer.from(b64, "base64");
  const verifies = Keypair.fromPublicKey(source).verify(hash, signature);
  // addSignature verifies against the hash itself and throws on a bad one.
  tx.addSignature(source, signature.toString("base64"));
  const roundTrip = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET);
  return {
    format: `${prefix}:${version}:<base64>`,
    signatureLength: signature.length,
    verifiesWithStellarSdk: verifies,
    acceptedByAddSignature: roundTrip.signatures.length === 1,
  };
}

// 1. A key created inside Transit, never exportable.
await api("POST", "transit/keys/stellar-generated", { type: "ed25519", exportable: false });
const generated = await address("stellar-generated");
out.generatedKey = { ...generated, ...(await signAndCheck("stellar-generated", generated.address)) };

// 2. An existing Stellar secret key (S...), imported with Transit's BYOK wrapping.
const existing = Keypair.random();
const pkcs8 = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), // PKCS#8 header for Ed25519
  existing.rawSecretKey(),
]);
const wrapping = (await api("GET", "transit/wrapping_key")).data.public_key;
const ephemeral = crypto.randomBytes(32);
const wrappedKey = crypto.publicEncrypt(
  { key: wrapping, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
  ephemeral,
);
const kwp = crypto.createCipheriv("id-aes256-wrap-pad", ephemeral, Buffer.from("A65959A6", "hex"));
const wrappedTarget = Buffer.concat([kwp.update(pkcs8), kwp.final()]);
await api("POST", "transit/keys/stellar-imported/import", {
  type: "ed25519",
  ciphertext: Buffer.concat([wrappedKey, wrappedTarget]).toString("base64"),
  hash_function: "SHA256",
});
const imported = await address("stellar-imported");
out.importedKey = {
  sameAddressAsSecret: imported.address === existing.publicKey(),
  ...(await signAndCheck("stellar-imported", existing.publicKey())),
};

// 3. Exportable? Asking for the private key of a non-exportable key must fail.
out.exportOfNonExportableKey = await api("GET", "transit/export/signing-key/stellar-generated")
  .then(() => "returned the key (bad)")
  .catch((e) => `refused (${String(e.message).match(/: (\d{3})/)?.[1]})`);

// 4. Latency of one sign call (sequential, local dev server).
const input = crypto.randomBytes(32).toString("base64");
const times = [];
for (let i = 0; i < 200; i++) {
  const t = performance.now();
  await api("POST", "transit/sign/stellar-generated", { input });
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
out.signLatencyMs = {
  p50: +times[100].toFixed(2),
  p99: +times[197].toFixed(2),
};
console.log(JSON.stringify(out, null, 2));
