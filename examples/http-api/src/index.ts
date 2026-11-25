import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const { port, ...config } = loadConfig(process.env);

const server = createApp(config).listen(port, (error?: Error) => {
  // Express hands a failed start (such as a port in use) to this callback, not to a throw.
  if (error) throw error;
  // The bound port, not the configured one: PORT=0 leaves the choice to the system.
  const bound = (server.address() as AddressInfo).port;
  console.log(
    `Paid weather API on http://localhost:${bound}/weather?city=Warsaw, paying ${config.payTo}`,
  );
});
