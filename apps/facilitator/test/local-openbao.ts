// A fake OpenBao for `pnpm dev`, holding a key in this process. Prints the settings to export.
// Env: [LOCAL_KEY_SECRET] the key (S…); default a new random one.
import { Keypair } from "@stellar/stellar-sdk";
import { fakeOpenBao, signerEnv } from "./fake-openbao.js";

const secret = process.env.LOCAL_KEY_SECRET;
const key = secret ? Keypair.fromSecret(secret) : Keypair.random();
const openbao = await fakeOpenBao(key);
for (const [name, value] of Object.entries(signerEnv(key.publicKey(), openbao.socketPath)))
  console.log(`export ${name}=${value}`);
// The server doesn't hold the process open by itself.
setInterval(() => {}, 60_000);
