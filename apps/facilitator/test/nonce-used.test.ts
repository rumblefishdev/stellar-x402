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
