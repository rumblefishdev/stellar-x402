import type { FacilitatorConfig } from "@x402/core/server";

/** This project's facilitator, the same name for testnet and pubnet. */
export const FACILITATOR_URL = "https://x402-facilitator.sorobanscan.com";

export interface FacilitatorOptions {
  /**
   * The API key from the portal, sent as `Authorization: Bearer` on `/verify` and `/settle` only.
   * Pubnet requires one; testnet takes none. Read it from where you keep secrets: this library
   * reads no environment variable.
   */
  apiKey?: string;
  /** Another facilitator, or a staging one; `FACILITATOR_URL` by default. */
  url?: string;
  /** Each request's time limit, in milliseconds; upstream's default (90 s) when left out. */
  timeoutMs?: number;
}

/**
 * Upstream's `FacilitatorConfig` for this project's facilitator, for
 * `new HTTPFacilitatorClient(...)`. An empty `apiKey` is the same as none.
 */
export function createFacilitatorConfig(options: FacilitatorOptions = {}): FacilitatorConfig {
  const { apiKey, url = FACILITATOR_URL, timeoutMs } = options;
  const config: FacilitatorConfig = { url };
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  if (apiKey) {
    // Only the two routes that take a key: `/supported` is public, and a key sent there would
    // only travel further.
    const headers = { Authorization: `Bearer ${apiKey}` };
    config.createAuthHeaders = async () => ({ verify: headers, settle: headers });
  }
  return config;
}
