import {
  Address,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  PayerNotAuthorizedError,
  expectTransfer,
  hasPayerNonce,
} from "../src/settlement/settle.js";

const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
const payTo = Keypair.random().publicKey();
const gPayer = Keypair.random().publicKey();
const cPayer = StrKey.encodeContract(Buffer.alloc(32, 3));
const NONCE = "5206736521";

/** The footprint key the host writes when `owner`'s auth entry with `nonce` is used. */
const nonceKey = (
  owner: string,
  nonce: string,
  durability = xdr.ContractDataDurability.temporary(),
): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(owner).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce) })),
      durability,
    }),
  );

/** A simulation with one valid transfer from `payer` and the given footprint. */
function sim(
  payer: string,
  readWrite: xdr.LedgerKey[],
  readOnly: xdr.LedgerKey[] = [],
): rpc.Api.SimulateTransactionSuccessResponse {
  const event = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: StrKey.decodeContract(asset) as never,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [
            xdr.ScVal.scvSymbol("transfer"),
            nativeToScVal(payer, { type: "address" }),
            nativeToScVal(payTo, { type: "address" }),
          ],
          data: nativeToScVal(1000n, { type: "i128" }),
        }),
      ),
    }),
  });
  return {
    events: [event],
    transactionData: new SorobanDataBuilder().setFootprint(readOnly, readWrite),
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

const check = (payer: string) =>
  expectTransfer({ asset, from: payer, to: payTo, amount: 1000n, nonce: NONCE });

describe("the payer's nonce in the settlement's footprint", () => {
  it("accepts the payer's nonce key in the read-write footprint", () => {
    expect(() => check(gPayer)(sim(gPayer, [nonceKey(gPayer, NONCE)]))).not.toThrow();
  });

  it("accepts a C-account payer's nonce key", () => {
    expect(() => check(cPayer)(sim(cPayer, [nonceKey(cPayer, NONCE)]))).not.toThrow();
  });

  it("refuses a footprint without it (a token that skips require_auth)", () => {
    expect(() => check(gPayer)(sim(gPayer, []))).toThrow(PayerNotAuthorizedError);
  });

  it("refuses the key only in the read-only footprint", () => {
    expect(() => check(gPayer)(sim(gPayer, [], [nonceKey(gPayer, NONCE)]))).toThrow(
      PayerNotAuthorizedError,
    );
  });

  it("refuses another address's nonce key, and the payer's key with another nonce", () => {
    const other = Keypair.random().publicKey();
    expect(() => check(gPayer)(sim(gPayer, [nonceKey(other, NONCE)]))).toThrow(
      PayerNotAuthorizedError,
    );
    expect(() => check(gPayer)(sim(gPayer, [nonceKey(gPayer, "5206736522")]))).toThrow(
      PayerNotAuthorizedError,
    );
  });

  it("refuses a persistent key", () => {
    const key = nonceKey(gPayer, NONCE, xdr.ContractDataDurability.persistent());
    expect(hasPayerNonce(sim(gPayer, [key]), gPayer, NONCE)).toBe(false);
  });
});
