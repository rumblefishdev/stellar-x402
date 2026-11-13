/**
 * Testnet smoke run of the API key rule (0105), on a facilitator built by `main()`, with real
 * `exact` payments signed by upstream's client and a key issued by the operator's script.
 *
 * 1. Testnet takes no key: a payment verifies and settles on chain with no `Authorization`
 *    header, with a made-up key and with a registered one, and each request counts under the
 *    client's IP.
 * 2. A request that names `stellar:pubnet` needs a key: 401 `missing_api_key` without one, 401
 *    `invalid_api_key` with a made-up one, and neither counts anywhere.
 * 3. With a registered key it reaches the real verifier, which answers `invalid_network` (this
 *    process serves testnet), and counts under the key's owner.
 * 4. Once the script revokes the key, the next request with it is a 401.
 *
 * Env (each optional but DATABASE_URL; a missing key is a fresh friendbot-funded one, printed by
 * address only):
 *   FACILITATOR_SECRET  pays the fees and creates 2 channels (1.5 XLM each)
 *   CLIENT_SECRET       pays AMOUNT of the testnet XLM SAC per payment, three times
 *   PAY_TO              receives (a funded account)
 *   AMOUNT              base units (default 1000 = 0.0001 XLM)
 *   DATABASE_URL        required: the facilitator's PostgreSQL, migrated (`pnpm migrate`); the
 *                       local one from `compose.yaml` is postgres://postgres:postgres@127.0.0.1:15432/postgres
 *
 *   cd apps/facilitator && npx tsx test/live/api-key-smoke.ts
 *
 * The result, with every hash, goes to `test/live/results/api-key-smoke-testnet.json` and to
 * stdout; the facilitator's log lines go to stderr. Neither carries a key. Testnet only.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Account, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { buildCreateChannelsTx, readAccountEntry } from "@stellar-x402/signer-pool";
import type { PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { Agent, fetch } from "undici";
import { newApiKey } from "../../src/http/api-key.js";
import { keysMain, main } from "../../src/main.js";
import { fakeOpenBao, signerEnv } from "../fake-openbao.js";

const XLM_SAC_TESTNET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RPC_URL = "https://soroban-testnet.stellar.org";
const network = "stellar:testnet";
const server = new rpc.Server(RPC_URL);
const env = { DATABASE_URL: process.env.DATABASE_URL };

/** The script's own HTTP client: `main()` sets a global one that ends a slow friendbot call. */
const http = new Agent({ headersTimeout: 120_000 });

async function funded(secret: string | undefined): Promise<Keypair> {
  if (secret) return Keypair.fromSecret(secret);
  const keypair = Keypair.random();
  const response = await fetch(`https://friendbot.stellar.org/?addr=${keypair.publicKey()}`, {
    dispatcher: http,
  });
  if (!response.ok) throw new Error(`friendbot: ${response.status}`);
  return keypair;
}

/** Runs the operator's script and resolves what it printed. */
async function keys(...argv: string[]): Promise<string[]> {
  const lines: string[] = [];
  await keysMain(argv, env, (line) => lines.push(line));
  return lines;
}

const facilitator = await funded(process.env.FACILITATOR_SECRET);
const client = await funded(process.env.CLIENT_SECRET);
const payTo = process.env.PAY_TO ?? (await funded(undefined)).publicKey();

// Two delegated channels: master key off, the facilitator their only signer.
const channelKeys = [Keypair.random(), Keypair.random()];
const facilitatorEntry = await readAccountEntry(server, facilitator.publicKey());
if (!facilitatorEntry) throw new Error("the facilitator account does not exist");
const setup = buildCreateChannelsTx({
  funder: new Account(facilitator.publicKey(), facilitatorEntry.seqNum().toString()),
  signer: facilitator.publicKey(),
  channels: channelKeys,
  networkPassphrase: Networks.TESTNET,
  fee: 1000,
});
setup.sign(facilitator, ...channelKeys);
const created = await server.pollTransaction((await server.sendTransaction(setup)).hash, {
  attempts: 30,
});
if (created.status !== "SUCCESS") throw new Error(`channel setup ${created.status}`);

// The fake OpenBao holds this run's key: a testnet account funded for the run.
const openbao = await fakeOpenBao(facilitator);
const facilitatorServer = await main(
  {
    ...signerEnv(facilitator.publicKey(), openbao.socketPath),
    ...env,
    CLIENT_IP: "socket",
    CHANNELS: channelKeys.map((keypair) => keypair.publicKey()).join(","),
    PORT: "0",
    LOG_LEVEL: "warn",
  },
  { write: (line) => void process.stderr.write(line) },
);

