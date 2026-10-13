import express, { type Express } from "express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

export interface SellerConfig {
  /** Stellar account that receives the payments. */
  payTo: string;
  /** Facilitator that verifies and settles them, e.g. the public x402.org one on testnet. */
  facilitatorUrl: string;
}

/**
 * A paid weather API on Stellar testnet: `GET /weather?city=` costs 0.001 USDC and is described for
 * the Bazaar, so a facilitator that catalogs on settle lists it after the first payment.
 */
export function createApp({ payTo, facilitatorUrl }: SellerConfig): Express {
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
    .register("stellar:testnet", new ExactStellarScheme())
    .registerExtension(bazaarResourceServerExtension);

  const app = express();
  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          accepts: { scheme: "exact", price: "$0.001", network: "stellar:testnet", payTo },
          description: "Current temperature for a city",
          mimeType: "application/json",
          extensions: declareDiscoveryExtension({
            input: { city: "Warsaw" },
            inputSchema: { properties: { city: { type: "string" } }, required: ["city"] },
            output: { example: { city: "Warsaw", tempC: 14 } },
          }),
        },
      },
      resourceServer,
    ),
  );
  app.get("/weather", (req, res) => {
    // The payment is verified before this runs and settled only after it answers; an error
    // status cancels the settlement, so a request without a city is refused and costs nothing.
    const city = req.query.city;
    if (typeof city !== "string" || city === "") {
      res.status(400).json({ error: "city is required" });
      return;
    }
    // A fixed answer: the example shows the payment, not a weather service.
    res.json({ city, tempC: 14 });
  });
  return app;
}
