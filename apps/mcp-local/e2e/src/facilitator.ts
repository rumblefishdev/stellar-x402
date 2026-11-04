import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Account, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { buildCreateChannelsTx, readAccountEntry } from "@stellar-x402/signer-pool";
import { fakeOpenBao, signerEnv } from "../../../facilitator/test/fake-openbao.js";
import { friendbot } from "./horizon.js";
import { freePort } from "./seller.js";

const dist = (file: string) =>
  fileURLToPath(new URL(`../../../facilitator/dist/${file}`, import.meta.url));
const COMPOSE_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:15432/postgres";

export interface Facilitator {
  url: string;
  stop(): void;
}

/**
 * Starts our facilitator, built, so the example seller's payments don't depend on a public service:
 * a fresh friendbot account pays the fees, and two fresh channels carry the settlements. Its key
 * signs through the fake OpenBao, which holds nothing but this run's testnet account.
 */
export async function startFacilitator(): Promise<Facilitator> {
  const key = Keypair.random();
  await friendbot(key.publicKey());

  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const channels = [Keypair.random(), Keypair.random()];
  const entry = await readAccountEntry(server, key.publicKey());
  if (!entry) throw new Error("the facilitator's account does not exist");
  const setup = buildCreateChannelsTx({
    funder: new Account(key.publicKey(), entry.seqNum().toString()),
    signer: key.publicKey(),
    channels,
    networkPassphrase: Networks.TESTNET,
    fee: 1000,
  });
  setup.sign(key, ...channels);
  const created = await server.pollTransaction((await server.sendTransaction(setup)).hash, {
    attempts: 30,
  });
  if (created.status !== "SUCCESS") throw new Error(`channel setup ${created.status}`);

  const DATABASE_URL = process.env.DATABASE_URL ?? COMPOSE_DATABASE_URL;
  await promisify(execFile)(process.execPath, [dist("migrate.js")], {
    env: { PATH: process.env.PATH!, DATABASE_URL },
  });

  const openbao = await fakeOpenBao(key);
  const port = await freePort();
  const child = spawn(process.execPath, [dist("server.js")], {
    env: {
      ...signerEnv(key.publicKey(), openbao.socketPath),
      PATH: process.env.PATH!,
      DATABASE_URL,
      CLIENT_IP: "socket",
      CHANNELS: channels.map((channel) => channel.publicKey()).join(","),
      PORT: String(port),
    },
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"event":"listening"')) resolve();
    });
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => reject(new Error(`facilitator exited ${code}: ${output}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop() {
      child.kill();
      openbao.close();
    },
  };
}