const requirements: PaymentRequirements = {
  scheme: "exact",
  network,
  asset: XLM_SAC_TESTNET,
  amount: process.env.AMOUNT ?? "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
const payer = new ExactStellarScheme(createEd25519Signer(client.secret(), network));

/** A POST of a payment request; resolves the status and the body. */
async function post<T>(
  route: "verify" | "settle",
  paymentPayload: unknown,
  paymentRequirements: PaymentRequirements,
  authorization?: string,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${facilitatorServer.port}/${route}`, {
    dispatcher: http,
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization && { authorization }) },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** A new testnet payment, verified and settled with `authorization`, then read on chain. */
async function payWith(authorization?: string) {
  const payload = {
    ...(await payer.createPaymentPayload(2, requirements)),
    accepted: requirements,
  };
  const verified = await post<VerifyResponse>("verify", payload, requirements, authorization);
  const settled = await post<SettleResponse>("settle", payload, requirements, authorization);
  const onChain = settled.body.success
    ? (await server.pollTransaction(settled.body.transaction, { attempts: 30 })).status
    : undefined;
  return {
    verify: verified.status,
    isValid: verified.body.isValid,
    settle: settled.status,
    success: settled.body.success,
    errorReason: settled.body.errorReason,
    transaction: settled.body.transaction,
    onChain,
  };
}
const paid = (payment: Awaited<ReturnType<typeof payWith>>) =>
  payment.verify === 200 &&
  payment.isValid &&
  payment.settle === 200 &&
  payment.success &&
  payment.onChain === "SUCCESS";

/** The rate-limit counters this run made, with their counts. */
async function counters(): Promise<Record<string, number>> {
  const { rows } = await facilitatorServer.pools.main.query<{ key: string; count: number }>(
    "SELECT key, count FROM rate_limits WHERE key ~ '^(verify|settle):' ORDER BY key",
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

// An owner of this run's own, so a database that already holds keys doesn't get in the way.
const name = `smoke-${Date.now().toString(36)}`;
const owner = `operator:${name}`;
try {
  const before = await counters();
  const issued = await keys("issue", name);
  const key = issued.find((line) => line.startsWith("key: "))?.slice("key: ".length);
  if (!key) throw new Error("the script printed no key");
  const bearer = `Bearer ${key}`;

  // 1. Testnet: no header, a made-up key, the registered key.
  const keyless = await payWith();
  const madeUp = await payWith(`Bearer ${newApiKey()}`);
  const registered = await payWith(bearer);
  const afterTestnet = await counters();

  // 2 and 3. The same kind of request, naming pubnet.
  const pubnet: PaymentRequirements = { ...requirements, network: "stellar:pubnet" };
  const pubnetPayload = {
    ...(await payer.createPaymentPayload(2, requirements)),
    accepted: pubnet,
  };
  const refusals = {
    verifyNoKey: await post("verify", pubnetPayload, pubnet),
    settleNoKey: await post("settle", pubnetPayload, pubnet),
    verifyMadeUpKey: await post("verify", pubnetPayload, pubnet, `Bearer ${newApiKey()}`),
    settleMadeUpKey: await post("settle", pubnetPayload, pubnet, `Bearer ${newApiKey()}`),
  };
  const afterRefusals = await counters();
  const withKey = await post<VerifyResponse>("verify", pubnetPayload, pubnet, bearer);
  const afterKey = await counters();

  // 4. Revoked by the script: the next request with the key.
  const revoked = await keys("revoke", name);
  const afterRevoke = await post("verify", pubnetPayload, pubnet, bearer);
  const afterAll = await counters();

  const made = (now: Record<string, number>, then: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(now)
        .map(([counter, count]) => [counter, count - (then[counter] ?? 0)] as const)
        .filter(([, count]) => count > 0),
    );
  const testnetCounters = made(afterTestnet, before);
  const keyCounters = made(afterAll, afterTestnet);
  const refused = (answer: { status: number; body: unknown }, error: string) =>
    answer.status === 401 && JSON.stringify(answer.body) === JSON.stringify({ error });

  const checks = {
    testnetSettlesWithoutAKey: paid(keyless),
    testnetIgnoresAMadeUpKey: paid(madeUp),
    testnetIgnoresARegisteredKey: paid(registered),
    // Three `/verify` and three `/settle`, every one under an IP and none under a key.
    testnetCountsByIp:
      Object.keys(testnetCounters).length === 2 &&
      Object.entries(testnetCounters).every(
        ([counter, count]) => /^(verify|settle):ip:/.test(counter) && count === 3,
      ),
    pubnetWithoutAKeyIs401:
      refused(refusals.verifyNoKey, "missing_api_key") &&
      refused(refusals.settleNoKey, "missing_api_key"),
    pubnetWithAMadeUpKeyIs401:
      refused(refusals.verifyMadeUpKey, "invalid_api_key") &&
      refused(refusals.settleMadeUpKey, "invalid_api_key"),
    refusalsCountNowhere: JSON.stringify(afterRefusals) === JSON.stringify(afterTestnet),
    pubnetWithTheKeyReachesTheVerifier:
      withKey.status === 200 &&
      !withKey.body.isValid &&
      withKey.body.invalidReason === "invalid_network",
    pubnetCountsByOwner:
      JSON.stringify(made(afterKey, afterTestnet)) ===
      JSON.stringify({ [`verify:key:${owner}`]: 1 }),
    revokedKeyIs401: refused(afterRevoke, "invalid_api_key"),
    // The request after the revocation counted nowhere either.
    onlyTheOwnersRequestCounted:
      JSON.stringify(keyCounters) === JSON.stringify({ [`verify:key:${owner}`]: 1 }),
  };

  const result = {
    ranAt: new Date().toISOString(),
    network,
    script: "apps/facilitator/test/live/api-key-smoke.ts",
    commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
    facilitator: facilitator.publicKey(),
    payer: client.publicKey(),
    payTo,
    owner,
    // The script's own lines, with the key cut out.
    issued: issued.map((line) => (line.startsWith("key: ") ? "key: (not recorded)" : line)),
    testnet: { keyless, madeUp, registered, counters: testnetCounters },
    pubnet: { ...refusals, withKey, revoked, afterRevoke, counters: keyCounters },
    checks,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (text.includes(key)) throw new Error("the result would carry the key");
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(new URL("./results/api-key-smoke-testnet.json", import.meta.url), text);
  process.stdout.write(text);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  // Leaves no active key behind when a step above threw.
  await keys("revoke", name).catch(() => {});
  await facilitatorServer.close();
  openbao.close();
}
