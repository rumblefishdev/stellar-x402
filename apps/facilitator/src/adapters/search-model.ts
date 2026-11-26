import { z } from "zod";
import type { Embedder } from "../ports/embedder.js";

/** The model's vector size (ADR 0014: granite-embedding-30m-english, 384 dimensions). */
const DIMS = 384;

/** What the search model container answers to `POST /embed` (`apps/search-model`). */
const ANSWER = z.object({
  model: z.string(),
  vector: z.array(z.number()).length(DIMS),
});

/**
 * The search model container (ADR 0014), reached over the environment's internal network. One
 * deadline covers the whole call, the answer's body included, so a container that stops half way
 * through an answer fails like one that never answers. Every answer but a 200 with a model and a
 * vector of the model's size rejects, and so does an answer of another model than `model`: its
 * vectors would not compare with the cards', and the cards' model would never match the one the
 * facilitator embeds for.
 */
export function createSearchModelClient(opts: {
  url: string;
  timeoutMs: number;
  model: string;
}): Embedder {
  return {
    async embed(text, kind) {
      const response = await fetch(`${opts.url}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, kind }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const body = await response.text();
      if (response.status !== 200)
        throw new Error(`the search model answered ${response.status}: ${body.slice(0, 200)}`);
      const answer = ANSWER.parse(JSON.parse(body));
      if (answer.model !== opts.model)
        throw new Error(`the search model answered for ${answer.model}, not ${opts.model}`);
      return answer;
    },
  };
}

/** True when the search model container answers its health check: it has loaded the model. */
export async function searchModelReady(opts: { url: string; timeoutMs: number }): Promise<boolean> {
  try {
    const response = await fetch(`${opts.url}/health`, {
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    // Not listening yet, or not answering: the caller asks again.
    return false;
  }
}
