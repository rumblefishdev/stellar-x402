import { Address, MuxedAccount, StrKey, Transaction, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@stellar-x402/config";
import { getAddressCredentials, getNetworkPassphrase } from "@x402/stellar";
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";

/** Upstream `ExactStellarScheme` as `/verify` uses it: only `verify()`, never `settle()` (AD-3). */
export interface UpstreamVerifier {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
}

export interface VerifierDeps {
  /** The one network this process serves. */
  network: StellarNetwork;
  upstream: UpstreamVerifier;
  /** Channel account addresses (AD-5). */
  channels: readonly string[];
  /** Least ledgers left before the payer's auth expires (AD-22). */
  minValidityLedgers: number;
  /** Sequence of the latest closed ledger. */
  latestLedger: () => Promise<number>;
}

/**
 * Our own code for a channel problem, in `extra.reason` next to upstream's standard
 * `invalidReason`: it tells our check apart from upstream's facilitator-address check.
 */
export const CHANNEL_ACCOUNT_REASON = "invalid_exact_stellar_payload_channel_account";

export type Verify = (
  payload: PaymentPayload,
  requirements: PaymentRequirements,
) => Promise<VerifyResponse>;

/**
 * The `exact` verification `/verify` answers with and `/settle` (0009) runs again (AD-3):
 * upstream `verify()`, then the channel check (AD-5), then the validity check (AD-22). The first
 * failure is the answer. Upstream reports its own errors as `isValid: false`; an error of ours
 * (the ledger read) is thrown.
 */
export function createVerifier(deps: VerifierDeps): Verify {
  const channels = new Set(deps.channels);
  return async (payload, requirements) => {
    // Upstream would verify against any Stellar network's default RPC; this process serves one.
    if (requirements.network !== deps.network) {
      return invalid("invalid_network", undefined, `this facilitator serves ${deps.network}`);
    }
    const upstream = await deps.upstream.verify(payload, requirements);
    if (!upstream.isValid) return upstream;

    // Upstream accepted it, so the payload is a parsed, one-operation `transfer` call.
    const transaction = new Transaction(
      (payload.payload as { transaction: string }).transaction,
      getNetworkPassphrase(deps.network),
    );
    const reason = channelProblem(transaction, channels);
    if (reason) {
      return {
        ...invalid(reason, upstream.payer, "the payload uses a facilitator channel account"),
        extra: { reason: CHANNEL_ACCOUNT_REASON },
      };
    }

    const expiration = authExpiration(transaction);
    const current = await deps.latestLedger();
    if (expiration - current < deps.minValidityLedgers) {
      return invalid(
        "invalid_exact_stellar_signature_expiration_too_soon",
        upstream.payer,
        `auth expires at ledger ${expiration}, ${expiration - current} ledgers after ledger ` +
          `${current}; at least ${deps.minValidityLedgers} are required`,
      );
    }
    return upstream;
  };
}

/**
 * Where a channel account appears in the payload, as the upstream reason for the same problem
 * with the facilitator's own address (ADR 0005: channels count as the facilitator). Muxed
 * addresses count as their base account.
 */
export function channelProblem(
  transaction: Transaction,
  channels: ReadonlySet<string>,
): string | undefined {
  const isChannel = (address: string | undefined) =>
    address !== undefined && channels.has(baseAccount(address));
  if (
    isChannel(transaction.source) ||
    transaction.operations.some((operation) => isChannel(operation.source))
  ) {
    return "invalid_exact_stellar_payload_unsafe_tx_or_op_source";
  }
  for (const operation of transaction.operations) {
    if (operation.type !== "invokeHostFunction") continue;
    const func = operation.func;
    if (func.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      const from = func.invokeContract().args()[0];
      if (from?.switch() === xdr.ScValType.scvAddress() && isChannel(addressOf(from.address()))) {
        return "invalid_exact_stellar_payload_facilitator_is_payer";
      }
    }
    for (const entry of operation.auth ?? []) {
      const credentials = getAddressCredentials(entry.credentials());
      if (credentials && isChannel(addressOf(credentials.address()))) {
        return "invalid_exact_stellar_payload_facilitator_in_auth";
      }
    }
  }
  return undefined;
}

/** The earliest `signatureExpirationLedger` of the payload's address-credential auth entries. */
export function authExpiration(transaction: Transaction): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const operation of transaction.operations) {
    if (operation.type !== "invokeHostFunction") continue;
    for (const entry of operation.auth ?? []) {
      const credentials = getAddressCredentials(entry.credentials());
      if (credentials) earliest = Math.min(earliest, credentials.signatureExpirationLedger());
    }
  }
  // Upstream rejects a payload without address-credential auth entries.
  if (earliest === Number.POSITIVE_INFINITY) throw new Error("the payload has no auth entries");
  return earliest;
}

function addressOf(address: xdr.ScAddress): string {
  return Address.fromScAddress(address).toString();
}

function baseAccount(address: string): string {
  return StrKey.isValidMed25519PublicKey(address)
    ? MuxedAccount.fromAddress(address, "0").baseAccount().accountId()
    : address;
}

function invalid(invalidReason: string, payer: string | undefined, invalidMessage: string) {
  return { isValid: false, invalidReason, invalidMessage, payer } satisfies VerifyResponse;
}
