import { createApp } from "./app.js";

const payTo = process.env.SELLER_ADDRESS;
if (!payTo)
  throw new Error("Set SELLER_ADDRESS to the Stellar testnet account that receives payments.");
const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://www.x402.org/facilitator";
const port = Number(process.env.PORT ?? 4021);

createApp({ payTo, facilitatorUrl }).listen(port, () => {
  console.log(`Paid weather API on http://localhost:${port}/weather?city=Warsaw, paying ${payTo}`);
});
