import { Address, xdr } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar-x402/signer-pool";

export type AssetKind = "sac" | "wasm";
export type AssetTier = "known" | "other";

export interface AssetKinds {
  /** Whether the asset is a Stellar Asset Contract or a wasm token. */
  kind(asset: string): Promise<AssetKind>;
  /** Whether the asset is one of the known assets (budget tier). */
  tier(asset: string): AssetTier;
  /**
   * Whether the last {@link kind} answer for this asset was read with certainty: a known asset, or
   * one whose instance entry was read from the ledger. False for a `wasm` that an RPC error, a
   * timeout or a missing entry defaulted to, and for an asset never asked. A breaker that only a
   * wasm token may have (S-design §7) must open only on a confirmed kind: an error must not make
   * the policy treat a SAC as wasm and open a breaker a SAC can never have (0024).
   */
  confirmed(asset: string): boolean;
}

/** Past this many cached kinds the oldest is forgotten, so the map can't grow without bound. */
const CACHE_MAX_DEFAULT = 50_000;
/** A ledger read slower than this answers `wasm` (unconfirmed), so `/verify` and `/settle` aren't stalled. */
const READ_TIMEOUT_MS_DEFAULT = 5_000;

/**
 * Tells a SAC from a wasm token by the executable of the contract's instance entry. A known asset
 * is a SAC without a read. An answer read from the ledger is cached (bounded, oldest forgotten
 * first); an RPC error, a timeout or a missing entry answers `wasm` and is not cached, so the next
 * call asks again and {@link AssetKinds.confirmed} stays false until a read succeeds.
 */
export function createAssetKinds(deps: {
  rpc: Pick<SorobanRpc, "getLedgerEntries">;
  known: readonly string[];
  cacheMax?: number;
  readTimeoutMs?: number;
}): AssetKinds {
  const known = new Set(deps.known);
  const cacheMax = deps.cacheMax ?? CACHE_MAX_DEFAULT;
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS_DEFAULT;
  /** Insertion order, so the first key is the oldest cached read (a `Map` keeps it). */
  const cache = new Map<string, AssetKind>();

  function remember(asset: string, kind: AssetKind) {
    cache.delete(asset);
    cache.set(asset, kind);
    if (cache.size > cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  async function read(asset: string): Promise<AssetKind | undefined> {
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(asset).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    // A read that outruns the timeout answers `wasm` (unconfirmed) rather than stalling the route;
    // the underlying call is left to settle on its own. Never cached, so the next call asks again.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), readTimeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([deps.rpc.getLedgerEntries(ledgerKey), timeout]);
      if (result === undefined) return undefined;
      const entry = result.entries[0];
      if (entry === undefined) return undefined;
      const executable = entry.val.contractData().val().instance().executable();
      return executable.switch().name === "contractExecutableStellarAsset" ? "sac" : "wasm";
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async kind(asset) {
      if (known.has(asset)) return "sac";
      const cached = cache.get(asset);
      if (cached !== undefined) return cached;
      try {
        const kind = await read(asset);
        if (kind === undefined) return "wasm";
        remember(asset, kind);
        return kind;
      } catch {
        return "wasm";
      }
    },
    tier: (asset) => (known.has(asset) ? "known" : "other"),
    confirmed: (asset) => known.has(asset) || cache.has(asset),
  };
}
