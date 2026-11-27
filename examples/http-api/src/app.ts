import express, { type Express } from "express";
import {
  createFacilitatorConfig,
  readCatalogAnswer,
  readVerifyRefusal,
} from "@stellar-x402/sdk/seller";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

export interface SellerConfig {
  /** Stellar account that receives the payments. */
  payTo: string;
  /** Facilitator that verifies and settles them; this project's by default. */
  facilitatorUrl?: string;
  /** The facilitator's API key, sent on /verify and /settle; pubnet requires one, testnet none. */
  apiKey?: string;
  /**
   * Where the catalog's answer after each settlement, and the reason for each refused payment, are
   * written; the console by default.
   */
  log?: (line: string) => void;
}

/**
 * A paid weather API on Stellar testnet: `GET /weather?city=` costs 0.001 USDC and is described for
 * the Bazaar, so a facilitator that catalogs on settle lists it after the first payment.
 */
export function createApp({
  payTo,
  facilitatorUrl,
  apiKey,
  log = console.log,
}: SellerConfig): Express {
  const facilitator = new HTTPFacilitatorClient(
    createFacilitatorConfig({ url: facilitatorUrl, apiKey }),
  );
  const resourceServer = new x402ResourceServer(facilitator)
    .register("stellar:testnet", new ExactStellarScheme())
    .registerExtension(bazaarResourceServerExtension);
  // The facilitator says with each settlement whether it took the route's listing: a refused one
  // is a payment that settled for a route no buyer will find in the Bazaar.
  resourceServer.onAfterSettle(async ({ result }) => {
    const answer = readCatalogAnswer(result);
    if (answer.status === "processing") log("Bazaar: the listing was taken for cataloging");
    if (answer.status === "rejected") log(`Bazaar: the listing was refused (${answer.reason})`);
  });
  // The facilitator says why it refused a payment, but upstream's middleware tells the buyer the
  // reason alone and logs nothing. A refusal the seller must fix, such as a `payTo` that can't
  // receive USDC, refuses every buyer until it is fixed.
  resourceServer.onAfterVerify(async ({ result }) => {
    const refusal = readVerifyRefusal(result);
    if (refusal.status === "none") return;
    const why = refusal.message ? `${refusal.reason}: ${refusal.message}` : refusal.reason;
    log(
      refusal.sellerMustAct
        ? `Payment refused, fix this on your side (${why})`
        : `Payment refused (${why})`,
    );
  });

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
