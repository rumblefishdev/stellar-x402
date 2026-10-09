// Idempotent testnet setup: accounts, tokens, contracts and channels. Every step checks the chain
// first, so a rerun only tops up what is missing, and a run after a testnet reset rebuilds it all
// (except testnet USDC, which only Circle's faucet hands out).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, Asset, Keypair, Operation, nativeToScVal } from "@stellar/stellar-sdk";
import {
  MAX_CHANNELS_PER_TX,
  buildCreateChannelsTx,
  checkChannel,
} from "@stellar-x402/signer-pool";
import { PASSPHRASE, fundIfMissing, sendAndWait, server, tokenBalance } from "./chain.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const SECRETS = process.env.E2E_SECRETS ?? join(here, "../secrets/accounts.json");

/** Circle's testnet USDC (https://developers.circle.com/stablecoins/usdc-contract-addresses). */
export const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
/** Least USDC (base units, 7 decimals) the client must hold for one run. */
export const USDC_NEEDED = 5_000_000n;
/** Balance kept on the client for the self-issued asset and the test token. */
const TOP_UP = 1_000_000_000n;

export type TokenKind = "usdc" | "sac" | "sep41";

export interface World {
  proxy: { contractId: string; wasmHash: string };
  testToken: { contractId: string; wasmHash: string };
  tokens: Record<TokenKind, string>;
  facilitator: Keypair;
  /** A second facilitator with its own channel, for the "different facilitator" scenario. */
  otherFacilitator: Keypair;
  client: Keypair;
  seller: Keypair;
  channels: string[];
  otherChannels: string[];
}

interface Secrets {
  facilitator: string;
  otherFacilitator: string;
  client: string;
  seller: string;
  issuer: string;
  channels: string[];
  otherChannels: string[];
}

function loadSecrets(): Secrets {
  if (existsSync(SECRETS)) return JSON.parse(readFileSync(SECRETS, "utf8")) as Secrets;
  const secret = () => Keypair.random().secret();
  const fresh: Secrets = {
    facilitator: secret(),
    otherFacilitator: secret(),
    client: secret(),
    seller: secret(),
    issuer: secret(),
    channels: [],
    otherChannels: [],
  };
  saveSecrets(fresh);
  return fresh;
}

function saveSecrets(secrets: Secrets): void {
  mkdirSync(dirname(SECRETS), { recursive: true });
  writeFileSync(SECRETS, `${JSON.stringify(secrets, null, 2)}\n`);
  chmodSync(SECRETS, 0o600);
}

