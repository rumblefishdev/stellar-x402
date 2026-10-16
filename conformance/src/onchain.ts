import {
  Address,
  FeeBumpTransaction,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/** The payment a settled scenario must have made: `transfer(from, to, amount)` on the asset. */
export interface ExpectedTransfer {
  asset: string;
  from: string;
  to: string;
  amount: bigint;
}

/**
 * What is wrong with a scenario's transaction as Stellar RPC's `getTransaction` returns it, or
 * undefined. The suite only reports a hash; this checks the chain settled the payment it stands
 * for: one call of the asset's `transfer`, buyer to seller, for the price.
 */
export function checkSettlement(
  status: string,
  envelopeXdr: string | undefined,
  expected: ExpectedTransfer,
): string | undefined {
  if (status !== "SUCCESS" || !envelopeXdr) return `is ${status} on chain`;
  const want = `transfer ${expected.from} -> ${expected.to} ${expected.amount} of ${expected.asset}`;

  // The facilitator's fee bump wraps the buyer's transaction.
  const tx = TransactionBuilder.fromXDR(envelopeXdr, Networks.TESTNET);
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const op = inner.operations[0];
  if (
    inner.operations.length !== 1 ||
    op?.type !== "invokeHostFunction" ||
    op.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()
  ) {
    return `is not one contract call, expected ${want}`;
  }

  const call = op.func.invokeContract();
  const [from, to, amount] = call.args().map((arg) => scValToNative(arg));
  const asset = Address.fromScAddress(call.contractAddress()).toString();
  const actual = `${call.functionName()} ${from} -> ${to} ${amount} of ${asset}`;
  return actual === want ? undefined : `moves ${actual}, expected ${want}`;
}
