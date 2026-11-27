import { Keypair, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURATION_RECHECK_MS,
  STELLAR_TOML_BYTES,
  createCuration,
  provesPayTo,
} from "../src/catalog/curation.js";
import type { Logger } from "../src/logger.js";
import type { CurationKey, CurationRecord, CurationStore } from "../src/ports/curation-store.js";
import { startSeller, type Seller } from "./seller.js";

const PAY_TO = Keypair.random().publicKey();
const OTHER_PAY_TO = Keypair.random().publicKey();

describe("provesPayTo", () => {
  const toml = `ACCOUNTS = ["${OTHER_PAY_TO}", "${PAY_TO}"]\n`;

  it("is true when the file lists the payTo and its home_domain is the host", () => {
    expect(provesPayTo(toml, "pogoda.pl", "pogoda.pl", PAY_TO)).toBe(true);
  });

  it("compares the home_domain and the host without case", () => {
    expect(provesPayTo(toml, "Pogoda.PL", "pogoda.pl", PAY_TO)).toBe(true);
  });

  it("is false when the file does not list the payTo", () => {
    const other = `ACCOUNTS = ["${OTHER_PAY_TO}"]\n`;
    expect(provesPayTo(other, "pogoda.pl", "pogoda.pl", PAY_TO)).toBe(false);
  });

  it("is false when the account has no home_domain", () => {
    expect(provesPayTo(toml, undefined, "pogoda.pl", PAY_TO)).toBe(false);
  });

  it("is false when the home_domain is another domain", () => {
    expect(provesPayTo(toml, "pogoda.com", "pogoda.pl", PAY_TO)).toBe(false);
  });

  it("is false when the file has no ACCOUNTS", () => {
    const noAccounts = `VERSION = "2.0.0"\nNETWORK_PASSPHRASE = "Test SDF Network ; September 2015"\n`;
    expect(provesPayTo(noAccounts, "pogoda.pl", "pogoda.pl", PAY_TO)).toBe(false);
  });

  it("is false when ACCOUNTS is not a list of strings", () => {
    expect(provesPayTo(`ACCOUNTS = "${PAY_TO}"\n`, "pogoda.pl", "pogoda.pl", PAY_TO)).toBe(false);
    expect(provesPayTo(`ACCOUNTS = [1, 2]\n`, "pogoda.pl", "pogoda.pl", PAY_TO)).toBe(false);
  });

  it("throws on a file that is not TOML", () => {
    expect(() =>
      provesPayTo(`ACCOUNTS = ["${PAY_TO}"`, "pogoda.pl", "pogoda.pl", PAY_TO),
    ).toThrow();
  });
});

describe("the constants", () => {
  it("rechecks after 6 hours and reads at most SEP-1's 100 KiB", () => {
    expect(CURATION_RECHECK_MS).toBe(6 * 60 * 60 * 1000);
    expect(STELLAR_TOML_BYTES).toBe(100 * 1024);
  });
});

/** A curation store in memory: the check is tested apart from PostgreSQL. */
function memoryStore(): CurationStore & { records: Map<string, CurationRecord> } {
  const records = new Map<string, CurationRecord>();
  const id = (key: CurationKey) => `${key.network}|${key.host}|${key.payTo}`;
  return {
    records,
    get: async (key) => records.get(id(key)),
    put: async (record) => {
      records.set(id(record), record);
    },
  };
}

/** The ledger's account entry of `address`, with this home_domain. */
function accountWith(address: string, homeDomain: string) {
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
      balance: xdr.Int64.fromString("15000000"),
      seqNum: xdr.Int64.fromString("1"),
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain,
      thresholds: Buffer.from([1, 0, 0, 0]),
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    }),
  );
}

const START = Date.parse("2026-11-27T10:00:00Z");
const MINUTE = 60_000;
const TOML_PATH = "/.well-known/stellar.toml";

let seller: Seller;
beforeEach(async () => {
  seller = await startSeller((url) => ({ x402Version: 2, resource: { url }, accepts: [] }));
});
afterEach(() => {
  seller.server.close();
});

