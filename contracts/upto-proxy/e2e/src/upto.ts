// The `upto` signing model, split by role as the x402 facilitator will use it:
// - the client simulates `settle_upto` with a placeholder amount and signs only its auth entry;
// - the facilitator checks that entry against the payment terms, swaps in the actual amount and
//   submits through the channel pool (delegated-bump shape, ADR 0003).
import { randomBytes } from "node:crypto";
import {
  Address,
  Contract,
  type Keypair,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { ContractCall } from "@stellar-x402/signer-pool";
import { PASSPHRASE, server } from "./chain.js";

/** Everything the client signs, plus the allowance expiry bound by its `approve`. */
export interface UptoTerms {
  proxy: string;
  token: string;
  from: string;
  to: string;
  facilitator: string;
  maxAmount: bigint;
  nonce: Buffer;
  validAfter: bigint;
  deadline: bigint;
  allowanceExpirationLedger: number;
}

const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });
const u64 = (v: bigint) => nativeToScVal(v, { type: "u64" });
const u32 = (v: number) => nativeToScVal(v, { type: "u32" });

export function newTerms(
  base: Omit<UptoTerms, "nonce" | "validAfter" | "deadline">,
  overrides: Partial<UptoTerms> = {},
): UptoTerms {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    ...base,
    nonce: randomBytes(32),
    validAfter: now - 60n,
    deadline: now + 900n,
    ...overrides,
  };
}

/** The full `settle_upto` argument list (spec §2). */
export function settleArgs(t: UptoTerms, actual: bigint): xdr.ScVal[] {
  return [
    addr(t.token),
    addr(t.from),
    addr(t.to),
    addr(t.facilitator),
    i128(t.maxAmount),
    i128(actual),
    xdr.ScVal.scvBytes(t.nonce),
    u64(t.validAfter),
    u64(t.deadline),
    u32(t.allowanceExpirationLedger),
  ];
}

const contractFn = (
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
) =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    subInvocations,
  });

/**
 * The auth tree the client must sign (spec §3.1). The root covers every argument except `from`
 * (the signer), `actual_amount` (unsigned) and `allowance_expiration_ledger`, which is bound
 * through the `approve` sub-invocation.
 */
export function expectedClientInvocation(t: UptoTerms): xdr.SorobanAuthorizedInvocation {
  return contractFn(
    t.proxy,
    "settle_upto",
    [
      addr(t.token),
      addr(t.to),
      addr(t.facilitator),
      i128(t.maxAmount),
      xdr.ScVal.scvBytes(t.nonce),
      u64(t.validAfter),
      u64(t.deadline),
    ],
    [
      contractFn(t.token, "approve", [
        addr(t.from),
        addr(t.proxy),
        i128(t.maxAmount),
        u32(t.allowanceExpirationLedger),
      ]),
    ],
  );
}

const entryAddress = (entry: xdr.SorobanAuthorizationEntry): string | undefined => {
  const creds = entry.credentials();
  switch (creds.switch().name) {
    case "sorobanCredentialsAddress":
      return Address.fromScAddress(creds.address().address()).toString();
    case "sorobanCredentialsAddressV2":
      return Address.fromScAddress(creds.addressV2().address()).toString();
    default:
      return undefined;
  }
};

/**
 * Client side: simulate the call with the ceiling as a placeholder amount (recording mode), take
 * the auth entry for `from` and sign it. The client never builds, signs or pays for a
 * transaction.
 */
export async function clientSign(
  t: UptoTerms,
  client: Keypair,
  signatureExpirationLedger: number,
): Promise<xdr.SorobanAuthorizationEntry> {
  // The facilitator is the simulation source, as it is the operation source on chain: with the
  // client as source, its auth would be recorded as source-account credentials, not a signable
  // address entry.
  const draft = new TransactionBuilder(await server.getAccount(t.facilitator), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(t.proxy).call("settle_upto", ...settleArgs(t, t.maxAmount)))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`client simulation failed: ${"error" in sim ? sim.error : "no result"}`);
  }
  const entry = sim.result.auth.find((e) => entryAddress(e) === t.from);
  if (!entry) throw new Error("simulation returned no auth entry for the client");
  return authorizeEntry(entry, client, signatureExpirationLedger, PASSPHRASE);
}

/**
 * Client side, without simulation: builds the entry from the terms and signs it. Recording-mode
 * simulation runs the whole call, so it can't produce an entry for terms the contract refuses
 * (too early, expired, a used nonce); the rejection scenarios sign this way.
 */
export function clientSignDirect(
  t: UptoTerms,
  client: Keypair,
  signatureExpirationLedger: number,
): Promise<xdr.SorobanAuthorizationEntry> {
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(t.from).toScAddress(),
        nonce: xdr.Int64.fromString(randomBytes(8).readBigInt64BE().toString()),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: expectedClientInvocation(t),
  });
  return authorizeEntry(entry, client, signatureExpirationLedger, PASSPHRASE);
}

/** Facilitator side: refuse an entry that isn't exactly the tree the terms call for. */
export function checkClientAuth(entry: xdr.SorobanAuthorizationEntry, t: UptoTerms): void {
  if (entryAddress(entry) !== t.from) throw new Error("auth entry is not from the payer");
  const signed = entry.rootInvocation().toXDR("base64");
  if (signed !== expectedClientInvocation(t).toXDR("base64")) {
    throw new Error("client auth tree does not match the payment terms");
  }
}

/**
 * Facilitator side: the call it submits, with `actual` swapped in. The facilitator authorizes as
 * the operation source (source-account credentials); the pool sets it as the operation source.
 * `argsTerms` lets a test tamper with the submitted arguments while keeping the signed entry.
 */
export function settleCall(
  clientAuth: xdr.SorobanAuthorizationEntry,
  t: UptoTerms,
  actual: bigint,
  argsTerms: UptoTerms = t,
): ContractCall {
  const args = settleArgs(argsTerms, actual);
  return {
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(argsTerms.proxy).toScAddress(),
        functionName: "settle_upto",
        args,
      }),
    ),
    auth: [
      clientAuth,
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: contractFn(argsTerms.proxy, "settle_upto", args),
      }),
    ],
  };
}

/** Arguments of `is_nonce_used` for these terms. */
export const nonceArgs = (t: UptoTerms) => [addr(t.from), xdr.ScVal.scvBytes(t.nonce)];
