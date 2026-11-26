/**
 * The search model (ADR 0014), which turns a listing's or a query's text into a vector of the
 * facilitator's model (`SEARCH_MODEL_ID`). Rejects when the model can't be used, or is another:
 * search then ranks by words alone.
 */
export interface Embedder {
  /** A query's text is read only up to 256 tokens, a listing's up to the model's 512 (ADR 0014). */
  embed(text: string, kind: "listing" | "query"): Promise<number[]>;
}
