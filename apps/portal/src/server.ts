import { ConfigError } from "./config.js";
import { jsonLogger } from "./logger.js";
import { main } from "./main.js";

// The process entry point. `main.ts` only exports, so importing it never starts a server.
const started = main();

// Node as PID 1 in a container ignores SIGTERM unless it has a handler. Registered before the
// server listens, so a signal during startup closes it once it's up.
const stop = () =>
  void started
    .then(
      (server) =>
        server.close().catch((error: unknown) => {
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
  // A ConfigError names each bad setting and never echoes a value. `main()` logged any other.
  if (error instanceof ConfigError) {
    jsonLogger("error").error("startup_failed", { problems: error.problems });
  }
  process.exitCode = 1;
});
