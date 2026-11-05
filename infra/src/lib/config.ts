// The environment's config (`envs/<env>.json`), typed and checked with zod before any construct
// exists, as in the explorer's and the Prices API's `validateConfig`: every error at once, then one
// throw.
// Thresholds live here; names, namespaces and dimensions live in @stellar-x402/metrics-catalog.
import { isStellarNetwork, type StellarNetwork } from "@stellar-x402/config";
import { isDimValue } from "@stellar-x402/metrics-catalog";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

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
  /**
   * `log-volume`, a coarse ceiling on each log group's bytes, on with `host` (#113): EMF lines can
   * create custom metrics in any namespace, so it is the only bound on what a flood costs.
   */
  "logVolume",
  /** The off-server check's alarms (`x402-watch` and its `AWS/Lambda` health), with #115. */
  "watch",
] as const;
export type AlarmGroup = (typeof ALARM_GROUPS)[number];

export interface Thresholds {
  /** `uptime`: failing minutes in a row, above a deploy's worst downtime (ADR 0011). */
  readonly uptimeFailingMinutes: number;
  /**
   * `uptime-flapping`: failing minutes in the window that fire it though none of them run for
   * `uptimeFailingMinutes`, so a crash loop that comes up between restarts is seen.
   */
  readonly uptimeFlapFailingMinutes: number;
  readonly uptimeFlapWindowMinutes: number;
  readonly rpcStalledSeconds: number;
  /** Tied to the balance floor's `maxStaleMs` at its default interval (0027 decision 17). */
  readonly balanceStaleSeconds: number;
  readonly pendingSeconds: number;
  readonly channelHeldSeconds: number;
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

/** Roles Anywhere's longest session: a profile's `durationSeconds` stops at 43,200. */
const MAX_SESSION_HOURS = 12;
/** An alarm's evaluation range must fit in a day (CloudWatch, checked at deploy, not synth). */
const MAX_ALARM_MINUTES = 24 * 60;

/** A Stellar account address (`G...`) whose checksum holds (SEP-23), as the facilitator checks. */
export const isAccountAddress = (v: unknown): v is string =>
  typeof v === "string" && StrKey.isValidEd25519PublicKey(v);

const SSM = "must be an absolute SSM parameter name";
const ssmName = z
  .string({ message: SSM })
  .max(2048, SSM)
  .regex(/^\/[\x21-\x7e]+$/, SSM);
const dimValue = z
  .string({ message: "must be a CloudWatch dimension value" })
  .refine(isDimValue, "is no CloudWatch dimension value");

const POSITIVE = "must be a positive number";
const positive = z.number({ message: POSITIVE }).finite(POSITIVE).positive(POSITIVE);
const count = positive.int("must be an integer");
const percent = positive.max(100, "is a percentage, at most 100");

const thresholds = z
  .object({
    uptimeFailingMinutes: count.max(MAX_ALARM_MINUTES, `must fit in a day (${MAX_ALARM_MINUTES})`),
    uptimeFlapFailingMinutes: count,
    uptimeFlapWindowMinutes: count.max(
      MAX_ALARM_MINUTES,
      `must fit in a day (${MAX_ALARM_MINUTES})`,
    ),
    rpcStalledSeconds: positive,
    balanceStaleSeconds: positive,
    pendingSeconds: positive,
    channelHeldSeconds: positive,
    sequenceResyncCount: count,
    balanceLowStroops: count,
    balanceCriticalStroops: count,
    auditDiskUsedPercent: percent,
    walStaleSeconds: positive,
    backupAgeSeconds: positive,
    snapshotAgeSeconds: positive,
    certificateDaysLeft: positive,
    credentialsAgeSeconds: positive,
    // Measured before the group goes on; `null` until then.
    diskUsedPercent: percent.nullable(),
    memoryUsedPercent: percent.nullable(),
    logVolumeBytesPerHour: positive.nullable(),
  } satisfies Record<keyof Thresholds, z.ZodTypeAny>)
  .strict();

const LOWER = "must be lowercase letters, digits and '-'";
const REGION = "must be a region like eu-central-1";
const NETWORKS = "must list at least one CAIP-2 network";
const CRT = "must be a .crt path inside infra/";
const SESSION = `must be an integer from 1 to ${MAX_SESSION_HOURS}`;
const HTTPS = "must be an https:// URL";

const schema = z.object({
  envName: z.string({ message: LOWER }).regex(/^[a-z][a-z0-9-]*$/, LOWER),
  awsRegion: z.string({ message: REGION }).regex(/^[a-z]{2}-[a-z]+-\d$/, REGION),
  networks: z
    .array(z.custom<StellarNetwork>(isStellarNetwork, "is not one of STELLAR_NETWORKS"), {
      message: NETWORKS,
    })
    .min(1, NETWORKS)
    .refine((ns) => new Set(ns).size === ns.length, "lists a network twice"),
  logging: z.object({
    certificateCn: z.string({ message: LOWER }).regex(/^[a-z0-9][a-z0-9-]{0,63}$/, LOWER),
    trustAnchorCertificate: z
      .string({ message: CRT })
      .regex(/^[\w./-]+\.crt$/, CRT)
      .refine((p) => !p.includes(".."), CRT),
    serverIpSsmParam: ssmName,
    sessionHours: z
      .number({ message: SESSION })
      .int(SESSION)
      .min(1, SESSION)
      .max(MAX_SESSION_HOURS, SESSION),
  }),
  uptime: z.object({
    url: z.string({ message: HTTPS }).refine((u) => {
      try {
        const url = new URL(u);
        return url.protocol === "https:" && url.hostname.includes(".");
      } catch {
        return false;
      }
    }, HTTPS),
  }),
  // Each entry is checked against `networks` in crossChecks, where both are known.
  feeAccounts: z.record(z.string(), z.unknown(), { message: "must map networks to addresses" }),
  slack: z.object({ workspaceIdSsmParam: ssmName, channelIdSsmParam: ssmName }),
  host: z.object({
    diskMounts: z.array(dimValue, { message: "must be a list of the catalog's disk paths" }),
    auditDiskMount: dimValue.nullable(),
  }),
  alarmGroups: z
    .object(
      Object.fromEntries(
        ALARM_GROUPS.map((g) => [g, z.boolean({ message: "must be true or false" })]),
      ) as Record<AlarmGroup, z.ZodBoolean>,
    )
    .strict(),
  thresholds,
});

/** The checks across fields: each fee account, and a group whose threshold or series isn't known. */
function crossChecks(c: z.infer<typeof schema>, ctx: z.RefinementCtx): void {
  const fail = (path: string[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  for (const n of c.networks)
    if (!isAccountAddress(c.feeAccounts[n]))
      fail(
        ["feeAccounts", n],
        `must be the fee account's G... address, got: ${String(c.feeAccounts[n])}`,
      );
  for (const n of Object.keys(c.feeAccounts))
    if (!c.networks.includes(n as StellarNetwork)) fail(["feeAccounts", n], "is not in networks");

  const t = c.thresholds;
  // Below uptime's run, a plain outage would fire uptime-flapping first; at the window, never.
  if (
    t.uptimeFlapFailingMinutes <= t.uptimeFailingMinutes ||
    t.uptimeFlapFailingMinutes >= t.uptimeFlapWindowMinutes
  )
    fail(
      ["thresholds", "uptimeFlapFailingMinutes"],
      "must be above uptimeFailingMinutes and below uptimeFlapWindowMinutes",
    );
  if (t.balanceCriticalStroops >= t.balanceLowStroops)
    fail(["thresholds", "balanceCriticalStroops"], "must be below balanceLowStroops");
  // A group whose threshold or series isn't known yet can't go on (decision 26).
  const on = c.alarmGroups;
  if (on.disk && (t.diskUsedPercent === null || c.host.diskMounts.length === 0))
    fail(["alarmGroups", "disk"], "needs thresholds.diskUsedPercent and host.diskMounts");
  if (on.memory && t.memoryUsedPercent === null)
    fail(["alarmGroups", "memory"], "needs thresholds.memoryUsedPercent");
  if (on.logVolume && t.logVolumeBytesPerHour === null)
    fail(["alarmGroups", "logVolume"], "needs thresholds.logVolumeBytesPerHour");
  if (on.host && c.host.auditDiskMount === null)
    fail(["alarmGroups", "host"], "needs host.auditDiskMount for audit-disk");
  // The cost ceiling goes on with #113's lines (Karol's review of #114, point 6): an EMF line can
  // name any namespace and create custom metrics without limit, and only log-volume bounds it.
  if (on.host && !on.logVolume)
    fail(["alarmGroups", "host"], "needs alarmGroups.logVolume, the cost ceiling on our lines");
}

/** What an unknown key is, by the object it sits in. */
const UNKNOWN: Readonly<Record<string, string>> = {
  alarmGroups: "a group",
  thresholds: "a threshold",
};

function messages(error: z.ZodError): string[] {
  return error.issues.flatMap((i) => {
    const path = i.path.join(".");
    if (i.code === z.ZodIssueCode.unrecognized_keys)
      return i.keys.map((k) => `${path}.${k} is not ${UNKNOWN[path] ?? "a known key"}`);
    return [`${path} ${i.message}`];
  });
}

/**
 * Throws with every problem in `config`, or returns it typed. The checks across fields run once
 * every field has its type, so a config with a wrong type reports those first.
 */
export function validateConfig(config: EnvironmentConfig): EnvironmentConfig {
  const result = schema.superRefine(crossChecks).safeParse(config);
  if (!result.success) {
    const envName = (config as { envName?: unknown } | undefined)?.envName;
    throw new Error(
      `Invalid infra config (envs/${String(envName)}.json):\n- ${messages(result.error).join("\n- ")}`,
    );
  }
  return config;
}
