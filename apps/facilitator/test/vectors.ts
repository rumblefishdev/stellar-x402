import type pg from "pg";
import { postgresStores } from "../src/adapters/postgres.js";
import type { CatalogKey, Embedder } from "../src/ports/index.js";

/** The model's vector size (ADR 0014: granite-embedding-30m-english, 384 dimensions). */
export const DIMS = 384;

/**
 * A unit vector whose cosine similarity to {@link QUERY_VECTOR} is `cos`: both lie in the plane of
 * the first two axes, so the cosine is known exactly.
 */
export function unitVector(cos: number): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  vector[0] = cos;
  vector[1] = Math.sqrt(1 - cos * cos);
  return vector;
}

/** The query's vector in the tests: the first axis. */
export const QUERY_VECTOR = unitVector(1);

/** A card's four search fields, as `catalog_search` stores them. */
export interface CardFields {
  name: string;
  tags: string;
  description: string;
  parameters: string;
}

/** The meaning text of a card (0120 point B): its fields joined with "\n", empty ones skipped. */
export function meaningText(card: CardFields): string {
  return [card.name, card.tags, card.description, card.parameters]
    .filter((field) => field !== "")
    .join("\n");
}

/** pgvector's text form of a vector. */
export const vectorLiteral = (vector: number[]) => `[${vector.join(",")}]`;

/**
 * Stores `vector` of `model` on the card of the listing at `key`, through the search card store as
 * the vector pass does (0120 point A), so the tests hold no copy of its write. Needs the `vector`
 * extension, which ADR 0014 creates in `public`: the tests' connections search their own schema
 * only.
 */
export async function setVector(
  pool: pg.Pool,
  key: CatalogKey,
  model: string,
  vector: number[],
): Promise<void> {
  const { searchCards } = postgresStores(pool, {}, model);
  const card = await searchCards.card(key);
  if (card === undefined) throw new Error(`no search card for ${JSON.stringify(key)}`);
  if (!(await searchCards.writeVector(card, vector)))
    throw new Error(`the search card for ${JSON.stringify(key)} changed while it was written`);
}

/** Every card with its listing's URL, in catalog order, the vector as numbers. */
export async function readCards(pool: pg.Pool) {
  const { rows } = await pool.query<
    CardFields & {
      resource_url: string;
      model: string | null;
      embedding: string | null;
    }
  >(
    // `model` is the database's: empty while the vector is of an older text (ADR 0014).
    `SELECT c.resource_url, s.name, s.tags, s.description, s.parameters, s.model,
            CASE WHEN s.model IS NOT NULL THEN s.embedding::text END AS embedding
       FROM catalog c JOIN catalog_search s USING (seq) ORDER BY c.seq`,
  );
  return rows.map((row) => ({
    ...row,
    embedding: row.embedding === null ? null : (JSON.parse(row.embedding) as number[]),
  }));
}

/** True when two vectors agree to float4's precision, as pgvector stores them. */
export function sameVector(actual: number[] | null, expected: number[]): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  return actual.every((value, i) => Math.abs(value - expected[i]!) < 1e-6);
}

/**
 * A search model that is down, for tests that don't search by meaning: `/discovery/search` then
 * ranks by words alone, as it does while the model fails (ADR 0014).
 */
export const noSearchModel: Embedder = {
  embed: async () => {
    throw new Error("no search model in this test");
  },
};

/** The vectors for a cataloger whose tests don't search by meaning: each write asks, nothing is stored. */
export const noVectors = { listed: async () => {} };
