import { ConfigError } from "./config.js";
import { jsonLogger } from "./logger.js";
import { main } from "./main.js";

// The process entry point. `main.ts` only exports, so importing it never starts a server, and no
// "is this the main module" check can miss when the file is reached through a symlink.
main().catch((error: unknown) => {
  // A ConfigError names each bad setting and never echoes a value.
  const fields = error instanceof ConfigError ? { problems: error.problems } : { error };
  jsonLogger("error").error("startup_failed", fields);
  process.exitCode = 1;
});
