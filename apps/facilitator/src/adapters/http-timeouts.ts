import { Agent, Pool } from "undici";

/**
 * The process's HTTP dispatcher: a request ends after `defaultMs` without headers or body data,
 * and a request to an origin in `shorter` after that origin's own bound.
 */
export function boundedAgent(defaultMs: number, shorter: Readonly<Record<string, number>>): Agent {
  return new Agent({
    headersTimeout: defaultMs,
    bodyTimeout: defaultMs,
    factory: (origin, opts) => {
      const ms = shorter[new URL(String(origin)).origin] ?? defaultMs;
      return new Pool(origin, { ...opts, headersTimeout: ms, bodyTimeout: ms });
    },
  });
}
