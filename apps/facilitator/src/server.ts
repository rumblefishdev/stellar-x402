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
// SIGKILL (decision 11). `close()` is memoized, so a second signal joins the drain under way
// instead of falling to Node's default and killing the process before the lease is released.
const stop = () =>
  void started
    .then(
      (server) =>
        server.close().catch((error: unknown) => {
          // A fresh logger, as for `startup_failed`: it redacts every URL, an RPC URL included.
          jsonLogger("error").error("shutdown_failed", { error });
          process.exitCode = 1;
        }),
      // A failed start is logged below.
      () => (process.exitCode = 1),
    )
    .finally(() => process.exit());
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

started.catch((error: unknown) => {
  // A ConfigError names each bad setting and never echoes a value. `main()` logged any other
  // error itself, with the RPC endpoints named by its config.
  if (error instanceof ConfigError) {
    jsonLogger("error").error("startup_failed", { problems: error.problems });
  }
  process.exitCode = 1;
});