function setup(homeDomain = "127.0.0.1") {
  const store = memoryStore();
  const getLedgerEntries = vi.fn(async () => ({
    entries: [{ val: accountWith(PAY_TO, homeDomain) }],
    latestLedger: 100,
  }));
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const clock = { now: START };
  const curation = createCuration({
    store,
    rpc: { getLedgerEntries } as never,
    network: "stellar:testnet",
    logger,
    limits: { timeoutMs: 500, maxResponseBytes: 1024 * 1024, allowInsecureLocal: true },
    now: () => clock.now,
  });
  const key = { network: "stellar:testnet" as const, host: "127.0.0.1", payTo: PAY_TO };
  const refresh = () =>
    curation.refresh("stellar:testnet", `${seller.url}/weather/today?city=Warsaw`, PAY_TO);
  return { store, getLedgerEntries, logger, clock, key, refresh };
}

describe("createCuration: a finished check", () => {
  it("stores curated true when the file lists the payTo and its home_domain is the host", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { store, key, refresh } = setup();
    await refresh();
    expect(await store.get(key)).toEqual({ ...key, curated: true, checkedAt: START });
  });

  it("fetches the file from the resource URL's origin, whatever its path", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { refresh } = setup();
    await refresh();
    expect(seller.requests).toEqual([{ method: "GET", url: TOML_PATH, body: "" }]);
  });

  it("reads the home_domain from the payTo's account ledger key", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { getLedgerEntries, refresh } = setup();
    await refresh();
    const accountKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(PAY_TO).xdrPublicKey() }),
    );
    expect(getLedgerEntries).toHaveBeenCalledTimes(1);
    const [read] = getLedgerEntries.mock.calls[0] as unknown as [xdr.LedgerKey];
    expect(read.toXDR("base64")).toBe(accountKey.toXDR("base64"));
  });

  it("stores curated false when the file does not list the payTo", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${OTHER_PAY_TO}"]\n`;
    const { store, key, refresh } = setup();
    await refresh();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: START });
  });

  it("stores curated false when the account's home_domain is another domain", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { store, key, refresh } = setup("pogoda.pl");
    await refresh();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: START });
  });

  it("stores curated false when the file has no ACCOUNTS", async () => {
    seller.files[TOML_PATH] = `VERSION = "2.0.0"\n`;
    const { store, key, refresh } = setup();
    await refresh();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: START });
  });

  it("stores curated false when the account does not exist", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { store, key, getLedgerEntries, refresh } = setup();
    getLedgerEntries.mockResolvedValue({ entries: [], latestLedger: 100 });
    await refresh();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: START });
  });
});

describe("createCuration: when it checks", () => {
  it("checks nothing for a key of another network than the facilitator's", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { store, getLedgerEntries } = setup();
    const curation = createCuration({
      store,
      rpc: { getLedgerEntries } as never,
      network: "stellar:testnet",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      limits: { timeoutMs: 500, maxResponseBytes: 1024 * 1024, allowInsecureLocal: true },
      now: () => START,
    });
    await curation.refresh("stellar:pubnet", `${seller.url}/weather/today`, PAY_TO);
    expect(seller.requests).toEqual([]);
    expect(getLedgerEntries).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
  });

  it("does not check again within 6 hours of a finished check", async () => {
    const { store, key, clock, getLedgerEntries, refresh } = setup();
    await store.put({ ...key, curated: true, checkedAt: START });
    clock.now = START + CURATION_RECHECK_MS - 1;
    await refresh();
    expect(seller.requests).toEqual([]);
    expect(getLedgerEntries).not.toHaveBeenCalled();
    expect(await store.get(key)).toEqual({ ...key, curated: true, checkedAt: START });
  });

  it("checks again at exactly 6 hours", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${OTHER_PAY_TO}"]\n`;
    const { store, key, clock, refresh } = setup();
    await store.put({ ...key, curated: true, checkedAt: START });
    clock.now = START + CURATION_RECHECK_MS;
    await refresh();
    expect(seller.requests).toHaveLength(1);
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: clock.now });
  });

  it("checks a stored record that no check has finished at once", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { store, key, refresh } = setup();
    await store.put({ ...key, curated: false, checkedAt: null });
    await refresh();
    expect(seller.requests).toHaveLength(1);
    expect(await store.get(key)).toEqual({ ...key, curated: true, checkedAt: START });
  });
});

