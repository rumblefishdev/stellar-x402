import type { Network, SupportedResponse } from "@x402/core/types";

/**
 * The `GET /supported` answer (AD-13): `exact` on the network, with fees sponsored, which the
 * Stellar client requires; the Bazaar extension; and the facilitator key as the only signer. The
 * channels sign through that key, so they are never listed (ADR 0005). `upto` isn't listed until
 * its `/settle` exists.
 */
export function supportedResponse(network: Network, facilitator: string): SupportedResponse {
  return {
    kinds: [{ x402Version: 2, scheme: "exact", network, extra: { areFeesSponsored: true } }],
    extensions: ["bazaar"],
    signers: { "stellar:*": [facilitator] },
  };
}
