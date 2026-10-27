import { ConfigError } from "./config.js";
import { jsonLogger } from "./logger.js";
import { main } from "./main.js";

// The process entry point. `main.ts` only exports, so importing it never starts a server, and no
// "is this the main module" check can miss when the file is reached through a symlink.
const started = main();

// Node as PID 1 in a container ignores SIGTERM unless it has a handler. Registered before the
// server listens, so a signal during startup closes it once it's up. Closing stops new
// connections; the drain and the lease release follow (0025). Then the process exits: past the
// drain's deadline, confirmations still under way would otherwise keep it alive until Docker's
// SIGKILL (decision 11).
const stop = () =>
  void started
    .then((server) => server.close())
    .catch(() => (process.exitCode = 1))
    .finally(() => process.exit());
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

started.catch((error: unknown) => {
  // A ConfigError names each bad setting and never echoes a value. `main()` logged any other
  // error itself, with the RPC endpoints named by its config.
  if (error instanceof ConfigError) {
    jsonLogger("error").error("startup_failed", { problems: error.problems });
  }
  process.exitCode = 1;
});
