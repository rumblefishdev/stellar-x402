import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { memoryStores } from "./adapters/memory.js";
import { createCataloger } from "./catalog/cataloger.js";
import { parseConfig } from "./config.js";
import { createApp, type AppDeps } from "./http/app.js";
import { jsonLogger } from "./logger.js";
import { memoryMetrics } from "./metrics.js";
import { noopHooks } from "./settlement/hooks.js";

export interface Started {
  port: number;
  close(): Promise<void>;
}

/** Starts the HTTP server on the graph `deps`. Tests call it with their own config and stores. */
export async function start(deps: AppDeps): Promise<Started> {
  const server = createApp(deps).listen(deps.config.port);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  deps.logger.info("listening", {
    port,
    network: deps.config.network,
    store: deps.config.store,
    channels: deps.config.channels.length,
  });
  return {
    port,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/**
 * The composition root (AD-1): the only module that reads `process.env`. It validates the config
 * once and builds every part from it.
 */
export async function main(env: Record<string, string | undefined> = process.env) {
  const config = parseConfig(env);
  const logger = jsonLogger(config.logLevel);
  // STORE=memory is the only option until the durable adapters land (0022).
  const stores = memoryStores();
  const metrics = memoryMetrics();
  const cataloger = createCataloger({ store: stores.catalog, logger, metrics });
  // 0024 adds its `beforeSubmit` and `onFinal` the same way.
  const hooks = {
    ...noopHooks,
    extensionResponses: cataloger.extensionResponses,
    onSuccess: cataloger.onSuccess,
  };
  return start({ config, logger, stores, hooks, metrics });
}
