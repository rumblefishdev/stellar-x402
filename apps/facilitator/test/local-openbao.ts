// A fake OpenBao for `pnpm dev`, holding a key in this process. Prints the settings to export.
// Env: LOCAL_KEY_SECRET, the key (S…): the same one on each run, since channels name it as signer.
import { Keypair } from "@stellar/stellar-sdk";
import { fakeOpenBao, signerEnv } from "./fake-openbao.js";

const secret = process.env.LOCAL_KEY_SECRET;
if (!secret) throw new Error("missing LOCAL_KEY_SECRET");
const key = Keypair.fromSecret(secret);
const openbao = await fakeOpenBao(key);
for (const [name, value] of Object.entries(signerEnv(key.publicKey(), openbao.socketPath)))
  console.log(`export ${name}=${value}`);
