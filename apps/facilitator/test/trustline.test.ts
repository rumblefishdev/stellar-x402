import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  PAYER_TRUSTLINE_REASON,
  PAYTO_TRUSTLINE_REASON,
  createTrustlineLookup,
} from "../src/settlement/trustline.js";

const assetBytes = Buffer.alloc(32, 7);
const asset = StrKey.encodeContract(assetBytes);
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const NAME = `USDC:${Keypair.random().publicKey()}`;

const transaction = new TransactionBuilder(new Account(payer, "1"), {
  fee: "100",
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(
    Operation.invokeContractFunction({ contract: asset, function: "transfer", args: [] }),
  )
  .setTimeout(60)
  .build();
const payment = { transaction, asset, payer, payTo };

/** A contract's error event, as the SAC emits it on testnet (`#13`, text, account). */
function errorEvent(account: string, { code = 13, contract = assetBytes } = {}) {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: contract as never,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(code))],
          data: xdr.ScVal.scvVec([
            nativeToScVal("trustline entry is missing for account"),
            new Address(account).toScVal(),
          ]),
        }),
      ),
    }),
  });
}

const failed = (...events: xdr.DiagnosticEvent[]) => ({
  id: "1",
  latestLedger: 1,
  events,
  _parsed: true,
  error: "HostError: Error(Contract, #13)",
});

/** The contract's instance entry: a SAC's, with its `METADATA`, or a Wasm contract's. */
function instance(sac: boolean, metadata = true) {
  const storage = metadata
    ? [
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("METADATA"),
          val: nativeToScVal({ decimal: 7, name: NAME, symbol: "USDC" }),
        }),
      ]
    : [];
  const val = xdr.ScVal.scvContractInstance(
    new xdr.ScContractInstance({
      executable: sac
        ? xdr.ContractExecutable.contractExecutableStellarAsset()
        : xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32) as never),
      storage,
    }),
  );
  const contractData = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: new Address(asset).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val,
  });
  return {
    latestLedger: 1,
    entries: [{ key: {}, val: xdr.LedgerEntryData.contractData(contractData) }],
  };
}

function setup(simulation: unknown, entries: unknown = instance(true), timeoutMs?: number) {
  const simulateTransaction = vi.fn(async () => simulation);
  const getLedgerEntries = vi.fn(async () => entries);
  const warn = vi.fn();
  const find = createTrustlineLookup(
    { simulateTransaction, getLedgerEntries } as never,
    { warn },
    timeoutMs,
  );
  return { find, simulateTransaction, getLedgerEntries, warn };
}

describe("createTrustlineLookup", () => {
  it("names payTo, the asset and what the seller must do", async () => {
    const { find, simulateTransaction } = setup(failed(errorEvent(payTo)));
    await expect(find(payment)).resolves.toEqual({
      invalidReason: PAYTO_TRUSTLINE_REASON,
      invalidMessage: `${payTo} has no ${NAME} trustline: the account must exist and hold one`,
    });
    expect(simulateTransaction).toHaveBeenCalledWith(transaction);
  });

  it("names the payer, and says payTo wasn't checked", async () => {
    const { find } = setup(failed(errorEvent(payer)));
    await expect(find(payment)).resolves.toEqual({
      invalidReason: PAYER_TRUSTLINE_REASON,
      invalidMessage: `${payer} has no ${NAME} trustline: the account must exist and hold one; payTo wasn't checked`,
    });
  });

  it("finds the error among the other events", async () => {
    const other = errorEvent(payTo, { code: 10 });
    const { find } = setup(failed(other, errorEvent(payTo)));
    await expect(find(payment)).resolves.toMatchObject({ invalidReason: PAYTO_TRUSTLINE_REASON });
  });

  it("keeps quiet for a token that emits the same error but isn't a SAC", async () => {
    const { find, warn } = setup(failed(errorEvent(payer)), instance(false));
    await expect(find(payment)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps quiet when the contract's instance can't be found", async () => {
    const { find } = setup(failed(errorEvent(payer)), { latestLedger: 1, entries: [] });
    await expect(find(payment)).resolves.toBeUndefined();
  });

  it("names the asset by its contract when the SAC has no name", async () => {
    const { find } = setup(failed(errorEvent(payTo)), instance(true, false));
    await expect(find(payment)).resolves.toMatchObject({
      invalidMessage: expect.stringContaining(`has no ${asset} trustline`),
    });
  });

  it("keeps quiet for every other simulation failure, without reading the contract", async () => {
    const lowBalance = failed(errorEvent(payer, { code: 10 }));
    const otherContract = failed(errorEvent(payer, { contract: Buffer.alloc(32, 9) }));
    const noEvents = failed();
    for (const simulation of [lowBalance, otherContract, noEvents]) {
      const { find, getLedgerEntries } = setup(simulation);
      await expect(find(payment)).resolves.toBeUndefined();
      expect(getLedgerEntries).not.toHaveBeenCalled();
    }
  });

  it("keeps quiet when the named account is neither the payer nor payTo", async () => {
    const { find, getLedgerEntries } = setup(failed(errorEvent(Keypair.random().publicKey())));
    await expect(find(payment)).resolves.toBeUndefined();
    expect(getLedgerEntries).not.toHaveBeenCalled();
  });

  it("keeps quiet when the second simulation succeeds", async () => {
    const { find, getLedgerEntries } = setup({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      transactionData: {},
      minResourceFee: "1",
    });
    await expect(find(payment)).resolves.toBeUndefined();
    expect(getLedgerEntries).not.toHaveBeenCalled();
  });

  it("logs a failed simulation or read and gives no answer", async () => {
    const failing = setup(failed());
    failing.simulateTransaction.mockRejectedValue(new Error("rpc down"));
    await expect(failing.find(payment)).resolves.toBeUndefined();
    expect(failing.warn).toHaveBeenCalledWith("trustline_lookup_failed", {
      error: expect.any(Error),
    });

    const unreadable = setup(failed(errorEvent(payer)));
    unreadable.getLedgerEntries.mockRejectedValue(new Error("rpc down"));
    await expect(unreadable.find(payment)).resolves.toBeUndefined();
    expect(unreadable.warn).toHaveBeenCalledOnce();
  });

  it("stops at its limit and gives no answer", async () => {
    const hung = setup(failed(), undefined, 10);
    hung.simulateTransaction.mockReturnValue(new Promise(() => {}));
    await expect(hung.find(payment)).resolves.toBeUndefined();
    expect(hung.warn).toHaveBeenCalledOnce();
  });
});
