import type { StellarNetwork } from "@stellar-x402/config";
import type pg from "pg";
import type { CurationKey, CurationRecord, CurationStore } from "../ports/curation-store.js";

interface CurationRow {
  network: StellarNetwork;
  host: string;
  pay_to: string;
  curated: boolean;
  /** int8 comes back as a string. */
  checked_at: string | null;
}

/** The `stellar.toml` proofs (0070) in `catalog_curation`. */
export function createPostgresCurationStore(pool: pg.Pool): CurationStore {
  return {
    async get(key: CurationKey): Promise<CurationRecord | undefined> {
      const { rows } = await pool.query<CurationRow>(
        `SELECT network, host, pay_to, curated, checked_at FROM catalog_curation
          WHERE network = $1 AND host = $2 AND pay_to = $3`,
        [key.network, key.host, key.payTo],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        network: row.network,
        host: row.host,
        payTo: row.pay_to,
        curated: row.curated,
        checkedAt: row.checked_at === null ? null : Number(row.checked_at),
      };
    },

    async put(record: CurationRecord): Promise<void> {
      await pool.query(
        `INSERT INTO catalog_curation (network, host, pay_to, curated, checked_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (network, host, pay_to)
         DO UPDATE SET curated = EXCLUDED.curated, checked_at = EXCLUDED.checked_at`,
        [record.network, record.host, record.payTo, record.curated, record.checkedAt],
      );
    },
  };
}
