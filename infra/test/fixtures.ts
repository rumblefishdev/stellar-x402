// What the tests build from: envs/production.json as committed.
import { createRequire } from "node:module";
import type { EnvironmentConfig } from "../src/lib/config.js";

const require = createRequire(import.meta.url);

export const production = (): EnvironmentConfig =>
  structuredClone(require("../envs/production.json") as EnvironmentConfig);

export type Resource = { Type: string; Properties: Record<string, unknown> };
export type TemplateJson = {
  Resources: Record<string, Resource>;
  Outputs?: Record<string, Record<string, unknown>>;
  Parameters?: Record<string, unknown>;
};

export const ofType = (t: TemplateJson, type: string): Resource[] =>
  Object.values(t.Resources).filter((r) => r.Type === type);
