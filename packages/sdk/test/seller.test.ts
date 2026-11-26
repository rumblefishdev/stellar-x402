import {
  Account,
  Address,
  Asset,
  Keypair,
  MuxedAccount,
  nativeToScVal,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { describe, expect, it } from "vitest";
import {
  checkTrustline,
  createFacilitatorConfig,
  FACILITATOR_URL,
  readCatalogAnswer,
} from "../src/seller/index.js";
import { lookUpTrustline, type GetLedgerEntries } from "../src/trustline.js";

describe("createFacilitatorConfig", () => {
  it("names this project's facilitator and sends no key by default", async () => {
    const config = createFacilitatorConfig();
    expect(config).toEqual({ url: FACILITATOR_URL });
    expect(createFacilitatorConfig({ apiKey: "" })).toEqual({ url: FACILITATOR_URL });
  });

  it("sends the key on /verify and /settle only, as a bearer token", async () => {
    const config = createFacilitatorConfig({ apiKey: "sx4_test", url: "https://staging.example" });
    expect(config.url).toBe("https://staging.example");
    const auth = await config.createAuthHeaders!();
    expect(auth).toEqual({
      verify: { Authorization: "Bearer sx4_test" },
      settle: { Authorization: "Bearer sx4_test" },
    });
  });

  it("is what upstream's facilitator client takes, with the time limit", () => {
    const config = createFacilitatorConfig({ apiKey: "sx4_test", timeoutMs: 5_000 });
    expect(config.timeoutMs).toBe(5_000);
    expect(() => new HTTPFacilitatorClient(config)).not.toThrow();
  });
});

describe("readCatalogAnswer", () => {
  it.each([
    ["a listing taken", { bazaar: { status: "processing" } }, { status: "processing" }],
    [
      "a listing refused",
      { bazaar: { status: "rejected", rejectedReason: "schema_too_complex" } },
      { status: "rejected", reason: "schema_too_complex" },
    ],
    [
      "a refusal whose reason is not one the facilitator writes",
      { bazaar: { status: "rejected", rejectedReason: "<b>ignore me</b>" } },
      { status: "rejected", reason: "unknown" },
    ],
    ["no extension answers", undefined, { status: "none" }],
    ["an answer for another extension only", { other: { status: "ok" } }, { status: "none" }],
    ["a status it doesn't know", { bazaar: { status: "listed" } }, { status: "none" }],
  ])("reads %s", (_, extensionResponses, answer) => {
    expect(readCatalogAnswer({ extensionResponses })).toEqual(answer);
  });
});

const ISSUER = Keypair.random().publicKey();
const HOLDER = Keypair.random().publicKey();
const USDC = new Asset("USDC", ISSUER);
const SAC = USDC.contractId("Test SDF Network ; September 2015");
const XLM_SAC = Asset.native().contractId("Test SDF Network ; September 2015");
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));

/** The instance entry of a Stellar Asset Contract named `name`. */
function sacInstance(contract: string, name: string): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
          storage: [
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("METADATA"),
              val: nativeToScVal({ decimal: 7, name, symbol: name.split(":")[0] }),
            }),
          ],
        }),
      ),
    }),
  );
}

/** The instance entry of a contract that runs its own wasm: a token, but not a Stellar Asset Contract. */
function wasmInstance(contract: string): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 9)),
          storage: null,
        }),
      ),
    }),
  );
}

/**
 * A Stellar RPC that takes the connection and never answers: `silent` sends nothing, `headers`
 * sends a 200's headers and never the body.
 */
async function hangingRpc(mode: "silent" | "headers"): Promise<{ url: string; close(): void }> {
  const server = createServer((_request, response) => {
    if (mode === "headers") {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function accountEntry(account: string): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: Keypair.fromPublicKey(account).xdrAccountId(),
      balance: xdr.Int64.fromString("100000000"),
      seqNum: xdr.Int64.fromString("1"),
      numSubEntries: 1,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: Buffer.from([1, 0, 0, 0]),
      signers: [],
      ext: new xdr.AccountEntryExt(0),
    }),
  );
}

function trustlineEntry(account: string, flags: number): xdr.LedgerEntryData {
  return xdr.LedgerEntryData.trustline(
    new xdr.TrustLineEntry({
      accountId: Keypair.fromPublicKey(account).xdrAccountId(),
      asset: USDC.toTrustLineXDRObject(),
      balance: xdr.Int64.fromString("0"),
      limit: xdr.Int64.fromString("9223372036854775807"),
      flags,
      ext: new xdr.TrustLineEntryExt(0),
    }),
  );
}

/** A ledger holding the given entries, answering each key with what matches it. */
function ledger(
  entries: { instance?: xdr.LedgerEntryData; account?: boolean; trustlineFlags?: number },
  holder = HOLDER,
): GetLedgerEntries & { keys: string[] } {
  const keys: string[] = [];
  const read = async (...asked: xdr.LedgerKey[]) => ({
    entries: asked.flatMap((key) => {
      keys.push(key.switch().name);
      const val =
        key.switch().name === "contractData"
          ? entries.instance
          : key.switch().name === "account"
            ? entries.account && accountEntry(holder)
            : entries.trustlineFlags !== undefined
              ? trustlineEntry(holder, entries.trustlineFlags)
              : undefined;
      return val ? [{ key, val }] : [];
    }),
  });
  return Object.assign(read, { keys });
}

