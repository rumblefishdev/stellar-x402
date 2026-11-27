import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@stellar-x402/config";
import { guardedFetch, type SellerLimits } from "@stellar-x402/seller-fetch";
import type { SorobanRpc } from "@stellar-x402/signer-pool";
import { parse } from "smol-toml";
import type { Logger } from "../logger.js";
import type { CurationStore } from "../ports/curation-store.js";
import { SELLER_USER_AGENT } from "./seller-check.js";

/** How long a finished check stands before a paid call checks the host again (0070). */
export const CURATION_RECHECK_MS = 6 * 60 * 60 * 1000;
/** The largest `stellar.toml` SEP-1 allows. */
export const STELLAR_TOML_BYTES = 100 * 1024;

/**
 * Whether a seller proves its `payTo` both ways (SEP-1): the host's `stellar.toml` lists it in
 * `ACCOUNTS`, and the account's `home_domain` is the host. One way alone proves nothing: anyone
 * can list any account, and any account can name any domain. Domain names compare without case
 * (RFC 4343). Throws on a file that is not TOML.
 */
export function provesPayTo(
  toml: string,
  homeDomain: string | undefined,
  host: string,
  payTo: string,
): boolean {
  const accounts = parse(toml).ACCOUNTS;
  if (!Array.isArray(accounts) || !accounts.every((account) => typeof account === "string")) {
    return false;
  }
  return accounts.includes(payTo) && homeDomain?.toLowerCase() === host.toLowerCase();
}

export interface CurationDeps {
  store: CurationStore;
  rpc: Pick<SorobanRpc, "getLedgerEntries">;
  /** The facilitator's network: the only one whose accounts its RPC reads. */
  network: StellarNetwork;
  logger: Logger;
  /** The seller checks' limits; the body cap is SEP-1's. */
  limits: SellerLimits;
  /** The app clock, ms. */
  now?: () => number;
}

/**
 * Checks a seller's `stellar.toml` proof on a paid call (0070), at most once per 6 h per host and
 * account. A check that fails (no answer, no file, not TOML, the RPC) leaves the listing without
 * the proof until one passes, logged, and keeps the last finished check's time, so the next paid
 * call checks again. Never throws.
 */
export function createCuration({
  store,
  rpc,
  network,
  logger,
  limits,
  now = Date.now,
}: CurationDeps) {
  async function refresh(keyNetwork: StellarNetwork, resourceUrl: string, payTo: string) {
    if (keyNetwork !== network) return;
    // A contract account (`C…`) has no home_domain, so it is never curated (0070).
    if (!StrKey.isValidEd25519PublicKey(payTo)) return;
    const url = new URL(resourceUrl);
    const key = { network, host: url.hostname, payTo };
    let checkedAt: number | null = null;
    try {
      const stored = await store.get(key);
      checkedAt = stored?.checkedAt ?? null;
      if (checkedAt !== null && now() - checkedAt < CURATION_RECHECK_MS) return;
      const started = now();
      // From the resource's own origin: none of the 1,292 Stellar listings in CDP's catalog names
      // a port (measured 2026-11-27), so for them it is SEP-1's `https://<domain>`.
      const toml = await readToml(`${url.origin}/.well-known/stellar.toml`);
      const homeDomain = await readHomeDomain(payTo);
      const curated = provesPayTo(toml, homeDomain, key.host, payTo);
      await store.put({ ...key, curated, checkedAt: started });
    } catch (error) {
      logger.warn("curation_check_failed", { ...key, reason: String(error) });
      try {
        await store.put({ ...key, curated: false, checkedAt });
      } catch (putError) {
        logger.warn("curation_store_failed", { ...key, error: putError });
      }
    }
  }

  async function readToml(tomlUrl: string): Promise<string> {
    const fetch = guardedFetch(
      { ...limits, maxResponseBytes: STELLAR_TOML_BYTES },
      AbortSignal.timeout(limits.timeoutMs),
    );
    const response = await fetch(tomlUrl, { headers: { "user-agent": SELLER_USER_AGENT } });
    if (response.status !== 200) throw new Error(`stellar.toml answered ${response.status}`);
    return await response.text();
  }

  async function readHomeDomain(payTo: string): Promise<string | undefined> {
    const accountKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(payTo).xdrPublicKey() }),
    );
    const { entries } = await rpc.getLedgerEntries(accountKey);
    const [entry] = entries;
    if (!entry) return undefined;
    return entry.val.account().homeDomain().toString();
  }

  return { refresh };
}
