import { createHash } from "node:crypto";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { TransactionSigner } from "@stellar-x402/signer-pool";
import { Agent, request } from "undici";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";

/**
 * The facilitator key held in OpenBao's Transit engine (ADR 0013, task 0036): the signer sends a
 * transaction's 32-byte hash to `transit/sign/<key>` over OpenBao's unix socket and adds the
 * signature. No secret seed reaches this process.
 */

/**
 * How long one request to OpenBao may take. The slowest of 10,000 measured signatures at half a
 * CPU took 286 ms (0036 decision 13); a hung OpenBao must not hold a channel longer.
 */
const REQUEST_TIMEOUT_MS = 1_000;
/**
 * A token with less than this left is replaced before it signs, while it still works, so no
 * signature waits on an expired one (0036 decision 10). The AWS SDK refreshes 5 minutes early too.
 */
const RELOGIN_MARGIN_MS = 5 * 60_000;
/**
 * How soon a failed check after start tries again (an assumption): OpenBao opens seconds after its
 * unit starts (ADR 0013), and `/health` shouldn't need a payment to show that it did. It stops at
 * the first pass: later, only a signature changes `signer`.
 */
const CHECK_RETRY_MS = 30_000;
/** What the check after start signs: the hash of a text, which no transaction has. */
const CHECK_HASH = createHash("sha256").update("stellar-x402 signer check").digest();

/** `/health`'s `signer`: the outcome of the latest signature, or of the check after start. */
export type SignerState = "unchecked" | "ok" | "failed";

/**
 * Why OpenBao didn't give a usable signature, for the logs and `signer_failures_total`:
 * `sealed` (503), `denied` (403: an expired, revoked or unauthorised token, or an AppRole locked
 * after 5 failed logins, which refuses the right secret ID too until unlocked with a privileged
 * token), `refused` (another 4xx, e.g. a wrong secret ID), `error` (a 5xx, such as an audit log it can't write, or an answer
 * without a signature), `timeout`, `unreachable` (no socket), `address_mismatch` (signed by a key
 * other than the configured address's).
 */
type SignerFailure =
  "sealed" | "denied" | "refused" | "error" | "timeout" | "unreachable" | "address_mismatch";

