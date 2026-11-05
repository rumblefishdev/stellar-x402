// The environment's config (`envs/<env>.json`), typed and checked before any construct exists, as
// in the explorer's and the Prices API's `validateConfig`: every error at once, then one throw.
// Thresholds live here; names, namespaces and dimensions live in @stellar-x402/metrics-catalog.
import { isStellarNetwork, type StellarNetwork } from "@stellar-x402/config";
import { isDimValue } from "@stellar-x402/metrics-catalog";

/**
 * An alarm group is created whole or not at all (0027 decision 26): a group goes on once every
 * series its alarms read has data (`make check-series`), and no alarm exists without its actions.
 */
export const ALARM_GROUPS = [
  /**
   * `uptime`: the probe's `ready` (this repo's Uptime stack). Off until the probe has published
   * for a while: with missing data breaching, an alarm made before that pages at once (decision 37).
   */
  "uptime",
  /** The EMF error alarms on the metrics log group. */
  "telemetry",
  /** Every `x402-facilitator` alarm but `channel-held`; their lines reach CloudWatch with #113. */
  "facilitator",
  /** `channel-held`, once 0089 emits its gauge. */
  "channelHeld",
  /**
   * The host probe's alarms, `facilitator-failed` from x402@'s stop hook, and the agent's
   * `telemetry-silent` and `audit-disk` (#113).
   */
  "host",
  /** `wal-failing`, `wal-stale` and `backup-age`, once pgBackRest runs (0026; decision 40). */
  "backups",
  /** `snapshot-age`, once OpenBao's daily snapshot runs (0026; decision 40). */
  "snapshots",
  /** `disk`, once its threshold is read against the first numbers. */
  "disk",
  /** `memory`, after a week of data. */
  "memory",
  /** `log-volume`, once its threshold is measured. */
  "logVolume",
  /** The off-server check's alarms (`x402-watch` and its `AWS/Lambda` health), with #115. */
  "watch",
] as const;
export type AlarmGroup = (typeof ALARM_GROUPS)[number];

export interface Thresholds {
  /** `uptime`: failing minutes in a row, above a deploy's worst downtime (ADR 0011). */
  readonly uptimeFailingMinutes: number;
  readonly rpcStalledSeconds: number;
  /** Tied to the balance floor's `maxStaleMs` at its default interval (0027 decision 17). */
  readonly balanceStaleSeconds: number;
  readonly pendingSeconds: number;
  readonly channelHeldSeconds: number;
  /** `http-500`: answers in 5 minutes. */
  readonly http500Count: number;
  /** `pool-health`: `sequence-resync` events in 5 minutes. */
  readonly sequenceResyncCount: number;
  /** `balance-low` and `balance-critical`, in stroops (0027 decision 7). */
  readonly balanceLowStroops: number;
  readonly balanceCriticalStroops: number;
  readonly auditDiskUsedPercent: number;
  readonly walStaleSeconds: number;
  readonly backupAgeSeconds: number;
  readonly snapshotAgeSeconds: number;
  readonly certificateDaysLeft: number;
  /** `credentials-stale`: the agent's credentials file, written hourly by the signing helper. */
  readonly credentialsAgeSeconds: number;
  /** Measured before the group goes on; `null` until then. */
  readonly diskUsedPercent: number | null;
  readonly memoryUsedPercent: number | null;
  readonly logVolumeBytesPerHour: number | null;
}

export interface EnvironmentConfig {
  /** `production` for `x402@production`. */
  readonly envName: string;
  readonly awsRegion: string;
  /** The networks the facilitator serves: each network-scoped alarm is made once per entry. */
  readonly networks: readonly StellarNetwork[];
  readonly logging: {
    /** The CN the logging role's trust policy accepts, the agent's certificate's. */
    readonly certificateCn: string;
    /** The trust anchor's CA certificate, a path relative to `infra/`. */
    readonly trustAnchorCertificate: string;
    /** SSM parameter holding the server's public IPv4, resolved at deploy. */
    readonly serverIpSsmParam: string;
    /** The longest session the profile and the role allow (#113's helper asks for 12). */
    readonly sessionHours: number;
  };
  readonly uptime: {
    /** The `/health` URL the probe reads, through Cloudflare. */
    readonly url: string;
  };
  /**
   * The fee account per network, `G...`: the balance alarms name it (ADR 0013). Public, since
   * `/supported` lists it as the signer; checked here so a typo can't send a top-up elsewhere.
   */
  readonly feeAccounts: Readonly<Partial<Record<StellarNetwork, string>>>;
  readonly slack: {
    /** SSM parameter names (plain String): the IDs stay out of this public repo. */
    readonly workspaceIdSsmParam: string;
    readonly channelIdSsmParam: string;
  };
  readonly host: {
    /** The `path` values (mount points) of `disk_used_percent` the `disk` alarm reads (#113). */
    readonly diskMounts: readonly string[];
    /** OpenBao's audit volume, `audit-disk`'s series. */
    readonly auditDiskMount: string | null;
  };
  readonly alarmGroups: Readonly<Record<AlarmGroup, boolean>>;
  readonly thresholds: Thresholds;
}

