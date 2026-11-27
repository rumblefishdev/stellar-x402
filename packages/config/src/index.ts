/** CAIP-2 identifiers of the Stellar networks the facilitator serves. */
export const STELLAR_NETWORKS = {
  testnet: "stellar:testnet",
  pubnet: "stellar:pubnet",
} as const;

export type StellarNetwork = (typeof STELLAR_NETWORKS)[keyof typeof STELLAR_NETWORKS];

export function isStellarNetwork(value: string): value is StellarNetwork {
  return Object.values<string>(STELLAR_NETWORKS).includes(value);
}

/**
 * The model search embeds with (ADR 0014), pinned by its revision. The search model's image
 * fetches its files at this revision, and the facilitator compares each vector's model with
 * `SEARCH_MODEL_ID`, so a vector of another model is embedded again.
 */
export const SEARCH_MODEL_REPO = "ibm-granite/granite-embedding-30m-english";
export const SEARCH_MODEL_REVISION = "9b5b096411652ec1189c68fcfb90d0a82c5b45af";
export const SEARCH_MODEL_ID = `${SEARCH_MODEL_REPO}@${SEARCH_MODEL_REVISION}`;
