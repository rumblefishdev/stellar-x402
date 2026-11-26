import type { AddressInfo } from "node:net";
import { checkTrustline } from "@stellar-x402/sdk/seller";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const { payTo, facilitatorUrl, apiKey, rpcUrl, port } = loadConfig(process.env);

// A payTo without the USDC trustline would refuse every payment at settlement, after the buyer
// signed: checked before the first one, without signing anything.
const trustline = await checkTrustline({
  account: payTo,
  asset: USDC_TESTNET_ADDRESS,
  network: "stellar:testnet",
  rpcUrl,
});
if (trustline.status === "missing") {
  console.error(
    `SELLER_ADDRESS ${payTo} can't receive testnet USDC (${trustline.reason}): add the trustline ` +
      `to ${trustline.classicAsset} from that account, then start again.`,
  );
  process.exit(1);
}
if (trustline.status === "unknown") {
  console.warn(`Could not check SELLER_ADDRESS's USDC trustline (${trustline.reason}); starting.`);
}

const server = createApp({ payTo, facilitatorUrl, apiKey }).listen(port, (error?: Error) => {
  // Express hands a failed start (such as a port in use) to this callback, not to a throw.
  if (error) throw error;
  // The bound port, not the configured one: PORT=0 leaves the choice to the system.
  const bound = (server.address() as AddressInfo).port;
  console.log(`Paid weather API on http://localhost:${bound}/weather?city=Warsaw, paying ${payTo}`);
});
