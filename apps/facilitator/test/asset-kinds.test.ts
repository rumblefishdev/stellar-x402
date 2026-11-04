import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createAssetKinds } from "../src/spend/asset-kinds.js";

const contract = () => StrKey.encodeContract(Keypair.random().rawPublicKey());

function instanceEntry(asset: string, executable: xdr.ContractExecutable) {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(asset).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(asset).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  );
  return { key, val, lastModifiedLedgerSeq: 1 };
}

const sacExec = () => xdr.ContractExecutable.contractExecutableStellarAsset();
const wasmExec = () => xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32));

function fakeRpc(respond: (asset: string) => Promise<ReturnType<typeof instanceEntry>[]>) {
  const calls: string[] = [];
  return {
    calls,
    getLedgerEntries: async (key: xdr.LedgerKey) => {
      const asset = Address.fromScAddress(key.contractData().contract()).toString();
      calls.push(asset);
      return { latestLedger: 1, entries: await respond(asset) };
    },
  };
}

describe("createAssetKinds", () => {
  it("answers a known asset as sac without asking the RPC", async () => {
    const usdc = contract();
    const rpc = fakeRpc(async () => []);
    const kinds = createAssetKinds({ rpc, known: [usdc] });
    expect(await kinds.kind(usdc)).toBe("sac");
    expect(rpc.calls).toHaveLength(0);
    expect(kinds.tier(usdc)).toBe("known");
  });

  it("reads a SAC instance as sac and a wasm instance as wasm", async () => {
    const sac = contract();
    const wasm = contract();
    const rpc = fakeRpc(async (a) => [instanceEntry(a, a === sac ? sacExec() : wasmExec())]);
    const kinds = createAssetKinds({ rpc, known: [] });
    expect(await kinds.kind(sac)).toBe("sac");
    expect(await kinds.kind(wasm)).toBe("wasm");
  });

  it("serves a second call from the cache", async () => {
    const sac = contract();
    const rpc = fakeRpc(async (a) => [instanceEntry(a, sacExec())]);
    const kinds = createAssetKinds({ rpc, known: [] });
    await kinds.kind(sac);
    await kinds.kind(sac);
    expect(rpc.calls).toHaveLength(1);
  });

  it("answers wasm on an RPC error or a missing entry, and asks again next time", async () => {
    const a = contract();
    let fail = true;
    const rpc = fakeRpc(async (asset) => {
      if (fail) throw new Error("fetch failed");
      return [instanceEntry(asset, sacExec())];
    });
    const kinds = createAssetKinds({ rpc, known: [] });
    expect(await kinds.kind(a)).toBe("wasm");
    fail = false;
    expect(await kinds.kind(a)).toBe("sac");
    const missing = contract();
    const empty = fakeRpc(async () => []);
    const k2 = createAssetKinds({ rpc: empty, known: [] });
    expect(await k2.kind(missing)).toBe("wasm");
    await k2.kind(missing);
    expect(empty.calls).toHaveLength(2);
  });

  it("tells a self-issued SAC: kind sac, tier other", async () => {
    const own = contract();
    const rpc = fakeRpc(async (a) => [instanceEntry(a, sacExec())]);
    const kinds = createAssetKinds({ rpc, known: [contract()] });
    expect(await kinds.kind(own)).toBe("sac");
    expect(kinds.tier(own)).toBe("other");
  });

  it("confirms a known asset and a read kind, but not a wasm defaulted from an error (0024)", async () => {
    const usdc = contract();
    const sac = contract();
    const err = contract();
    const rpc = fakeRpc(async (a) => {
      if (a === err) throw new Error("fetch failed");
      return [instanceEntry(a, sacExec())];
    });
    const kinds = createAssetKinds({ rpc, known: [usdc] });
    expect(kinds.confirmed(usdc)).toBe(true);
    expect(await kinds.kind(sac)).toBe("sac");
    expect(kinds.confirmed(sac)).toBe(true);
    // An error defaults to wasm, but unconfirmed: a breaker must not open on it.
    expect(await kinds.kind(err)).toBe("wasm");
    expect(kinds.confirmed(err)).toBe(false);
  });

  it("caps the cache, so it can't grow without bound, and re-reads an evicted asset (0024)", async () => {
    const rpc = fakeRpc(async (a) => [instanceEntry(a, sacExec())]);
    const kinds = createAssetKinds({ rpc, known: [], cacheMax: 2 });
    const [a, b, c] = [contract(), contract(), contract()];
    await kinds.kind(a);
    await kinds.kind(b);
    await kinds.kind(c); // evicts the oldest, a
    expect(kinds.confirmed(a)).toBe(false);
    const before = rpc.calls.length;
    expect(await kinds.kind(a)).toBe("sac");
    expect(rpc.calls.length).toBe(before + 1);
  });

  it("answers wasm, unconfirmed, when the RPC read exceeds the timeout (0024)", async () => {
    const a = contract();
    const rpc = {
      calls: [] as string[],
      getLedgerEntries: () => new Promise<never>(() => {}), // never resolves
    };
    const kinds = createAssetKinds({ rpc, known: [], readTimeoutMs: 20 });
    expect(await kinds.kind(a)).toBe("wasm");
    expect(kinds.confirmed(a)).toBe(false);
  });
});
