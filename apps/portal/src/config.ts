import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_PLANS, parseAccountPlans, type AccountPlan } from "@stellar-x402/api-keys";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The secret the hub signs its tokens with; `previous` stays while the secret rotates. */
export interface HubSecret {
  current: Buffer;
  previous?: Buffer;
}

export interface Config {
  port: number;
  /** The hub's token secret (decision 23). Never logged. */
  hubSecret: HubSecret;
  /** Seals the copy of each key the portal can show again. Never logged. */
  keyEncryptionKey: Buffer;
  /** Never logged: it holds the password. */
  databaseUrl: string;
  /** How old a Discord account must be to get a key. */
  minAccountAgeMinutes: number;
  /** Where a caller's address is read from: the socket, or Cloudflare's header behind its tunnel. */
  clientIp: "socket" | "cloudflare";
  /** The plans by name, as the facilitator reads them (0107): the quota the hub shows. */
  accountPlans: Map<string, AccountPlan>;
  logLevel: LogLevel;
}

/** Names every invalid setting; never echoes a value, so a secret can't leak into logs. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join("; ")}`);
  }
}

/**
 * Settings a deploy passes as a file, `<NAME>_FILE`, so the value never sits in a container's
 * environment, which `docker inspect` shows (ADR 0011). A local run sets them plainly.
 */
const FILE_SETTINGS = ["DATABASE_URL", "KEY_ENCRYPTION_KEY", "HUB_TOKEN_SECRET"] as const;

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
// Standard padded base64 of 32 bytes: the last character carries 4 bits and 2 are padding, so
// only the characters whose low 2 bits are zero may come before the `=` (as in Prices' rule).
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

type Env = Record<string, string | undefined>;

/** Parses `env`, or throws a {@link ConfigError} that names each bad setting. */
export function parseConfig(env: Env): Config {
  const problems: string[] = [];
  const values = readFileSettings(env, problems);
  const get = (name: string): string | undefined => values[name]?.trim() || undefined;
  const required = (name: string): string | undefined => {
    const value = get(name);
    if (value === undefined) problems.push(`${name} is required`);
    return value;
  };

  /** Bytes given as base64 or base64url, e.g. from `openssl rand -base64 32`. */
  const bytes = (name: string, check: (length: number) => boolean, what: string) => {
    const value = required(name);
    if (value === undefined) return undefined;
    const decoded = BASE64.test(value) ? Buffer.from(value, "base64") : undefined;
    if (decoded === undefined || !check(decoded.length)) {
      problems.push(`${name} must be ${what} in base64`);
      return undefined;
    }
    return decoded;
  };

  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = get(name);
    if (value === undefined) return fallback;
    const parsed = /^[0-9]+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return parsed;
  };

  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = get(name);
    if (value === undefined) return fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      problems.push(`${name} must be one of ${allowed.join(", ")}`);
      return fallback;
    }
    return value as T;
  };

  const keyEncryptionKey = bytes("KEY_ENCRYPTION_KEY", (length) => length === 32, "32 bytes");
  const hubText = required("HUB_TOKEN_SECRET");
  const hubSecret = hubText === undefined ? undefined : parseHubSecret(hubText);
  if (hubText !== undefined && hubSecret === undefined) {
    problems.push(
      'HUB_TOKEN_SECRET must be JSON {"current", "previous"?}, each standard padded base64 of 32 bytes',
    );
  }
  // One leak must not open both the hub's calls and the stored keys.
  if (
    keyEncryptionKey &&
    hubSecret &&
    (hubSecret.current.equals(keyEncryptionKey) || hubSecret.previous?.equals(keyEncryptionKey))
  ) {
    problems.push("HUB_TOKEN_SECRET and KEY_ENCRYPTION_KEY must differ");
  }

  let accountPlans: Map<string, AccountPlan> | undefined;
  try {
    accountPlans = parseAccountPlans(get("ACCOUNT_PLANS") ?? DEFAULT_ACCOUNT_PLANS);
  } catch {
    problems.push(
      "ACCOUNT_PLANS must be <name>:<payments a month>:<fee stroops per 24 h>, comma-separated, with a free plan",
    );
  }

  const config = {
    port: integer("PORT", 4022, 1, 65_535),
    hubSecret,
    keyEncryptionKey,
    databaseUrl: required("DATABASE_URL"),
    minAccountAgeMinutes: integer("MIN_ACCOUNT_AGE_MINUTES", 5, 0, 525_600),
    clientIp: oneOf("CLIENT_IP", ["socket", "cloudflare"] as const, "socket"),
    accountPlans,
    logLevel: oneOf("LOG_LEVEL", LOG_LEVELS, "info"),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  // Every `undefined` above came with a problem, so none is left.
  return config as Config;
}

/** `env` with each of {@link FILE_SETTINGS} read from its `_FILE`, where one is set. */
function readFileSettings(env: Env, problems: string[]): Env {
  const read = { ...env };
  for (const name of FILE_SETTINGS) {
    const path = env[`${name}_FILE`]?.trim();
    if (!path) continue;
    // Refused, so a leftover plain value can't look like the one in use.
    if (env[name]?.trim()) {
      problems.push(`${name} and ${name}_FILE must not both be set`);
      continue;
    }
    try {
      read[name] = readFileSync(path, "utf8");
    } catch (error) {
      problems.push(`${name}_FILE can't be read (${(error as NodeJS.ErrnoException).code})`);
      continue;
    }
    if (!read[name]?.trim()) problems.push(`${name}_FILE is empty`);
  }
  return read;
}

/**
 * The hub's secret: JSON `{"current", "previous"?}`, each standard padded base64 of 32 bytes.
 * `undefined` for anything else, so the caller can name the setting without echoing the value.
 */
export function parseHubSecret(text: string): HubSecret | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const fields = json as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "current" && key !== "previous")) return undefined;
  const decode = (value: unknown): Buffer | undefined =>
    typeof value === "string" && BASE64_32_BYTES.test(value)
      ? Buffer.from(value, "base64")
      : undefined;
  const current = decode(fields.current);
  if (current === undefined) return undefined;
  if (fields.previous === undefined) return { current };
  const previous = decode(fields.previous);
  return previous === undefined ? undefined : { current, previous };
}
