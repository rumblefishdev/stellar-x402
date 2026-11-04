// What the tests build from: envs/production.json as committed.
import { createRequire } from "node:module";
import type { EnvironmentConfig } from "../src/lib/config.js";

const require = createRequire(import.meta.url);

export const production = (): EnvironmentConfig =>
  structuredClone(require("../envs/production.json") as EnvironmentConfig);
