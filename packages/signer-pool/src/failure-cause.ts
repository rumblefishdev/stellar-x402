import { Address, xdr, type rpc } from "@stellar/stellar-sdk";

/**
 * Why a transaction that was included in a ledger failed, as far as the RPC says. Every field is
 * optional: a resource-limit failure has no error event, and an RPC may send no events at all.
 */
export interface FailureCause {
  /** The first operation's `InvokeHostFunctionResult` name, e.g. `invokeHostFunctionTrapped`. */
  opCode?: string;
  /**
   * The `ScError` of the first `error` event the host emitted (a diagnostic one): `type` is the `ScErrorType` name
   * (`sceContract`, `sceAuth`, ...), `code` the contract's error number for `sceContract` (`"10"`)
   * and the `ScErrorCode` name (`scecInvalidAction`) for any other type.
   */
  error?: { type: string; code: string };
  /** The contract that emitted that event (`C...`). */
  contract?: string;
  /** Account and contract addresses (`G...`, `C...`) in that event's data: each once, at most 8. */
  data?: string[];
}

/**
 * Reads the cause out of a failed transaction's result and diagnostic events. Never throws: what
 * can't be decoded is left out, down to `{}`.
 */
export function failureCause(res: rpc.Api.GetFailedTransactionResponse): FailureCause {
  const cause: FailureCause = {};
  try {
    const opCode = operationCode(res.resultXdr);
    if (opCode) cause.opCode = opCode;
  } catch {
    // Left out.
  }
  try {
    Object.assign(cause, errorEvent(diagnosticEvents(res)));
  } catch {
    // Left out.
  }
  return cause;
}

/** The first operation's `InvokeHostFunctionResult` name, through a fee bump's inner result. */
function operationCode(result: xdr.TransactionResult): string | undefined {
  const outer = result.result();
  let results: xdr.OperationResult[] | undefined;
  switch (outer.switch().name) {
    case "txFeeBumpInnerFailed":
      results = outer.innerResultPair().result().result().results();
      break;
    case "txFailed":
      results = outer.results();
      break;
  }
  const op = results?.[0];
  if (op?.switch().name !== "opInner") return undefined;
  const tr = op.tr();
  if (tr.switch().name !== "invokeHostFunction") return undefined;
  return tr.invokeHostFunctionResult().switch().name;
}

/** The response's diagnostic events, or the ones in its soroban meta when it has none. */
function diagnosticEvents(res: rpc.Api.GetFailedTransactionResponse): xdr.DiagnosticEvent[] {
  if (res.diagnosticEventsXdr?.length) return res.diagnosticEventsXdr;
  try {
    const meta = res.resultMetaXdr;
    switch (meta.switch()) {
      case 3:
        return meta.v3().sorobanMeta()?.diagnosticEvents() ?? [];
      case 4:
        return meta.v4().diagnosticEvents();
    }
  } catch {
    // No usable meta.
  }
  return [];
}

/** Addresses kept from an event's data: enough for a SAC's, bounded for any other. */
const MAX_DATA_ADDRESSES = 8;

/**
 * The first `error` event of type `diagnostic`. Only the host emits those; a contract can publish
 * an event named `error` with any `ScError` in it, so a `contract` event is skipped, or a token
 * could name an `Error(Auth, …)` of its choice ahead of the host's.
 */
function errorEvent(events: xdr.DiagnosticEvent[]): FailureCause {
  for (const diagnostic of events) {
    const event = diagnostic.event();
    if (event.type().name !== "diagnostic") continue;
    const topics = event.body().v0().topics();
    const [name, value] = topics;
    if (name?.switch().name !== "scvSymbol" || name.sym().toString() !== "error") continue;
    const cause: FailureCause = {};
    if (value?.switch().name === "scvError") {
      const error = value.error();
      const type = error.switch().name;
      cause.error = {
        type,
        code: type === "sceContract" ? String(error.contractCode()) : error.code().name,
      };
    }
    const id = event.contractId();
    if (id)
      cause.contract = Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(id)).toString();
    const data = addresses(event.body().v0().data());
    if (data.length > 0) cause.data = data;
    return cause;
  }
  return {};
}

/** The distinct addresses in a value, looking through vectors and maps, up to the first 8. */
function addresses(value: xdr.ScVal, found: string[] = []): string[] {
  if (found.length >= MAX_DATA_ADDRESSES) return found;
  switch (value.switch().name) {
    case "scvAddress": {
      const address = Address.fromScAddress(value.address()).toString();
      if (!found.includes(address)) found.push(address);
      break;
    }
    case "scvVec":
      for (const item of value.vec() ?? []) addresses(item, found);
      break;
    case "scvMap":
      for (const entry of value.map() ?? []) {
        addresses(entry.key(), found);
        addresses(entry.val(), found);
      }
      break;
  }
  return found;
}
