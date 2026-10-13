import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  FeeBumpTransaction,
  Networks,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

// Recorded testnet XDR from protocol 29 (scripts/record-xdr-fixture.ts): a 0007 smoke-run
// settlement in the delegated-bump shape, with the client's AddressV2 entry (CAP-71), and the
// LedgerCloseMeta v2 of its ledger. It guards AD-14: we stay on @stellar/stellar-sdk 16.x and its
// XDR accessor API, and that version must keep parsing what the network produces.
const dir = new URL("./fixtures/protocol-29/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("transaction.json", dir), "utf8")) as {
  hash: string;
  ledger: number;
  envelopeXdr: string;
  resultXdr: string;
  resultMetaXdr: string;
};
const ledgerCloseMeta = gunzipSync(readFileSync(new URL("ledger-close-meta.xdr.gz", dir)));

const installed = (name: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"),
    ) as { version: string }
  ).version;

describe("protocol-29 XDR fixture", () => {
  it("runs on the versions AD-14 pins", () => {
    expect(installed("@stellar/stellar-sdk")).toMatch(/^16\./);
    expect(installed("@x402/stellar")).toMatch(/^2\.28\./);
  });

  it("parses the fee bump with its AddressV2 entry and keeps the hash", () => {
    const tx = TransactionBuilder.fromXDR(fixture.envelopeXdr, Networks.TESTNET);
    expect(tx).toBeInstanceOf(FeeBumpTransaction);
    const bump = tx as FeeBumpTransaction;
    expect(bump.hash().toString("hex")).toBe(fixture.hash);
    expect(bump.toXDR()).toBe(fixture.envelopeXdr);

    const inner = bump.innerTransaction;
    expect(inner.operations).toHaveLength(1);
    const op = inner.operations[0]!;
    expect(op.type).toBe("invokeHostFunction");
    if (op.type !== "invokeHostFunction") return;
    // The facilitator is the fee-bump payer and the operation source; a channel is the tx source.
    expect(op.source).toBe(bump.feeSource);
    expect(inner.source).not.toBe(bump.feeSource);

    const kinds = op.auth?.map((a) => a.credentials().switch().name);
    expect(kinds).toEqual(["sorobanCredentialsAddressV2", "sorobanCredentialsSourceAccount"]);
    const client = op.auth![0]!.credentials().addressV2();
    expect(
      StrKey.isValidEd25519PublicKey(
        StrKey.encodeEd25519PublicKey(client.address().accountId().ed25519()),
      ),
    ).toBe(true);
    expect(client.signatureExpirationLedger()).toBeGreaterThan(fixture.ledger);
    expect(client.signature().switch().name).toBe("scvVec");
    const root = op.auth![0]!.rootInvocation().function().contractFn();
    expect(root.functionName().toString()).toBe("settle_upto");
  });

  it("parses the fee bump's result and the transaction meta", () => {
    const result = xdr.TransactionResult.fromXDR(fixture.resultXdr, "base64");
    expect(result.result().switch().name).toBe("txFeeBumpInnerSuccess");
    expect(result.feeCharged().toBigInt()).toBeGreaterThan(0n);

    const meta = xdr.TransactionMeta.fromXDR(fixture.resultMetaXdr, "base64");
    expect(meta.switch()).toBe(4);
    expect(meta.v4().sorobanMeta()).toBeTruthy();
  });

  it("parses the LedgerCloseMeta v2 of the ledger that applied it", () => {
    const lcm = xdr.LedgerCloseMeta.fromXDR(ledgerCloseMeta);
    expect(lcm.switch()).toBe(2);
    const v2 = lcm.v2();
    const header = v2.ledgerHeader().header();
    expect(header.ledgerSeq()).toBe(fixture.ledger);
    expect(header.ledgerVersion()).toBe(29);

    const hashes = v2.txProcessing().map((p) => p.result().transactionHash().toString("hex"));
    expect(hashes).toContain(fixture.hash);
    const ours = v2
      .txProcessing()
      .find((p) => p.result().transactionHash().toString("hex") === fixture.hash)!;
    // The ledger's copy of the apply meta is not byte-equal to the one getTransaction returns
    // (change order and timing metrics differ), so compare the result and the meta version.
    expect(ours.result().result().toXDR("base64")).toBe(fixture.resultXdr);
    expect(ours.txApplyProcessing().switch()).toBe(4);
  });
});
