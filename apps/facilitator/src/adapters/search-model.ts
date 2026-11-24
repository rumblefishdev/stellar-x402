import { z } from "zod";
import type { Embedder } from "../ports/embedder.js";

/** The model's vector size (ADR 0014: granite-embedding-30m-english, 384 dimensions). */
const DIMS = 384;

/** What the search model container answers to `POST /embed` (`apps/search-model`). */
const ANSWER = z.object({
  model: z.string(),
  vector: z.array(z.number().finite()).length(DIMS),
});

/**
 * The search model container (ADR 0014), reached over the environment's internal network. One
 * deadline covers the whole call, the answer's body included, so a container that stops half way
 * through an answer fails like one that never answers. Every answer but a 200 with a model and a
 * vector of the model's size rejects.
 */
export function createSearchModelClient(opts: { url: string; timeoutMs: number }): Embedder {
  return {
    async embed(text) {
      const response = await fetch(`${opts.url}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const body = await response.text();
      if (response.status !== 200)
        throw new Error(`the search model answered ${response.status}: ${body.slice(0, 200)}`);
      return ANSWER.parse(JSON.parse(body));
    },
  };
}
