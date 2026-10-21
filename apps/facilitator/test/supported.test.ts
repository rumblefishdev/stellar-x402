import { Keypair } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import { BAZAAR } from "@x402/extensions";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { describe, expect, it } from "vitest";
import { supportedResponse } from "../src/http/supported.js";

describe("supportedResponse", () => {
  it("is what upstream's facilitator answers for exact Stellar with the bazaar extension", () => {
    // Upstream's own `/supported` (its example facilitators serve `getSupported()`), on the one
    // key AD-12 allows: a pinned-version bump that changes its shape fails here.
    const network = "stellar:testnet";
    const signer = createEd25519Signer(Keypair.random().secret(), network);
    const upstream = new x402Facilitator()
      .register(network, new ExactStellarScheme([signer]))
      .registerExtension(BAZAAR)
      .getSupported();
    expect(supportedResponse(network, signer.address)).toEqual(upstream);
  });

  it("lists exact on the network, the facilitator key as its only signer, and nothing else", () => {
    const facilitator = Keypair.random().publicKey();
    expect(supportedResponse("stellar:testnet", facilitator)).toEqual({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "stellar:testnet",
          extra: { areFeesSponsored: true },
        },
      ],
      extensions: ["bazaar"],
      signers: { "stellar:*": [facilitator] },
    });
  });
});
