import {
  Account,
  Address,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

/** Who pays whom, for what: `requirements` gives the asset and the amount. */
export interface Transfer {
  payer: string;
  payTo: string;
  requirements: PaymentRequirements;
}

/**
 * A testnet `transfer` of `requirements.amount` from the payer, with its one auth entry (nonce 7)
 * valid to `expiration`, unsigned.
 */
export function transferPayload(
  { payer, payTo, requirements }: Transfer,
  expiration: number,
  extensions?: Record<string, unknown>,
): PaymentPayload {
  const asset = requirements.asset;
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(payer).toScAddress(),
        nonce: xdr.Int64.fromString("7"),
        signatureExpirationLedger: expiration,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(asset).toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
  const transaction = new TransactionBuilder(new Account(payer, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: asset,
        function: "transfer",
        args: [
          nativeToScVal(payer, { type: "address" }),
          nativeToScVal(payTo, { type: "address" }),
          nativeToScVal(BigInt(requirements.amount), { type: "i128" }),
        ],
        auth: [auth],
      }),
    )
    .setTimeout(60)
    .build();
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: transaction.toXDR() },
    ...(extensions && { resource: { url: "https://seller.example.com/users/42" }, extensions }),
  } as PaymentPayload;
}

/**
 * `paymentPayload.extensions` as upstream's client sends it for a Bazaar resource: the seller's
 * whole declaration, with an output schema of `levels` nested nullable objects (what zod's
 * `.nullable()` emits).
 */
export function bazaarExtensions(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < levels; i++) {
    schema = { anyOf: [{ type: "object", properties: { next: schema } }, { type: "null" }] };
  }
  return declareDiscoveryExtension({
    input: { q: "x" },
    output: { example: {}, schema: { type: "object", properties: { result: schema } } },
  });
}

/** How many arrays and objects deep `value` nests. */
export function depthOf(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  return 1 + Math.max(0, ...Object.values(value).map(depthOf));
}
