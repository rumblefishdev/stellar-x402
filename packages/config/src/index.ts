/** CAIP-2 identifiers of the Stellar networks the facilitator serves. */
export const STELLAR_NETWORKS = {
  testnet: "stellar:testnet",
  pubnet: "stellar:pubnet",
} as const;

export type StellarNetwork = (typeof STELLAR_NETWORKS)[keyof typeof STELLAR_NETWORKS];

export function isStellarNetwork(value: string): value is StellarNetwork {
  return Object.values<string>(STELLAR_NETWORKS).includes(value);
}
