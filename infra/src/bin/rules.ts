#!/usr/bin/env node
// Writes production's Prometheus rule file to stdout (`make rules`; lore 0139 step 6).
import { createRequire } from "node:module";
import type { EnvironmentConfig } from "../lib/config.js";
import { ruleFile } from "../lib/rules.js";

const require = createRequire(import.meta.url);
process.stdout.write(ruleFile(require("../../envs/production.json") as EnvironmentConfig));