const NULLABLE: ReadonlySet<keyof Thresholds> = new Set([
  "diskUsedPercent",
  "memoryUsedPercent",
  "logVolumeBytesPerHour",
]);
const PERCENT: ReadonlySet<keyof Thresholds> = new Set([
  "auditDiskUsedPercent",
  "diskUsedPercent",
  "memoryUsedPercent",
]);
const INTEGER: ReadonlySet<keyof Thresholds> = new Set([
  "uptimeFailingMinutes",
  "http500Count",
  "sequenceResyncCount",
  "balanceLowStroops",
  "balanceCriticalStroops",
]);
const THRESHOLD_KEYS: readonly (keyof Thresholds)[] = [
  "uptimeFailingMinutes",
  "rpcStalledSeconds",
  "balanceStaleSeconds",
  "pendingSeconds",
  "channelHeldSeconds",
  "http500Count",
  "sequenceResyncCount",
  "balanceLowStroops",
  "balanceCriticalStroops",
  "auditDiskUsedPercent",
  "walStaleSeconds",
  "backupAgeSeconds",
  "snapshotAgeSeconds",
  "certificateDaysLeft",
  "credentialsAgeSeconds",
  "diskUsedPercent",
  "memoryUsedPercent",
  "logVolumeBytesPerHour",
];

/** Roles Anywhere's longest session: a profile's `durationSeconds` stops at 43,200. */
const MAX_SESSION_HOURS = 12;
/** An alarm's evaluation range must fit in a day (CloudWatch, checked at deploy, not synth). */
const MAX_ALARM_MINUTES = 24 * 60;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** StrKey's version byte for an ed25519 public key, the `G` of an account address. */
const ACCOUNT_VERSION = 6 << 3;

/**
 * A Stellar account address with a valid checksum: 56 base32 characters that decode to the version
 * byte, 32 bytes of key and a little-endian CRC16-XModem over the first 33 (SEP-23). No SDK, so
 * infra stays two dependencies from the catalog.
 */
