import { Keypair, Networks } from "@stellar/stellar-sdk";
import { STELLAR_NETWORKS } from "@stellar-x402/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
import { testDatabase } from "./database.js";
import { signerEnv } from "./fake-openbao.js";
import { hardened, rpcStub } from "./rpc-stub.js";

/**
 * `main()` on a network that requires an API key (0157, from Oskar's review of #236). `main()`
 * parses its own config, and `parseConfig` refuses pubnet until 0048 lands, so here the config is
 * parsed as testnet's and given the network after, as `settle-pool.test.ts` does for `compose()`.
 * The first test fails once the refusal is gone: drop the mock then.
 */
type ConfigModule = typeof import("../src/config.js");
vi.mock("../src/config.js", async (importActual) => {
  const actual = await importActual<ConfigModule>();
  const parseConfig: ConfigModule["parseConfig"] = (env) => {
    if (env.NETWORK !== STELLAR_NETWORKS.pubnet) return actual.parseConfig(env);
    const { NETWORK: network, ...rest } = env;
    return { ...actual.parseConfig(rest), network };
  };
  return { ...actual, parseConfig };
});

const DAY = 86_400_000;
const db = testDatabase();
const facilitator = Keypair.random().publicKey();
const env = {
  DATABASE_URL: db.urlFor(db.schema),
  ...signerEnv(facilitator),
  CLIENT_IP: "socket",
  CHANNELS: Keypair.random().publicKey(),
  NETWORK: STELLAR_NETWORKS.pubnet,
  PORT: "0",
  LOG_LEVEL: "error",
};

// `main()` checks the RPC's network and every channel at startup.
let rpc: Awaited<ReturnType<typeof rpcStub>>;
beforeAll(async () => {
  rpc = await rpcStub(
    {
      [env.CHANNELS]: hardened(facilitator),
      // The fee account, holding the float (ADR 0013): above the balance floor.
      [facilitator]: { signers: [], masterWeight: 1, balance: 1_000_000_000n },
    },
    Networks.PUBLIC,
  );
});
afterAll(() => rpc.close());

describe("main() on a network that requires an API key (0107)", () => {
  it("is reached past parseConfig's refusal of pubnet, which still stands (0048)", async () => {
    const actual = await vi.importActual<ConfigModule>("../src/config.js");
    expect(() => actual.parseConfig({ ...env, RPC_URLS: rpc.url })).toThrow(/0048/);
  });

  it("keeps a month of an account's reservations: the pruner gets the keyed window", async () => {
    const app = await main({ ...env, RPC_URLS: rpc.url }, { write: () => {} });
    try {
      const scope = "account:discord:412345678901234567";
      const reserve = (id: string, at: number) =>
        app.stores.spend.reserve({
          id,
          amount: 1n,
          limits: [{ scope, maxStroops: 10n, windowMs: 70 * DAY }],
          now: at,
        });
      const now = Date.now();
      // An account's payments count from its month's 1st, up to 31 days back, and the pruner
      // keeps twice its window: 62 days (0107 decision 24). Testnet's 7 days would delete both,
      // and with them the month's count, so every account would get its quota back each week.
      await reserve("past the horizon", now - 63 * DAY);
      await reserve("the month's first day", now - 31 * DAY);
      await app.pruner.runOnce();
      expect(await app.stores.spend.used(scope, 70 * DAY, Date.now())).toBe(1n);
    } finally {
      await app.close();
    }
  });
});
