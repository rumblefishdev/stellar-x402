import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { buildCreateChannelsTx } from "@stellar-x402/signer-pool";
import { fakeOpenBao, signerEnv } from "../../../facilitator/test/fake-openbao.js";
import { friendbot } from "./horizon.js";

const SERVER = fileURLToPath(new URL("../../../facilitator/dist/server.js", import.meta.url));

/**
 * Starts our facilitator, built, so the example seller's payments don't depend on a public service:
 * a fresh friendbot account pays the fees, and one fresh channel carries the settlements. Its key
 * signs through the fake OpenBao, which holds nothing but this run's testnet account. Its log goes
 * to stderr, so a refused or failed settlement shows its cause.
 */
export async function startFacilitator(databaseUrl: string) {
  const key = Keypair.random();
  await friendbot(key.publicKey());

  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const channel = Keypair.random();
  const setup = buildCreateChannelsTx({
    funder: await server.getAccount(key.publicKey()),
    signer: key.publicKey(),
    channels: [channel],
    networkPassphrase: Networks.TESTNET,
  });
  setup.sign(key, channel);
  const sent = await server.sendTransaction(setup);
  if (sent.status !== "PENDING") throw new Error(`channel setup ${sent.status}`);
  const created = await server.pollTransaction(sent.hash);
  if (created.status !== "SUCCESS") throw new Error(`channel setup ${created.status}`);

  const openbao = await fakeOpenBao(key);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...signerEnv(key.publicKey(), openbao.socketPath),
      DATABASE_URL: databaseUrl,
      CLIENT_IP: "socket",
      CHANNELS: channel.publicKey(),
      PORT: "0",
    },
  });
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    const read = (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString();
      const listening = /"event":"listening","port":(\d+)/.exec(output);
      if (listening) resolve(`http://127.0.0.1:${listening[1]}`);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", (code) => reject(new Error(`facilitator exited ${code}: ${output}`)));
  });
  return {
    url,
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await once(child, "exit");
      }
      openbao.close();
    },
  };
}