export class SignerError extends Error {
  override readonly name = "SignerError";
  constructor(
    readonly reason: SignerFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface OpenBaoSignerOptions {
  /** The OpenBao key's own account: the fee account and the channels' signer (ADR 0013). */
  address: string;
  socketPath: string;
  /** The Transit key's name. */
  key: string;
  /** Pinned, so a rotated Transit key can't sign in place of the one on chain. */
  keyVersion: number;
  roleId: string;
  secretId: string;
  network: string;
  logger: Pick<Logger, "info" | "warn">;
  metrics: Metrics;
  /** Test seam: the clock tokens expire by. */
  now?: () => number;
  /** Test seam: {@link CHECK_RETRY_MS}. */
  checkRetryMs?: number;
}

export interface OpenBaoSigner extends TransactionSigner {
  state(): SignerState;
  /**
   * Signs a fixed value and checks it against `address`, and again while that fails; the outcome
   * goes to {@link state}. The retry's timer keeps no process alive.
   */
  check(): Promise<void>;
  /** Stops the check's retries. */
  close(): void;
}

export function openBaoSigner(opts: OpenBaoSignerOptions): OpenBaoSigner {
  const { address, keyVersion, network, logger, metrics } = opts;
  const now = opts.now ?? Date.now;
  const dispatcher = new Agent({ connect: { socketPath: opts.socketPath } });
  let token: { value: string; expiresAt: number } | undefined;
  let login: Promise<void> | undefined;
  let state: SignerState = "unchecked";
  let retry: NodeJS.Timeout | undefined;
  let closed = false;

  async function post(
    path: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    let res: Awaited<ReturnType<typeof request>>;
    let text: string;
    try {
      // The host names nothing: the socket is the address.
      res = await request(`http://openbao${path}`, {
        method: "POST",
        dispatcher,
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.body.text();
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new SignerError(
          "timeout",
          `OpenBao didn't answer ${path} within ${REQUEST_TIMEOUT_MS} ms`,
        );
      // No socket (ENOENT), nobody listening (ECONNREFUSED), or the connection dropped.
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
      throw new SignerError("unreachable", `OpenBao can't be reached (${code})`, { cause: error });
    }
    if (res.statusCode === 200) return JSON.parse(text) as Record<string, unknown>;
    const said = `OpenBao answered ${res.statusCode} on ${path}: ${text.slice(0, 200)}`;
    if (res.statusCode === 503) throw new SignerError("sealed", said);
    if (res.statusCode === 403) throw new SignerError("denied", said);
    if (res.statusCode < 500) throw new SignerError("refused", said);
    throw new SignerError("error", said);
  }

  async function logIn(): Promise<void> {
    const answer = await post("/v1/auth/approle/login", {
      role_id: opts.roleId,
      secret_id: opts.secretId,
    });
    const auth = answer.auth as { client_token?: unknown; lease_duration?: unknown } | undefined;
    if (typeof auth?.client_token !== "string" || typeof auth.lease_duration !== "number")
      throw new SignerError("error", "OpenBao's login answer has no token or lease");
    token = { value: auth.client_token, expiresAt: now() + auth.lease_duration * 1000 };
  }

  /** A token with more than 5 minutes left; a login that fails fails the signature (0036 decision 11). */
  async function currentToken(): Promise<string> {
    if (token && token.expiresAt - now() > RELOGIN_MARGIN_MS) return token.value;
    // Signatures that need a login at once share it.
    login ??= logIn().finally(() => (login = undefined));
    await login;
    return token!.value;
  }

  /** OpenBao's signature of `hash`, checked against `address`. */
  async function signatureOf(hash: Buffer): Promise<Buffer> {
    const answer = await post(
      `/v1/transit/sign/${opts.key}`,
      { input: hash.toString("base64"), key_version: keyVersion },
      { "X-Vault-Token": await currentToken() },
    );
    const prefix = `vault:v${keyVersion}:`;
    const signature = (answer.data as { signature?: unknown } | undefined)?.signature;
    if (typeof signature !== "string" || !signature.startsWith(prefix))
      throw new SignerError("error", `OpenBao's answer has no ${prefix} signature`);
    const bytes = Buffer.from(signature.slice(prefix.length), "base64");
    if (!Keypair.fromPublicKey(address).verify(hash, bytes))
      throw new SignerError(
        "address_mismatch",
        `OpenBao signed with a key other than ${address}'s`,
      );
    return bytes;
  }

  function failed(step: "sign" | "check", error: unknown): void {
    const reason = error instanceof SignerError ? error.reason : "error";
    metrics.increment("signer_failures_total", { reason, step });
    logger.warn("signer_failed", { network, step, reason, error });
    state = "failed";
  }

  async function check(): Promise<void> {
    try {
      await signatureOf(CHECK_HASH);
    } catch (error) {
      failed("check", error);
      if (!closed) retry = setTimeout(check, opts.checkRetryMs ?? CHECK_RETRY_MS).unref();
      return;
    }
    state = "ok";
    logger.info("signer_checked", { network, address });
  }

  return {
    address,
    async signTransaction(xdr, { networkPassphrase }) {
      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
      let signature: Buffer;
      try {
        signature = await signatureOf(tx.hash());
      } catch (error) {
        failed("sign", error);
        throw error;
      }
      tx.addSignature(address, signature.toString("base64"));
      state = "ok";
      return { signedTxXdr: tx.toXDR(), signerAddress: address };
    },
    state: () => state,
    check,
    close() {
      closed = true;
      clearTimeout(retry);
    },
  };
}
