import { Address, Keypair, StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import { failureCause, type FailureCause } from "@stellar-x402/signer-pool";
import { describe, expect, it, vi } from "vitest";
import {
  NONCE_CONSUMED_REASON,
  NONCE_CONSUMED_SETTLE_REASON,
  consumedElsewhere,
  createNonceLookup,
} from "../src/settlement/nonce-used.js";
import measured from "./fixtures/nonce-consumed-elsewhere.json" with { type: "json" };

const payer = Keypair.random().publicKey();
const asset = StrKey.encodeContract(Buffer.alloc(32, 7));

/** One of our failed settlements on testnet, as `getTransaction` answered it. */
const failedResponse = (c: (typeof measured.cases)[number]) =>
  ({
    status: "FAILED",
    resultXdr: xdr.TransactionResult.fromXDR(c.resultXdr, "base64"),
    diagnosticEventsXdr: c.diagnosticEventsXdr.map((e) => xdr.DiagnosticEvent.fromXDR(e, "base64")),
  }) as unknown as rpc.Api.GetFailedTransactionResponse;

describe("the codes", () => {
  it("names the case for /verify and for /settle", () => {
    expect(NONCE_CONSUMED_REASON).toBe("invalid_exact_stellar_payload_nonce_consumed_elsewhere");
    expect(NONCE_CONSUMED_SETTLE_REASON).toBe("settle_exact_stellar_nonce_consumed_elsewhere");
  });
});

describe("consumedElsewhere", () => {
  it.each(measured.cases.map((c) => [c.case, c] as const))(
    "tells it from our failed transaction on testnet when %s",
    (_name, c) => {
      expect(consumedElsewhere(failureCause(failedResponse(c)), c.payer)).toBe(true);
    },
  );

  it.each<[string, FailureCause | undefined]>([
    ["no cause", undefined],
    ["an unreadable cause", {}],
    [
      "another auth error",
      { error: { type: "sceAuth", code: "scecInvalidAction" }, contract: asset },
    ],
    ["a contract error", { error: { type: "sceContract", code: "10" }, contract: asset }],
    // In the payer's own frame it is the wallet's own nested auth, not a used nonce (0024).
    [
      "the same error from the payer's own contract",
      { error: { type: "sceAuth", code: "scecExistingValue" }, contract: payer },
    ],
  ])("is false for %s", (_name, failure) => {
    expect(consumedElsewhere(failure, payer)).toBe(false);
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

  it("is undefined, and logged, when the read fails", async () => {
    const warn = vi.fn();
    const getLedgerEntries = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const used = createNonceLookup({ getLedgerEntries } as never, "stellar:testnet", { warn });
    await expect(used(payer, "7")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "nonce_lookup_failed",
      expect.objectContaining({ network: "stellar:testnet" }),
    );
  });
});
