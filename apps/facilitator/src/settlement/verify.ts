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
  /** The facilitator's own address. Upstream checks it as a plain string, so not in muxed form. */
  facilitator: string;
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
/**
 * Our code for the facilitator's own address in muxed form, which upstream's plain-string check
 * misses; upstream rejects the plain address itself.
 */
export const MUXED_FACILITATOR_REASON = "invalid_exact_stellar_payload_facilitator_muxed";

/** Upstream's code for an exception inside its `verify()`. */
const UNEXPECTED_VERIFY_ERROR = "unexpected_verify_error";

/** Ledger close time as upstream's client estimates it when Horizon doesn't answer. */
const LEDGER_SECONDS = 5;

/**
 * The shortest `maxTimeoutSeconds` whose payments can pass the validity check (AD-22). Upstream's
 * client signs its auth to expire ⌈maxTimeoutSeconds / ledger time⌉ ledgers ahead, and at least
 * one ledger passes before `/verify`.
 */
export function shortestTimeoutSeconds(minValidityLedgers: number): number {
  return (minValidityLedgers + 1) * LEDGER_SECONDS;
}

export type Verify = (
  payload: PaymentPayload,
  requirements: PaymentRequirements,
) => Promise<VerifyResponse>;

/**
 * The `exact` verification `/verify` answers with and `/settle` (0009) runs again (AD-3):
 * upstream `verify()`, then the channel check (AD-5, with the facilitator's muxed address), then
 * the validity check (AD-22). The first failure is the answer. An error is thrown, not answered:
 * ours (the ledger read), and upstream's, which it reports as `unexpected_verify_error`.
 */
export function createVerifier(deps: VerifierDeps): Verify {
  const accounts = new Set([...deps.channels, deps.facilitator]);
  return async (payload, requirements) => {
    // Upstream would verify against any Stellar network's default RPC; this process serves one.
    if (requirements.network !== deps.network) {
      return invalid("invalid_network", undefined, `this facilitator serves ${deps.network}`);
    }
    const upstream = await deps.upstream.verify(payload, requirements);
    // Upstream catches every exception, a failed RPC call included, and answers with this code.
    // It says nothing about the payment, so it is our error: a 500, logged as one.
    if (upstream.invalidReason === UNEXPECTED_VERIFY_ERROR) {
      throw new Error(`upstream verify failed with ${UNEXPECTED_VERIFY_ERROR}`);
    }
    if (!upstream.isValid) return upstream;

    // Upstream accepted it, so the payload is a parsed, one-operation `transfer` call.
    const transaction = new Transaction(
      (payload.payload as { transaction: string }).transaction,
      getNetworkPassphrase(deps.network),
    );
    const problem = channelProblem(transaction, accounts);
    if (problem) {
      const isFacilitator = problem.account === deps.facilitator;
      return {
        ...invalid(
          problem.invalidReason,
          upstream.payer,
          isFacilitator
            ? "the payload uses the facilitator's account"
            : "the payload uses a facilitator channel account",
        ),
        extra: { reason: isFacilitator ? MUXED_FACILITATOR_REASON : CHANNEL_ACCOUNT_REASON },
      };
    }

    const expiration = authExpiration(transaction);
    const current = await deps.latestLedger();
    if (expiration - current < deps.minValidityLedgers) {
      const shortest = shortestTimeoutSeconds(deps.minValidityLedgers);
      const hint =
        requirements.maxTimeoutSeconds < shortest
          ? `; maxTimeoutSeconds must be at least ${shortest}, ` +
            `not ${requirements.maxTimeoutSeconds}`
          : "";
      return invalid(
        "invalid_exact_stellar_signature_expiration_too_soon",
        upstream.payer,
        `auth expires at ledger ${expiration}, ${expiration - current} ledgers after ledger ` +
          `${current}; at least ${deps.minValidityLedgers} are required${hint}`,
      );
    }
    return upstream;
  };
}

/**
 * Where one of `accounts` (the channels and the facilitator) appears in the payload, as the
 * upstream reason for the same problem with the facilitator's own address (ADR 0005: channels
 * count as the facilitator), and which account it is. Muxed addresses count as their base account.
 */
export function channelProblem(
  transaction: Transaction,
  accounts: ReadonlySet<string>,
): { invalidReason: string; account: string } | undefined {
  const found = (address: string | undefined) => {
    const account = address === undefined ? undefined : baseAccount(address);
    return account !== undefined && accounts.has(account) ? account : undefined;
  };
  const source =
    found(transaction.source) ??
    transaction.operations.map((operation) => found(operation.source)).find(Boolean);
  if (source) {
    return {
      invalidReason: "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
      account: source,
    };
  }
  for (const operation of transaction.operations) {
    if (operation.type !== "invokeHostFunction") continue;
    const func = operation.func;
    if (func.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      const from = func.invokeContract().args()[0];
      const payer =
        from?.switch() === xdr.ScValType.scvAddress()
          ? found(addressOf(from.address()))
          : undefined;
      if (payer) {
        return {
          invalidReason: "invalid_exact_stellar_payload_facilitator_is_payer",
          account: payer,
        };
      }
    }
    for (const entry of operation.auth ?? []) {
      const credentials = getAddressCredentials(entry.credentials());
      const signer = credentials ? found(addressOf(credentials.address())) : undefined;
      if (signer) {
        return {
          invalidReason: "invalid_exact_stellar_payload_facilitator_in_auth",
          account: signer,
        };
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
