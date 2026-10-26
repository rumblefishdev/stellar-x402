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
import { checkSettlement, readSettlement, type Expected } from "../src/onchain.js";

// A real gate settlement: x402.org's fee bump around the buyer's USDC transfer, scenario #1 of the
// dry run on 2026-10-16, transaction 008397cb…, read with RPC getTransaction.
const hash = "008397cb1f4ccbaec6cacead393251e4705d446f28b72c702fca449a9680cdd2";
const envelope = readFileSync(new URL("fixtures/settlement.xdr", import.meta.url), "utf8").trim();

// x402.org's two Stellar signers in its /supported; the second pays its fee bumps.
const x402orgSigners = [
  "GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K",
  "GC5OLUZ4WANPN6VT7YGTK2SRMZG762KOVKJXHWIO4K57UBASO2FMNRET",
];

const expected: Expected = {
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  from: "GDUFPEXV27XLNI2UNEIOY4HQAMAGSNIHV2QHPZRPFPK5QGK6S3AD5AFK",
  to: "GAS7JQRKLXPO5L7OFYDEILAM6AZGPHFJKQ2UJV7TAT5BNXPCXX54L5IF",
  amount: 10000n,
  signers: x402orgSigners,
  ledgerBeforeRun: 5_224_990,
};

const transfer = `transfer ${expected.from} -> ${expected.to} 10000 of ${expected.asset}`;
const settled = readSettlement(hash, "SUCCESS", 5_225_000, 1_792_150_100, envelope);

/** A transaction without a fee bump, as base64 XDR, sent from `source`. */
function plain(operations: xdr.Operation[], source = Keypair.random().publicKey()) {
  const builder = new TransactionBuilder(new Account(source, "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  });
  for (const operation of operations) builder.addOperation(operation);
  return builder.setTimeout(30).build().toXDR();
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

describe("readSettlement", () => {
  it("reads the call, the fee payer, the ledger and the time of a real settlement", () => {
    expect(settled).toEqual({
      transaction: hash,
      status: "SUCCESS",
      ledger: 5_225_000,
      createdAt: 1_792_150_100,
      feePayer: "GC5OLUZ4WANPN6VT7YGTK2SRMZG762KOVKJXHWIO4K57UBASO2FMNRET",
      call: transfer,
    });
  });

  it("takes the source as the fee payer when there is no fee bump", () => {
    const source = x402orgSigners[0]!;
    const read = readSettlement(hash, "SUCCESS", 1, 1, plain([call("transfer")], source));
    expect(read.feePayer).toBe(source);
    expect(read.call).toBe(transfer);
  });

  it("has no call when the transaction is not one contract call", () => {
    const payment = Operation.payment({
      destination: expected.to,
      asset: Asset.native(),
      amount: "1",
    });
    const upload = Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115]) });
    for (const operations of [[payment], [upload], [call("transfer"), call("transfer")]]) {
      expect(readSettlement(hash, "SUCCESS", 1, 1, plain(operations)).call).toBeUndefined();
    }
  });
});

describe("checkSettlement", () => {
  it("passes a transfer of the price, buyer to seller, paid by a listed signer, in this run", () => {
    expect(checkSettlement(settled, expected)).toBeUndefined();
  });

  it("fails a transaction that is not on chain or did not succeed", () => {
    expect(checkSettlement({ transaction: hash, status: "NOT_FOUND" }, expected)).toBe(
      "is NOT_FOUND on chain",
    );
    expect(checkSettlement({ ...settled, status: "FAILED" }, expected)).toBe("is FAILED on chain");
  });

  it("fails a transaction that is not one contract call", () => {
    expect(checkSettlement({ ...settled, call: undefined }, expected)).toBe(
      `is not one contract call, expected ${transfer}`,
    );
  });

  it("names what moved when the call, amount, payer, payee or asset differs", () => {
    for (const other of [
      { ...expected, amount: 10001n },
      { ...expected, from: expected.to },
      { ...expected, to: expected.from },
      { ...expected, asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
    ]) {
      const want = `transfer ${other.from} -> ${other.to} ${other.amount} of ${other.asset}`;
      expect(checkSettlement(settled, other)).toBe(`moves ${transfer}, expected ${want}`);
    }
    const approve = transfer.replace("transfer", "approve");
    expect(checkSettlement({ ...settled, call: approve }, expected)).toBe(
      `moves ${approve}, expected ${transfer}`,
    );
  });

  it("fails a fee paid by an account the facilitator does not list as its signer", () => {
    const ours = ["GCMXDA6V4YDB6Z5QJ7HXNHM6WJPAWJTZTIAW6IFTJFIYTTE4XMOSJ5SB"];
    expect(checkSettlement(settled, { ...expected, signers: ours })).toBe(
      `was paid for by GC5OLUZ4WANPN6VT7YGTK2SRMZG762KOVKJXHWIO4K57UBASO2FMNRET, not by a signer the facilitator lists (${ours[0]})`,
    );
  });

  it("fails a transaction in a ledger closed before the run started", () => {
    expect(checkSettlement(settled, { ...expected, ledgerBeforeRun: 5_225_000 })).toBe(
      "is in ledger 5225000, not after ledger 5225000 that closed before the run started",
    );
    expect(checkSettlement(settled, { ...expected, ledgerBeforeRun: 5_225_001 })).toBe(
      "is in ledger 5225000, not after ledger 5225001 that closed before the run started",
    );
    expect(checkSettlement(settled, { ...expected, ledgerBeforeRun: 5_224_999 })).toBeUndefined();
  });
});