/** Runs deploy/scripts/deploy-contract.sh and reads its `KEY=value` output. */
function deploy(name: string): { contractId: string; wasmHash: string } {
  const out = execFileSync(join(repo, "deploy/scripts/deploy-contract.sh"), [name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const value = (suffix: string) => {
    const line = out.split("\n").find((l) => l.includes(`_${suffix}=`));
    if (!line) throw new Error(`deploy-contract.sh ${name} printed no ${suffix}`);
    return line.split("=")[1]!.trim();
  };
  return { contractId: value("CONTRACT_ID"), wasmHash: value("WASM_HASH") };
}

/** Warns when the proxy deployed here isn't the one recorded in deploy/testnet.env.example. */
function warnIfNotRecorded(contractId: string): void {
  const env = readFileSync(join(repo, "deploy/testnet.env.example"), "utf8");
  const recorded = /^UPTO_PROXY_CONTRACT_ID=(\S+)/m.exec(env)?.[1];
  if (recorded && recorded !== contractId) {
    console.warn(
      `UptoProxy deployed at ${contractId}, not the recorded ${recorded}: contract IDs depend on ` +
        "the deployer key and the exact WASM, so this run tests your own deployment.",
    );
  }
}

async function hasTrustline(account: string, asset: Asset): Promise<boolean> {
  try {
    await server.getTrustline(account, asset);
    return true;
  } catch {
    return false;
  }
}

async function ensureTrustlines(account: Keypair, assets: Asset[]): Promise<void> {
  const missing: Asset[] = [];
  for (const asset of assets)
    if (!(await hasTrustline(account.publicKey(), asset))) missing.push(asset);
  if (missing.length > 0) {
    await sendAndWait(
      account,
      missing.map((asset) => Operation.changeTrust({ asset })),
    );
  }
}

async function ensureSac(asset: Asset, payer: Keypair): Promise<string> {
  const id = asset.contractId(PASSPHRASE);
  try {
    await server.getContractInstance(id);
  } catch {
    await sendAndWait(payer, [Operation.createStellarAssetContract({ asset })], [], {
      soroban: true,
    });
  }
  return id;
}

/** Channels for `facilitator`: reuses the recorded ones that still check out, creates the rest. */
async function ensureChannels(facilitator: Keypair, known: string[], count: number) {
  const good: string[] = [];
  for (const channel of known) {
    if (!(await checkChannel(server, channel, facilitator.publicKey()))) good.push(channel);
  }
  const fresh = Array.from({ length: Math.max(0, count - good.length) }, () => Keypair.random());
  for (let i = 0; i < fresh.length; i += MAX_CHANNELS_PER_TX) {
    const batch = fresh.slice(i, i + MAX_CHANNELS_PER_TX);
    const tx = buildCreateChannelsTx({
      facilitator: await server.getAccount(facilitator.publicKey()),
      channels: batch,
      networkPassphrase: PASSPHRASE,
      fee: 1000,
    });
    tx.sign(facilitator, ...batch);
    const sent = await server.sendTransaction(tx);
    if (sent.status !== "PENDING") throw new Error(`channel setup ${sent.hash}: ${sent.status}`);
    const done = await server.pollTransaction(sent.hash, { attempts: 30 });
    if (done.status !== "SUCCESS")
      throw new Error(`channel setup ${sent.hash} ended ${done.status}`);
  }
  return [...good, ...fresh.map((k) => k.publicKey())].slice(0, count);
}

/** `needUsdc: false` skips the USDC balance check, for runs without the USDC scenarios. */
export async function prepareWorld({ needUsdc = true } = {}): Promise<World> {
  const proxy = deploy("upto-proxy");
  warnIfNotRecorded(proxy.contractId);
  const testToken = deploy("test-token");

  const secrets = loadSecrets();
  const kp = (s: string) => Keypair.fromSecret(s);
  const [facilitator, otherFacilitator, client, seller, issuer] = [
    kp(secrets.facilitator),
    kp(secrets.otherFacilitator),
    kp(secrets.client),
    kp(secrets.seller),
    kp(secrets.issuer),
  ];
  for (const k of [facilitator, otherFacilitator, client, seller, issuer]) {
    await fundIfMissing(k.publicKey());
  }

  // Self-issued classic asset behind its SAC.
  const own = new Asset("UPTOE2E", issuer.publicKey());
  await ensureTrustlines(client, [USDC, own]);
  await ensureTrustlines(seller, [USDC, own]);
  const sac = await ensureSac(own, facilitator);
  const usdc = await ensureSac(USDC, facilitator);

  const source = facilitator.publicKey();
  if ((await tokenBalance(sac, client.publicKey(), source)) < TOP_UP / 2n) {
    await sendAndWait(issuer, [
      Operation.payment({ destination: client.publicKey(), asset: own, amount: "100" }),
    ]);
  }
  if ((await tokenBalance(testToken.contractId, client.publicKey(), source)) < TOP_UP / 2n) {
    await sendAndWait(
      facilitator,
      [
        Operation.invokeContractFunction({
          contract: testToken.contractId,
          function: "mint",
          args: [
            Address.fromString(client.publicKey()).toScVal(),
            nativeToScVal(TOP_UP, { type: "i128" }),
          ],
        }),
      ],
      [],
      { soroban: true },
    );
  }
  const usdcBalance = await tokenBalance(usdc, client.publicKey(), source);
  if (needUsdc && usdcBalance < USDC_NEEDED) {
    throw new Error(
      `The client holds ${usdcBalance} USDC base units; a run needs ${USDC_NEEDED}. ` +
        `Send testnet USDC to ${client.publicKey()} from https://faucet.circle.com ` +
        `(network: Stellar testnet), then rerun. Its USDC trustline is already open.`,
    );
  }

  // Saved after each call, so channels already created and funded are never lost.
  secrets.channels = await ensureChannels(facilitator, secrets.channels, 2);
  saveSecrets(secrets);
  secrets.otherChannels = await ensureChannels(otherFacilitator, secrets.otherChannels, 1);
  saveSecrets(secrets);

  return {
    proxy,
    testToken,
    tokens: { usdc, sac, sep41: testToken.contractId },
    facilitator,
    otherFacilitator,
    client,
    seller,
    channels: secrets.channels,
    otherChannels: secrets.otherChannels,
  };
}
