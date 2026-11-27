import type { StellarNetwork } from "@stellar-x402/config";

/** Who a `stellar.toml` proof is about (0070): the resource host and the account it is paid to. */
export interface CurationKey {
  network: StellarNetwork;
  /** The resource URL's hostname, as the WHATWG URL parser writes it. */
  host: string;
  payTo: string;
}

export interface CurationRecord extends CurationKey {
  /** The host's `stellar.toml` lists `payTo`, and the account's `home_domain` is the host. */
  curated: boolean;
  /**
   * App clock ms of the last check that finished; `null` when none has. A failed check leaves it,
   * so the next paid call checks again (0070).
   */
  checkedAt: number | null;
}

/** The result of each host's `stellar.toml` proof (0070), one per network, host and `payTo`. */
export interface CurationStore {
  get(key: CurationKey): Promise<CurationRecord | undefined>;
  /** Inserts, or replaces the record of the same key. */
  put(record: CurationRecord): Promise<void>;
}
