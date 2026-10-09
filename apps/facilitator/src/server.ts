import { ConfigError } from "./config.js";
import { jsonLogger } from "./logger.js";
import { main } from "./main.js";

// The process entry point. `main.ts` only exports, so importing it never starts a server, and no
// "is this the main module" check can miss when the file is reached through a symlink.
const started = main();

// Node as PID 1 in a container ignores SIGTERM unless it has a handler. Registered before the
// server listens, so a signal during startup closes it once it's up. Closing stops new
// connections and lets open requests finish; the drain and the lease release come in 0025.
const stop = () => void started.then((server) => server.close()).catch(() => {});
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

started.catch((error: unknown) => {
  // A ConfigError names each bad setting and never echoes a value.
  const fields = error instanceof ConfigError ? { problems: error.problems } : { error };
  jsonLogger("error").error("startup_failed", fields);
  process.exitCode = 1;
});