export function isAccountAddress(v: unknown): v is string {
  if (typeof v !== "string" || !/^G[A-Z2-7]{55}$/.test(v)) return false;
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of v) {
    acc = (acc << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 35 || bytes[0] !== ACCOUNT_VERSION) return false;
  let crc = 0;
  for (const b of bytes.slice(0, 33)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return bytes[33] === (crc & 0xff) && bytes[34] === crc >> 8;
}

const isSsmName = (v: unknown): boolean =>
  typeof v === "string" && /^\/[\x21-\x7e]+$/.test(v) && v.length <= 2048;

/** Throws with every problem in `config`, or returns it typed. */
export function validateConfig(config: EnvironmentConfig): EnvironmentConfig {
  const errors: string[] = [];
  const c = config as unknown as Record<string, unknown>;

  if (typeof config.envName !== "string" || !/^[a-z][a-z0-9-]*$/.test(config.envName))
    errors.push(`envName must be lowercase letters, digits and '-', got: ${String(c["envName"])}`);
  if (typeof config.awsRegion !== "string" || !/^[a-z]{2}-[a-z]+-\d$/.test(config.awsRegion))
    errors.push(`awsRegion must be a region like eu-central-1, got: ${String(c["awsRegion"])}`);

  if (!Array.isArray(config.networks) || config.networks.length === 0) {
    errors.push("networks must list at least one CAIP-2 network");
  } else {
    for (const n of config.networks as readonly unknown[])
      if (typeof n !== "string" || !isStellarNetwork(n))
        errors.push(`networks: ${String(n)} is not one of STELLAR_NETWORKS`);
    if (new Set(config.networks).size !== config.networks.length)
      errors.push("networks lists a network twice");
  }

  const logging = config.logging ?? ({} as EnvironmentConfig["logging"]);
  if (
    typeof logging.certificateCn !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(logging.certificateCn)
  )
    errors.push(
      `logging.certificateCn must be lowercase letters, digits and '-', got: ${String(logging.certificateCn)}`,
    );
  if (
    typeof logging.trustAnchorCertificate !== "string" ||
    !/^[\w./-]+\.crt$/.test(logging.trustAnchorCertificate) ||
    logging.trustAnchorCertificate.includes("..")
  )
    errors.push("logging.trustAnchorCertificate must be a .crt path inside infra/");
  if (!isSsmName(logging.serverIpSsmParam))
    errors.push("logging.serverIpSsmParam must be an absolute SSM parameter name");
  if (
    !Number.isInteger(logging.sessionHours) ||
    logging.sessionHours < 1 ||
    logging.sessionHours > MAX_SESSION_HOURS
  )
    errors.push(`logging.sessionHours must be an integer from 1 to ${MAX_SESSION_HOURS}`);

  let url: URL | undefined;
  try {
    url = new URL(config.uptime?.url);
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== "https:" || !url.hostname.includes("."))
    errors.push(`uptime.url must be an https:// URL, got: ${String(config.uptime?.url)}`);

  const fee = (config.feeAccounts ?? {}) as Record<string, unknown>;
  for (const n of Array.isArray(config.networks) ? config.networks : [])
    if (!isAccountAddress(fee[n]))
      errors.push(
        `feeAccounts.${n} must be the fee account's G... address, got: ${String(fee[n])}`,
      );
  for (const n of Object.keys(fee))
    if (!(config.networks ?? []).includes(n as StellarNetwork))
      errors.push(`feeAccounts.${n} is not in networks`);

  if (!isSsmName(config.slack?.workspaceIdSsmParam) || !isSsmName(config.slack?.channelIdSsmParam))
    errors.push(
      "slack must be { workspaceIdSsmParam, channelIdSsmParam } with absolute SSM parameter names",
    );

  const host = config.host ?? ({} as EnvironmentConfig["host"]);
  if (!Array.isArray(host.diskMounts))
    errors.push("host.diskMounts must be a list of the catalog's disk paths");
  else
    for (const m of host.diskMounts as readonly unknown[])
      if (typeof m !== "string" || !isDimValue(m))
        errors.push(`host.diskMounts: ${String(m)} is no CloudWatch dimension value`);
  if (
    host.auditDiskMount !== null &&
    (typeof host.auditDiskMount !== "string" || !isDimValue(host.auditDiskMount))
  )
    errors.push("host.auditDiskMount must be null or a CloudWatch dimension value");

  const groups = (config.alarmGroups ?? {}) as Record<string, unknown>;
  for (const g of ALARM_GROUPS)
    if (typeof groups[g] !== "boolean") errors.push(`alarmGroups.${g} must be true or false`);
  for (const g of Object.keys(groups))
    if (!(ALARM_GROUPS as readonly string[]).includes(g))
      errors.push(`alarmGroups.${g} is not a group`);

  const t = (config.thresholds ?? {}) as unknown as Record<string, unknown>;
  for (const key of THRESHOLD_KEYS) {
    const v = t[key];
    if (v === null && NULLABLE.has(key)) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      errors.push(
        `thresholds.${key} must be a positive number${NULLABLE.has(key) ? " or null" : ""}`,
      );
      continue;
    }
    if (PERCENT.has(key) && v > 100) errors.push(`thresholds.${key} is a percentage, got: ${v}`);
    if (INTEGER.has(key) && !Number.isInteger(v))
      errors.push(`thresholds.${key} must be an integer, got: ${v}`);
  }
  for (const key of Object.keys(t))
    if (!(THRESHOLD_KEYS as readonly string[]).includes(key))
      errors.push(`thresholds.${key} is not a threshold`);
  const th = config.thresholds;
  if (th && th.uptimeFailingMinutes > MAX_ALARM_MINUTES)
    errors.push(`thresholds.uptimeFailingMinutes must fit in a day (${MAX_ALARM_MINUTES})`);
  if (th && th.balanceCriticalStroops >= th.balanceLowStroops)
    errors.push("thresholds.balanceCriticalStroops must be below balanceLowStroops");

  // A group whose threshold or series isn't known yet can't go on (decision 26).
  const on = (g: AlarmGroup) => groups[g] === true;
  if (on("disk") && (th?.diskUsedPercent == null || !host.diskMounts?.length))
    errors.push("alarmGroups.disk needs thresholds.diskUsedPercent and host.diskMounts");
  if (on("memory") && th?.memoryUsedPercent == null)
    errors.push("alarmGroups.memory needs thresholds.memoryUsedPercent");
  if (on("logVolume") && th?.logVolumeBytesPerHour == null)
    errors.push("alarmGroups.logVolume needs thresholds.logVolumeBytesPerHour");
  if (on("host") && host.auditDiskMount == null)
    errors.push("alarmGroups.host needs host.auditDiskMount for audit-disk");

  if (errors.length > 0)
    throw new Error(
      `Invalid infra config (envs/${String(c["envName"])}.json):\n- ${errors.join("\n- ")}`,
    );
  return config;
}
