import { Address, Keypair, StrKey, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { failureCause } from "../src/index.js";
import { failedResult, type InvokeHostFunctionFailure } from "./testing.js";

const SAC = StrKey.encodeContract(Buffer.alloc(32, 9));
const payer = Keypair.random().publicKey();
const payTo = StrKey.encodeContract(Buffer.alloc(32, 4));

function diagnostic(
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  contract: Buffer | null = Buffer.alloc(32, 9),
  type: xdr.ContractEventType = xdr.ContractEventType.diagnostic(),
) {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: contract as unknown as xdr.Hash | null,
      type,
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    }),
  });
}

const sym = (name: string) => xdr.ScVal.scvSymbol(name);
const error = (e: xdr.ScError) => xdr.ScVal.scvError(e);
const address = (a: string) => new Address(a).toScVal();

/** What a SAC emits when a transfer is refused: `error`, `Error(Contract, #10)`, and the call. */
const sacError = () =>
  diagnostic(
    [sym("error"), error(xdr.ScError.sceContract(10))],
    xdr.ScVal.scvVec([
      nativeToScVal("transfer failed", { type: "string" }),
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: sym("from"), val: address(payer) }),
        new xdr.ScMapEntry({ key: sym("to"), val: xdr.ScVal.scvVec([address(payTo)]) }),
      ]),
    ]),
  );

function failed(
  opCode: InvokeHostFunctionFailure,
  extra: Partial<rpc.Api.GetFailedTransactionResponse> = {},
  feeBump = true,
) {
  return {
    status: rpc.Api.GetTransactionStatus.FAILED,
    resultXdr: failedResult(opCode, { feeBump }),
    ...extra,
  } as unknown as rpc.Api.GetFailedTransactionResponse;
}

describe("failureCause", () => {
  it("reads the operation code and the SAC's contract error, through a fee bump", () => {
    const res = failed("invokeHostFunctionTrapped", { diagnosticEventsXdr: [sacError()] });
    expect(failureCause(res)).toEqual({
      opCode: "invokeHostFunctionTrapped",
      error: { type: "sceContract", code: "10" },
      contract: SAC,
      data: [payer, payTo],
    });
  });

  it("reads a transaction that was not fee-bumped", () => {
    expect(failureCause(failed("invokeHostFunctionEntryArchived", {}, false))).toEqual({
      opCode: "invokeHostFunctionEntryArchived",
    });
  });

  it("gives only the code for a resource limit with no events", () => {
    expect(failureCause(failed("invokeHostFunctionResourceLimitExceeded"))).toEqual({
      opCode: "invokeHostFunctionResourceLimitExceeded",
    });
  });

  it("names a non-contract error by its code", () => {
    const event = diagnostic(
      [sym("error"), error(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()))],
      xdr.ScVal.scvVoid(),
    );
    expect(
      failureCause(failed("invokeHostFunctionTrapped", { diagnosticEventsXdr: [event] })),
    ).toEqual({
      opCode: "invokeHostFunctionTrapped",
      error: { type: "sceAuth", code: "scecInvalidAction" },
      contract: SAC,
    });
  });

  it("takes the first error event and skips other events", () => {
    const other = diagnostic([sym("fn_call")], xdr.ScVal.scvVoid());
    const second = diagnostic(
      [sym("error"), error(xdr.ScError.sceContract(3))],
      xdr.ScVal.scvVoid(),
      Buffer.alloc(32, 1),
    );
    const res = failed("invokeHostFunctionTrapped", {
      diagnosticEventsXdr: [other, sacError(), second],
    });
    expect(failureCause(res).error).toEqual({ type: "sceContract", code: "10" });
  });

  it("ignores an error event a contract published itself, before the host's", () => {
    // Any contract can publish `("error", Error(Auth, ...))`; only the host emits diagnostic ones.
    const fake = diagnostic(
      [sym("error"), error(xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue()))],
      xdr.ScVal.scvVoid(),
      Buffer.alloc(32, 1),
      xdr.ContractEventType.contract(),
    );
    const res = failed("invokeHostFunctionTrapped", { diagnosticEventsXdr: [fake, sacError()] });
    expect(failureCause(res)).toEqual({
      opCode: "invokeHostFunctionTrapped",
      error: { type: "sceContract", code: "10" },
      contract: SAC,
      data: [payer, payTo],
    });
  });

  it("keeps at most 8 addresses in the data, each once", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      StrKey.encodeContract(Buffer.alloc(32, 20 + i)),
    );
    const event = diagnostic(
      [sym("error"), error(xdr.ScError.sceContract(10))],
      xdr.ScVal.scvVec([address(payer), address(payer), ...many.map(address)]),
    );
    const { data } = failureCause(
      failed("invokeHostFunctionTrapped", { diagnosticEventsXdr: [event] }),
    );
    expect(data).toEqual([payer, ...many.slice(0, 7)]);
  });

  it("falls back to the diagnostic events in the transaction meta", () => {
    const sorobanMeta = new xdr.SorobanTransactionMeta({
      ext: new xdr.SorobanTransactionMetaExt(0),
      events: [],
      returnValue: xdr.ScVal.scvVoid(),
      diagnosticEvents: [sacError()],
    });
    const resultMetaXdr = new xdr.TransactionMeta(
      3,
      new xdr.TransactionMetaV3({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta,
      }),
    );
    const cause = failureCause(failed("invokeHostFunctionTrapped", { resultMetaXdr }));
    expect(cause.error).toEqual({ type: "sceContract", code: "10" });
    expect(cause.contract).toBe(SAC);
  });

  it("falls back to the diagnostic events of a v4 transaction meta (protocol 23 on)", () => {
    const resultMetaXdr = new xdr.TransactionMeta(
      4,
      new xdr.TransactionMetaV4({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta: null,
        events: [],
        diagnosticEvents: [sacError()],
      }),
    );
    const cause = failureCause(failed("invokeHostFunctionTrapped", { resultMetaXdr }));
    expect(cause.error).toEqual({ type: "sceContract", code: "10" });
    expect(cause.contract).toBe(SAC);
    expect(cause.data).toEqual([payer, payTo]);
  });

  it("never throws: what cannot be decoded is left out", () => {
    expect(failureCause({} as rpc.Api.GetFailedTransactionResponse)).toEqual({});
    const res = failed("invokeHostFunctionTrapped", {
      diagnosticEventsXdr: [null as unknown as xdr.DiagnosticEvent],
    });
    expect(failureCause(res)).toEqual({ opCode: "invokeHostFunctionTrapped" });
  });
});
