import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const { payTo, facilitatorUrl, port } = loadConfig(process.env);

createApp({ payTo, facilitatorUrl }).listen(port, (error?: Error) => {
  // Express hands a failed start (such as a port in use) to this callback, not to a throw.
  if (error) throw error;
  console.log(`Paid weather API on http://localhost:${port}/weather?city=Warsaw, paying ${payTo}`);
});
