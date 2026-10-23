import {
  Address,
  FeeBumpTransaction,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * What a settled scenario's transaction must be: `transfer(from, to, amount)` on the asset, its fee
 * paid by a signer the facilitator under test lists in `/supported`, made after the run started.
 */
export interface Expected {
  asset: string;
  from: string;
  to: string;
  amount: bigint;
  signers: string[];
  /**
   * The last ledger RPC had closed before the suite started, read from the same RPC: a settlement
   * of this run is in a later one.
   */
  ledgerBeforeRun: number;
}

/** One transaction as the chain shows it, saved with the run. */
export interface Settlement {
  transaction: string;
  status: string;
  ledger?: number;
  /** Unix seconds, the ledger's close time. */
  createdAt?: number;
  feePayer?: string;
  /** `fn from -> to amount of asset`; absent when the transaction is not one contract call. */
  call?: string;
}

/** Reads what RPC `getTransaction` returned for a transaction that is on chain. */
export function readSettlement(
  transaction: string,
  status: string,
  ledger: number,
  createdAt: number,
  envelopeXdr: string,
): Settlement {
  // The facilitator's fee bump wraps the buyer's transaction; whoever pays the fee settled it.
  const tx = TransactionBuilder.fromXDR(envelopeXdr, Networks.TESTNET);
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const feePayer = tx instanceof FeeBumpTransaction ? tx.feeSource : tx.source;
  const read = { transaction, status, ledger, createdAt, feePayer };

  const op = inner.operations[0];
  if (
    inner.operations.length !== 1 ||
    op?.type !== "invokeHostFunction" ||
    op.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()
  ) {
    return read;
  }
  const call = op.func.invokeContract();
  const [from, to, amount] = call.args().map((arg) => scValToNative(arg));
  const asset = Address.fromScAddress(call.contractAddress()).toString();
  return { ...read, call: `${call.functionName()} ${from} -> ${to} ${amount} of ${asset}` };
}

/**
 * What is wrong with a scenario's transaction, or undefined. The suite only reports a hash; this
 * checks the chain settled the payment it stands for, through the facilitator under test, in
 * this run: a replayed or reused hash fails here.
 */
export function checkSettlement(settlement: Settlement, expected: Expected): string | undefined {
  if (settlement.status !== "SUCCESS") return `is ${settlement.status} on chain`;
  const want = `transfer ${expected.from} -> ${expected.to} ${expected.amount} of ${expected.asset}`;
  if (!settlement.call) return `is not one contract call, expected ${want}`;
  if (settlement.call !== want) return `moves ${settlement.call}, expected ${want}`;
  if (!expected.signers.includes(settlement.feePayer!)) {
    return `was paid for by ${settlement.feePayer}, not by a signer the facilitator lists (${expected.signers.join(", ")})`;
  }
  if (settlement.ledger! <= expected.ledgerBeforeRun) {
    return `is in ledger ${settlement.ledger}, not after ledger ${expected.ledgerBeforeRun} that closed before the run started`;
  }
  return undefined;
}
