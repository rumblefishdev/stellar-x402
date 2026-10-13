import { Address, MuxedAccount, StrKey, Transaction, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@stellar-x402/config";
import {
  DEFAULT_ESTIMATED_LEDGER_SECONDS,
  getAddressCredentials,
  getNetworkPassphrase,
} from "@x402/stellar";
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
  /**
   * How long upstream `verify()` may take, in milliseconds; 10,000 by default, as `FallbackRpc`.
   * Upstream's RPC and Horizon clients have no timeout of their own.
   */
  upstreamTimeoutMs?: number;
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

export class UpstreamTimeoutError extends Error {
  override readonly name = "UpstreamTimeoutError";
}

/**
 * About how many ledgers upstream's client signs a resource's `maxTimeoutSeconds` for (AD-22):
 * ⌈maxTimeoutSeconds / ledger time⌉, with upstream's default ledger time. The client takes the
 * time from Horizon when it can, so this is an estimate.
 */
export function signedLedgers(maxTimeoutSeconds: number): number {
  return Math.ceil(maxTimeoutSeconds / DEFAULT_ESTIMATED_LEDGER_SECONDS);
}

export type Verify = (
  payload: PaymentPayload,
  requirements: PaymentRequirements,
) => Promise<VerifyResponse>;

/**
 * The `exact` verification `/verify` answers with and `/settle` (0009) runs again (AD-3): the
 * network and envelope checks, upstream `verify()`, then the channel check (AD-5, with the
 * facilitator's muxed address), then the validity check (AD-22). The first rejection is the
 * answer. Errors are thrown, not answered: ours (the ledger read), upstream's, which it reports as
 * `unexpected_verify_error`, and an upstream call past `upstreamTimeoutMs`.
 */
export function createVerifier(deps: VerifierDeps): Verify {
  const check = createChecker(deps);
  return async (payload, requirements) => (await check(payload, requirements)).response;
}

/** A payment that passed every check, as `/settle` needs it. */
export interface Verified {
  transaction: Transaction;
  payer: string;
  /** The earliest `signatureExpirationLedger` of the auth entries. */
  expirationLedger: number;
  /** The ledger the validity check read. */
  currentLedger: number;
}

export type Check = (
  payload: PaymentPayload,
  requirements: PaymentRequirements,
) => Promise<{ response: VerifyResponse; verified?: Verified }>;

/** {@link createVerifier}'s checks, also returning what they parsed and read when they pass. */
export function createChecker(deps: VerifierDeps): Check {
  const accounts = new Set([...deps.channels, deps.facilitator]);
  const timeoutMs = deps.upstreamTimeoutMs ?? 10_000;
  return async (payload, requirements) => {
    // Upstream would verify against any Stellar network's default RPC; this process serves one.
    if (requirements.network !== deps.network) {
      return {
        response: invalid("invalid_network", undefined, `this facilitator serves ${deps.network}`),
      };
    }
    // Upstream parses a V0 envelope, and its simulation result then can't be assembled onto it.
    if (isV0Envelope(payload)) {
      return {
        response: invalid(
          "invalid_exact_stellar_payload_malformed",
          undefined,
          "the transaction must be a v1 envelope",
        ),
      };
    }
    const upstream = withStringPayer(
      await withTimeout(deps.upstream.verify(payload, requirements), timeoutMs),
    );
    // Upstream catches every exception, a failed RPC call included, and answers with this code.
    // It says nothing about the payment, so it is our error: a 500, logged as one.
    if (upstream.invalidReason === UNEXPECTED_VERIFY_ERROR) {
      throw new Error(`upstream verify failed with ${UNEXPECTED_VERIFY_ERROR}`);
    }
    if (!upstream.isValid) return { response: upstream };
    // Upstream always names the payer of a valid payment; without one, nothing below can run.
    if (upstream.payer === undefined) throw new Error("upstream verify named no payer");

    // Upstream accepted it, so the payload is a parsed, one-operation `transfer` call.
    const transaction = new Transaction(
      (payload.payload as { transaction: string }).transaction,
      getNetworkPassphrase(deps.network),
    );
    const problem = channelProblem(transaction, accounts);
    if (problem) {
      const isFacilitator = problem.account === deps.facilitator;
      const response = {
        ...invalid(
          problem.invalidReason,
          upstream.payer,
          isFacilitator
            ? "the payload uses the facilitator's account"
            : "the payload uses a facilitator channel account",
        ),
        extra: { reason: isFacilitator ? MUXED_FACILITATOR_REASON : CHANNEL_ACCOUNT_REASON },
      };
      return { response };
    }

    const expiration = authExpiration(transaction);
    const current = await deps.latestLedger();
    if (expiration - current < deps.minValidityLedgers) {
      // A client signs for about this many ledgers, and some pass before `/verify`.
      const signed = signedLedgers(requirements.maxTimeoutSeconds);
      const floor = deps.minValidityLedgers * DEFAULT_ESTIMATED_LEDGER_SECONDS;
      const hint =
        signed <= deps.minValidityLedgers
          ? `; maxTimeoutSeconds ${requirements.maxTimeoutSeconds} is about ${signed} ledgers, ` +
            `so it should be well above ${floor}`
          : "";
      return {
        response: invalid(
          "invalid_exact_stellar_signature_expiration_too_soon",
          upstream.payer,
          `auth expires at ledger ${expiration}, ${expiration - current} ledgers after ledger ` +
            `${current}; at least ${deps.minValidityLedgers} are required${hint}`,
        ),
      };
    }
    return {
      response: upstream,
      verified: {
        transaction,
        payer: upstream.payer,
        expirationLedger: expiration,
        currentLedger: current,
      },
    };
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

/** Whether the payload's transaction decodes as a V0 envelope; anything else is upstream's. */
function isV0Envelope(payload: PaymentPayload): boolean {
  const transaction = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
  if (typeof transaction !== "string") return false;
  try {
    return (
      xdr.TransactionEnvelope.fromXDR(transaction, "base64").switch() ===
      xdr.EnvelopeType.envelopeTypeTxV0()
    );
  } catch {
    return false;
  }
}

/**
 * Upstream's answer with `payer` only when it is a string. Upstream takes it from `from` before
 * any signature check, so the client chooses its type: a number breaks x402 clients, and an i128
 * breaks `res.json`.
 */
function withStringPayer(response: VerifyResponse): VerifyResponse {
  return response.payer === undefined || typeof response.payer === "string"
    ? response
    : { ...response, payer: undefined };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UpstreamTimeoutError(`upstream verify gave no answer within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