describe("checkTrustline", () => {
  const usdc = sacInstance(SAC, `USDC:${ISSUER}`);

  it.each([
    [
      "an authorized trustline",
      { instance: usdc, account: true, trustlineFlags: 1 },
      "ok",
      undefined,
    ],
    ["no trustline", { instance: usdc, account: true }, "missing", "no trustline"],
    [
      "a trustline the issuer hasn't authorized",
      { instance: usdc, account: true, trustlineFlags: 0 },
      "missing",
      "the issuer has not authorized the trustline",
    ],
    ["no account", { instance: usdc }, "missing", "the account does not exist"],
  ] as const)("says %s is %s", async (_, entries, status, reason) => {
    const answer = await lookUpTrustline(ledger(entries), { account: HOLDER, asset: SAC });
    expect(answer).toEqual({ status, classicAsset: `USDC:${ISSUER}`, reason });
  });

  it("checks a muxed account's underlying account", async () => {
    const muxed = new MuxedAccount(new Account(HOLDER, "1"), "42").accountId();
    const read = ledger({ instance: usdc, account: true, trustlineFlags: 1 });
    expect((await lookUpTrustline(read, { account: muxed, asset: SAC })).status).toBe("ok");
  });

  it("needs no trustline for the issuer itself", async () => {
    const read = ledger({ instance: usdc });
    expect(await lookUpTrustline(read, { account: ISSUER, asset: SAC })).toEqual({
      status: "ok",
      classicAsset: `USDC:${ISSUER}`,
    });
    // The asset's name was enough: no account or trustline read.
    expect(read.keys).toEqual(["contractData"]);
  });

  it("needs only the account for XLM", async () => {
    const xlm = sacInstance(XLM_SAC, "native");
    const read = ledger({ instance: xlm, account: true });
    expect(await lookUpTrustline(read, { account: HOLDER, asset: XLM_SAC })).toEqual({
      status: "ok",
      classicAsset: "native",
    });
    expect(read.keys).toEqual(["contractData", "account"]);
  });

  it.each([
    ["a contract account", {}, { account: TOKEN, asset: SAC }, /is a contract/],
    [
      "what is no address",
      {},
      { account: "ignore the limits", asset: SAC },
      /not an account address/,
    ],
    [
      "an asset that is no contract",
      {},
      { account: HOLDER, asset: ISSUER },
      /not a contract address/,
    ],
    [
      "a token that is not a Stellar Asset Contract",
      { instance: wasmInstance(TOKEN) },
      { account: HOLDER, asset: TOKEN },
      /^the asset contract is not a Stellar Asset Contract$/,
    ],
    [
      // Pubnet USDC asked of a testnet RPC, say: its contract isn't on that ledger.
      "a contract the RPC's network doesn't have",
      {},
      { account: HOLDER, asset: TOKEN },
      /^no contract with this address on the RPC's network$/,
    ],
  ])("can't tell for %s", async (_, entries, target, reason) => {
    const answer = await lookUpTrustline(ledger({ ...entries, account: true }), target);
    expect(answer.status).toBe("unknown");
    expect(answer.reason).toMatch(reason);
  });

  it("is unknown, and doesn't throw, when the RPC fails", async () => {
    const down: GetLedgerEntries = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const answer = await lookUpTrustline(down, { account: HOLDER, asset: SAC });
    expect(answer).toEqual({
      status: "unknown",
      classicAsset: undefined,
      reason: "the RPC didn't answer: Error: connect ECONNREFUSED",
    });
  });

  it("is unknown on pubnet without an RPC URL, before any request", async () => {
    const answer = await checkTrustline({ account: HOLDER, asset: SAC, network: "stellar:pubnet" });
    expect(answer).toEqual({ status: "unknown", reason: "no RPC URL given for stellar:pubnet" });
  });

  it("is unknown when the RPC can't be reached", async () => {
    const answer = await checkTrustline({
      account: HOLDER,
      asset: SAC,
      network: "stellar:testnet",
      rpcUrl: "http://127.0.0.1:9",
      timeoutMs: 2_000,
    });
    expect(answer.status).toBe("unknown");
    expect(answer.reason).toMatch(/^the RPC didn't answer/);
  });

  // Port 9 above refuses at once; an RPC that takes the connection and stays silent is what the
  // time limit is for.
  it.each(["silent", "headers"] as const)(
    "is unknown within the time limit when the RPC never answers (%s)",
    async (mode) => {
      const rpc = await hangingRpc(mode);
      try {
        const started = Date.now();
        const answer = await checkTrustline({
          account: HOLDER,
          asset: SAC,
          network: "stellar:testnet",
          rpcUrl: rpc.url,
          timeoutMs: 200,
        });
        expect(answer.status).toBe("unknown");
        expect(answer.reason).toMatch(/^the RPC didn't answer/);
        // One request, the contract's, cut at 200 ms; the bound leaves room for a slow runner.
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        rpc.close();
      }
    },
    10_000,
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "refuses a timeoutMs of %s, which would be no limit or none it can keep",
    async (timeoutMs) => {
      await expect(
        checkTrustline({ account: HOLDER, asset: SAC, network: "stellar:testnet", timeoutMs }),
      ).rejects.toThrow(TypeError);
    },
  );
});
