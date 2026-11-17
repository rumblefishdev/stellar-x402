import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  NONCE_CONSUMED_REASON,
  NONCE_CONSUMED_SETTLE_REASON,
  createNonceLookup,
} from "../src/settlement/nonce-used.js";

const payer = Keypair.random().publicKey();

describe("the codes", () => {
  it("names the case for /verify and for /settle", () => {
    expect(NONCE_CONSUMED_REASON).toBe("invalid_exact_stellar_payload_nonce_consumed_elsewhere");
    expect(NONCE_CONSUMED_SETTLE_REASON).toBe("settle_exact_stellar_nonce_consumed_elsewhere");
  });
});

describe("createNonceLookup", () => {
  const nonceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(payer).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString("7") })),
      durability: xdr.ContractDataDurability.temporary(),
    }),
  );
  const logger = { warn: vi.fn() };

  it("reads the payer's nonce entry, the one the host writes when the nonce is used", async () => {
    const getLedgerEntries = vi.fn(async () => ({ entries: [{}], latestLedger: 1 }));
    const used = createNonceLookup({ getLedgerEntries } as never, "stellar:testnet", logger);
    await expect(used(payer, "7")).resolves.toBe(true);
    const [key] = getLedgerEntries.mock.calls[0] as unknown as [xdr.LedgerKey];
    expect(key.toXDR("base64")).toBe(nonceKey.toXDR("base64"));
  });

  it("builds the key the host writes, as the Rust XDR encodes it", async () => {
    // Case 1 of fixtures/nonce-consumed-elsewhere.json, encoded by stellar-xdr 26.0.0
    // (`stellar xdr encode --type LedgerKey`): another implementation than the SDK's.
    const getLedgerEntries = vi.fn(async () => ({ entries: [], latestLedger: 1 }));
    const used = createNonceLookup({ getLedgerEntries } as never, "stellar:testnet", logger);
    await used("GC3SAXQUYEIVHGAQRSRIGCYM2EX34EO3UJXX4ABAEZZ6Z3J7JBJ7AGAW", "8252820810222655277");
    const [key] = getLedgerEntries.mock.calls[0] as unknown as [xdr.LedgerKey];
    expect(key.toXDR("base64")).toBe(
      "AAAABgAAAAAAAAAAtyBeFMERU5gQjKKDCwzRL74R26JvfgAgJnPs7T9IU/AAAAAVcofozTRF1y0AAAAA",
    );
  });

  it("is false, and logged, when the payer can't be encoded", async () => {
    const warn = vi.fn();
    const getLedgerEntries = vi.fn();
    const used = createNonceLookup({ getLedgerEntries } as never, "stellar:testnet", { warn });
    await expect(used("not-an-address", "7")).resolves.toBe(false);
    expect(getLedgerEntries).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "nonce_lookup_failed",
      expect.objectContaining({ network: "stellar:testnet" }),
    );
  });

  it("is false without the entry", async () => {
    const getLedgerEntries = vi.fn(async () => ({ entries: [], latestLedger: 1 }));
    const used = createNonceLookup({ getLedgerEntries } as never, "stellar:testnet", logger);
    await expect(used(payer, "7")).resolves.toBe(false);
  });

  it("is false, and logged, when the read fails", async () => {
    const warn = vi.fn();
    const getLedgerEntries = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const used = createNonceLookup({ getLedgerEntries } as never, "stellar:testnet", { warn });
    await expect(used(payer, "7")).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "nonce_lookup_failed",
      expect.objectContaining({ network: "stellar:testnet" }),
    );
  });
});
