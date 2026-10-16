import { readFileSync } from "node:fs";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  type xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkSettlement, type ExpectedTransfer } from "../src/onchain.js";

// A real gate settlement: x402.org's fee bump around the buyer's USDC transfer, scenario #1 of the
// dry run on 2026-10-16, transaction 008397cb…, read with RPC getTransaction.
const settled = readFileSync(new URL("fixtures/settlement.xdr", import.meta.url), "utf8").trim();

const expected: ExpectedTransfer = {
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  from: "GDUFPEXV27XLNI2UNEIOY4HQAMAGSNIHV2QHPZRPFPK5QGK6S3AD5AFK",
  to: "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF",
  amount: 10000n,
};

const wanted = `transfer ${expected.from} -> ${expected.to} 10000 of ${expected.asset}`;

/** A transaction with one operation, without a fee bump, as base64 XDR. */
function oneOperation(operation: xdr.Operation) {
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build()
    .toXDR();
}

/** `fn(from, to, 10000)` on the expected asset. */
function call(fn: string) {
  return Operation.invokeContractFunction({
    contract: expected.asset,
    function: fn,
    args: [
      new Address(expected.from).toScVal(),
      new Address(expected.to).toScVal(),
      nativeToScVal(10000n, { type: "i128" }),
    ],
  });
}

describe("checkSettlement", () => {
  it("passes a successful transfer of the price from the buyer to the seller", () => {
    expect(checkSettlement("SUCCESS", settled, expected)).toBeUndefined();
  });

  it("fails a transaction that is not on chain or did not succeed", () => {
    expect(checkSettlement("NOT_FOUND", undefined, expected)).toBe("is NOT_FOUND on chain");
    expect(checkSettlement("FAILED", settled, expected)).toBe("is FAILED on chain");
  });

  it("names what moved when the amount, payer, payee or asset differs", () => {
    const actual = `transfer ${expected.from} -> ${expected.to} 10000 of ${expected.asset}`;
    for (const other of [
      { ...expected, amount: 10001n },
      { ...expected, from: expected.to },
      { ...expected, to: expected.from },
      { ...expected, asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
    ]) {
      const want = `transfer ${other.from} -> ${other.to} ${other.amount} of ${other.asset}`;
      expect(checkSettlement("SUCCESS", settled, other)).toBe(`moves ${actual}, expected ${want}`);
    }
  });

  it("reads a transfer that has no fee bump around it", () => {
    expect(checkSettlement("SUCCESS", oneOperation(call("transfer")), expected)).toBeUndefined();
  });

  it("fails a call of another function with the same arguments", () => {
    expect(checkSettlement("SUCCESS", oneOperation(call("approve")), expected)).toBe(
      `moves approve ${expected.from} -> ${expected.to} 10000 of ${expected.asset}, expected ${wanted}`,
    );
  });

  it("fails a transaction with more than the one transfer", () => {
    const two = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(call("transfer"))
      .addOperation(call("transfer"))
      .setTimeout(30)
      .build()
      .toXDR();
    expect(checkSettlement("SUCCESS", two, expected)).toBe(
      `is not one contract call, expected ${wanted}`,
    );
  });

  it("fails a host function that is not a contract call", () => {
    const upload = oneOperation(Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115]) }));
    expect(checkSettlement("SUCCESS", upload, expected)).toBe(
      `is not one contract call, expected ${wanted}`,
    );
  });

  it("fails a transaction that is not one contract call", () => {
    const payment = oneOperation(
      Operation.payment({ destination: expected.to, asset: Asset.native(), amount: "1" }),
    );
    expect(checkSettlement("SUCCESS", payment, expected)).toBe(
      `is not one contract call, expected ${wanted}`,
    );
  });
});