describe("createCuration: a failed check", () => {
  it("stores curated false with no checkedAt, and warns, when the file is missing (404)", async () => {
    seller.reply = async () => ({ status: 404 });
    const { store, key, logger, refresh } = setup();
    await expect(refresh()).resolves.toBeUndefined();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: null });
    expect(logger.warn).toHaveBeenCalledWith(
      "curation_check_failed",
      expect.objectContaining({
        network: "stellar:testnet",
        host: "127.0.0.1",
        payTo: PAY_TO,
        reason: expect.any(String),
      }),
    );
  });

  it("keeps the previous checkedAt and stores curated false when a recheck fails", async () => {
    seller.reply = async () => ({ status: 500 });
    const { store, key, clock, refresh } = setup();
    await store.put({ ...key, curated: true, checkedAt: START });
    clock.now = START + CURATION_RECHECK_MS + MINUTE;
    await refresh();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: START });
  });

  it("checks again at once on the refresh after a failure", async () => {
    seller.reply = async () => ({ status: 404 });
    const { store, key, clock, refresh } = setup();
    await refresh();
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    clock.now = START + MINUTE;
    await refresh();
    expect(seller.requests).toHaveLength(2);
    expect(await store.get(key)).toEqual({ ...key, curated: true, checkedAt: START + MINUTE });
  });

  it("fails on a file over 100 KiB", async () => {
    const padding = `# ${"x".repeat(STELLAR_TOML_BYTES)}\n`;
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n${padding}`;
    const { store, key, logger, refresh } = setup();
    await expect(refresh()).resolves.toBeUndefined();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: null });
    expect(logger.warn).toHaveBeenCalledWith("curation_check_failed", expect.anything());
  });

  it("fails on a file that is not TOML", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"`;
    const { store, key, logger, refresh } = setup();
    await expect(refresh()).resolves.toBeUndefined();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: null });
    expect(logger.warn).toHaveBeenCalledWith("curation_check_failed", expect.anything());
  });

  it("fails when the host does not answer in time", async () => {
    seller.reply = () => new Promise(() => {});
    const { store, key, logger, refresh } = setup();
    await expect(refresh()).resolves.toBeUndefined();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: null });
    expect(logger.warn).toHaveBeenCalledWith("curation_check_failed", expect.anything());
  });

  it("fails when the host refuses the connection", async () => {
    const { store, logger } = setup();
    const curation = createCuration({
      store,
      rpc: { getLedgerEntries: vi.fn() } as never,
      network: "stellar:testnet",
      logger,
      limits: { timeoutMs: 500, maxResponseBytes: 1024 * 1024, allowInsecureLocal: true },
      now: () => START,
    });
    // Port 9 (discard) has no listener here.
    await expect(
      curation.refresh("stellar:testnet", "http://127.0.0.1:9/weather/today", PAY_TO),
    ).resolves.toBeUndefined();
    expect(
      await store.get({ network: "stellar:testnet", host: "127.0.0.1", payTo: PAY_TO }),
    ).toEqual({
      network: "stellar:testnet",
      host: "127.0.0.1",
      payTo: PAY_TO,
      curated: false,
      checkedAt: null,
    });
    expect(logger.warn).toHaveBeenCalledWith("curation_check_failed", expect.anything());
  });

  it("fails when the RPC read fails", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { store, key, logger, getLedgerEntries, refresh } = setup();
    getLedgerEntries.mockRejectedValue(new Error("rpc down"));
    await expect(refresh()).resolves.toBeUndefined();
    expect(await store.get(key)).toEqual({ ...key, curated: false, checkedAt: null });
    expect(logger.warn).toHaveBeenCalledWith("curation_check_failed", expect.anything());
  });

  it("never throws, even when its store fails", async () => {
    seller.files[TOML_PATH] = `ACCOUNTS = ["${PAY_TO}"]\n`;
    const { getLedgerEntries, logger } = setup();
    const curation = createCuration({
      store: {
        get: () => Promise.reject(new Error("store down")),
        put: () => Promise.reject(new Error("store down")),
      },
      rpc: { getLedgerEntries } as never,
      network: "stellar:testnet",
      logger,
      limits: { timeoutMs: 500, maxResponseBytes: 1024 * 1024, allowInsecureLocal: true },
      now: () => START,
    });
    await expect(
      curation.refresh("stellar:testnet", `${seller.url}/weather/today`, PAY_TO),
    ).resolves.toBeUndefined();
  });
});
