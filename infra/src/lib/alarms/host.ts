// G-alarm-list, "Host": the host probe's lines and the agent's memory and disk (#113), in
// `x402-host`. A failed check, or a job that never ran, writes a value past its threshold, so a
// broken check alarms rather than reading as healthy (decision 10).
import type { EnvironmentConfig } from "../config.js";
import type { AlarmFactory } from "./factory.js";

const PROBE_SILENT = "Keeps its state; probe-silent covers a stopped host probe.";
const AGENT_SILENT = "Keeps its state; telemetry-silent covers a stopped agent.";

/** `/` -> `root`, `/var/lib/docker` -> `var-lib-docker`: a mount as part of an alarm name. */
export function mountSlug(mount: string): string {
  const slug = mount
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "root" : slug;
}

export function addHostAlarms(f: AlarmFactory, c: EnvironmentConfig): void {
  const t = c.thresholds;
  const hours = (s: number) => `${Math.round(s / 3600)} hours`;

  if (t.diskUsedPercent !== null)
    for (const mount of c.host.diskMounts)
      f.level("disk", {
        group: "disk",
        qualifier: mountSlug(mount),
        signal: { catalog: "disk_used_percent", dims: { path: mount } },
        statistic: "Maximum",
        periodMinutes: 5,
        periods: 3,
        comparison: ">",
        threshold: t.diskUsedPercent,
        description: {
          what: `The server's ${mount} is over ${t.diskUsedPercent}% used for 15 minutes. It is shared with ClickHouse; our WAL, backups and logs are what we add to it. The Prices API watches the same host's ClickHouse volume as prices-${c.envName}-ch-disk-free.`,
          next: "Check du on the WAL archive, the pgBackRest repo, /var/log/x402 and Docker images; tell the ClickHouse project's owners if their data is what grew.",
          noData: AGENT_SILENT,
        },
      });

  if (t.memoryUsedPercent !== null)
    f.level("memory", {
      group: "memory",
      signal: { catalog: "mem_used_percent" },
      // Every sample of 15 minutes over the threshold: a lasting squeeze, not a merge's spike.
      statistic: "Minimum",
      periodMinutes: 5,
      periods: 3,
      comparison: ">",
      threshold: t.memoryUsedPercent,
      description: {
        what: `The server's memory has stayed over ${t.memoryUsedPercent}% used for 15 minutes. ClickHouse shares the machine, held to its own limit.`,
        next: "Check docker stats for our containers and ClickHouse's, and the OOM lines in the kernel log.",
        noData: AGENT_SILENT,
      },
    });

  if (c.host.auditDiskMount !== null)
    f.level("audit-disk", {
      group: "host",
      signal: { catalog: "disk_used_percent", dims: { path: c.host.auditDiskMount } },
      statistic: "Maximum",
      periodMinutes: 5,
      periods: 3,
      // "At 80%" (ADR 0013).
      comparison: ">=",
      threshold: t.auditDiskUsedPercent,
      description: {
        what: `OpenBao's audit volume ${c.host.auditDiskMount} is ${t.auditDiskUsedPercent}% used or more: when it fills, OpenBao refuses requests it can't audit, and signing stops (ADR 0013).`,
        next: "Check the audit log's rotation on the server and free the volume (docs/runbook.md, OpenBao).",
        noData: AGENT_SILENT,
      },
    });

  f.level("openbao-down", {
    group: "host",
    signal: { catalog: "openbao_up" },
    statistic: "Minimum",
    periodMinutes: 1,
    periods: 3,
    comparison: "<",
    threshold: 1,
    description: {
      what: "OpenBao has been down, sealed, or failing its check on its socket for 3 minutes: the facilitator can't sign, so settlement stops.",
      next: "Check x402-openbao.service and bao status on the socket; unseal or restart as in docs/runbook.md, OpenBao.",
      noData: PROBE_SILENT,
    },
  });

  // Groups of their own: the probe writes a value past the threshold for a job that never ran, so
  // in `host` they'd keep it off until pgBackRest and the snapshots exist (decision 40).
  f.level("wal-failing", {
    group: "backups",
    signal: { catalog: "wal_failing" },
    statistic: "Maximum",
    periodMinutes: 1,
    periods: 3,
    comparison: ">=",
    threshold: 1,
    description: {
      what: "Postgres WAL archiving is failing: last_failed_time is past last_archived_time, nothing was ever archived, or the check fails. WAL that isn't archived fills a disk ClickHouse shares, and never leaves the server.",
      next: "Read pg_stat_archiver and the pgBackRest log; check the repository's sub-account is reachable.",
      noData: PROBE_SILENT,
    },
  });

  f.level("wal-stale", {
    group: "backups",
    signal: { catalog: "wal_last_archived_age_seconds" },
    statistic: "Minimum",
    periodMinutes: 1,
    periods: 3,
    comparison: ">",
    threshold: t.walStaleSeconds,
    description: {
      what: `The last archived WAL segment is older than ${t.walStaleSeconds / 60} minutes: archiving is stuck, even without a failure.`,
      next: "Read pg_stat_archiver and the pgBackRest log, and check wal-failing.",
      noData: PROBE_SILENT,
    },
  });

  f.level("backup-age", {
    group: "backups",
    signal: { catalog: "backup_age_seconds" },
    statistic: "Minimum",
    periodMinutes: 1,
    periods: 3,
    comparison: ">",
    threshold: t.backupAgeSeconds,
    description: {
      what: `The last pgbackrest backup is older than ${hours(t.backupAgeSeconds)}, or there is none: the daily backup didn't run or failed.`,
      next: "Check the backup timer and its journal, then run a backup by hand.",
      noData: PROBE_SILENT,
    },
  });

  f.level("snapshot-age", {
    group: "snapshots",
    signal: { catalog: "snapshot_age_seconds" },
    statistic: "Minimum",
    periodMinutes: 1,
    periods: 3,
    comparison: ">",
    threshold: t.snapshotAgeSeconds,
    description: {
      what: `The last OpenBao snapshot is older than ${hours(t.snapshotAgeSeconds)}, or there is none: the daily snapshot didn't run or failed.`,
      next: "Check the snapshot timer and its journal, then take one by hand.",
      noData: PROBE_SILENT,
    },
  });

  f.level("certificate", {
    group: "host",
    signal: { catalog: "certificate_days_left" },
    statistic: "Maximum",
    periodMinutes: 60,
    periods: 1,
    comparison: "<",
    threshold: t.certificateDaysLeft,
    description: {
      what: `The Roles Anywhere certificate the agent ships logs with has under ${t.certificateDaysLeft} days left, or its check fails. When it expires, no log or metric line reaches CloudWatch.`,
      next: `Renew it: a CSR on the server for CN=${c.logging.certificateCn}, signed by the ClickHouse project's CA holder.`,
      noData: PROBE_SILENT,
    },
  });

  f.event("watchdog-restart", {
    group: "host",
    signal: { catalog: "watchdog_restarts_total" },
    description: {
      what: "The watchdog stopped an unhealthy facilitator and restarted its unit.",
      next: `Read the app log before the restart and journalctl -u x402-watchdog@${c.envName} (docs/runbook.md, The watchdog).`,
      noData: "Nothing restarted; a stopped watchdog leaves a hung facilitator to uptime.",
    },
  });
}
