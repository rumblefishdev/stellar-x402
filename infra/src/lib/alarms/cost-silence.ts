// G-alarm-list, "Cost, silence and delivery". The delivery test is `make fire-test`, not an alarm.
import type { MetricName } from "@stellar-x402/metrics-catalog";
import type { EnvironmentConfig } from "../config.js";
import { names } from "../names.js";
import type { AlarmFactory } from "./factory.js";

/** The six facilitator gauges `gauges-silent` watches, by id in its expression (decision 28). */
const GAUGES = {
  oldest: "settlement_oldest_open_seconds",
  queued: "pool_queued",
  quarantined: "pool_quarantined",
  fallback: "rpc_on_fallback",
  stalled: "rpc_stalled_seconds",
  balance: "balance_reading_age_seconds",
} as const satisfies Record<string, MetricName>;

/**
 * 0089's gauge, watched too once `channel-held` is on: that alarm keeps its state without data like
 * the others, so a silent gauge would leave it quiet (decision 28).
 */
const HELD = { held: "channel_longest_hold_seconds" } as const satisfies Record<string, MetricName>;

export function addCostSilenceAlarms(f: AlarmFactory, c: EnvironmentConfig): void {
  const n = names(c.envName);
  const t = c.thresholds;
  const gauges: Record<string, MetricName> = {
    ...GAUGES,
    ...(c.alarmGroups.channelHeld && HELD),
  };

  if (t.logVolumeBytesPerHour !== null)
    for (const [qualifier, group] of [
      ["app", n.appLogGroup],
      ["metrics", n.metricsLogGroup],
    ] as const)
      f.level("log-volume", {
        group: "logVolume",
        qualifier,
        signal: { aws: "AWS/Logs", metric: "IncomingBytes", dims: { LogGroupName: group } },
        statistic: "Sum",
        periodMinutes: 60,
        periods: 1,
        comparison: ">",
        threshold: t.logVolumeBytesPerHour,
        description: {
          what: `${group} took over ${t.logVolumeBytesPerHour} bytes in an hour: a flood of lines, on the bill and on the server's disk.`,
          next: "Find the line that repeats with Logs Insights (stats count() by msg), and its cause.",
          noData: "Keeps its state; telemetry-silent covers a stopped agent.",
        },
      });

  for (const [base, metric, kind] of [
    ["emf-validation", "EMFValidationErrors", "rejected"],
    ["emf-parsing", "EMFParsingErrors", "could not parse"],
  ] as const)
    f.event(base, {
      group: "telemetry",
      signal: { aws: "AWS/Logs", metric, dims: { LogGroupName: n.metricsLogGroup } },
      description: {
        what: `CloudWatch ${kind} an EMF line in ${n.metricsLogGroup}, so its metrics are gone: Event and Count alarms on them read OK, and Level ones keep their last state.`,
        next: "Find the line with Logs Insights in that group around the time; a writer or catalog change is the usual cause.",
        noData: "Written only when a line fails, so no data means none failed.",
      },
    });

  f.silence("telemetry-silent", {
    group: "host",
    signal: { catalog: "mem_used_percent" },
    description: {
      what: "No memory reading from the server's CloudWatch agent for 15 minutes: the agent, its Roles Anywhere credentials or the server's way out is down, so no log or metric line arrives either.",
      next: "On the server: systemctl status amazon-cloudwatch-agent and the credential helper's unit, then the certificate's expiry.",
      noData: "Breaching: silence is what this alarm is for.",
    },
  });

  f.silence("probe-silent", {
    group: "host",
    signal: { catalog: "host_probe_heartbeat" },
    description: {
      what: "No heartbeat from the host probe for 15 minutes, so every host alarm is blind: OpenBao, WAL, backups, the certificate.",
      next: "On the server: the x402-host-probe timer and its journal; if telemetry-silent fires too, the agent is the fault.",
      noData: "Breaching: silence is what this alarm is for.",
    },
  });

  for (const network of c.networks) {
    const listed = {
      catalog: "settlement_sweeps_total",
      dims: { network, outcome: "listed" },
    } as const;

    f.silence("facilitator-silent", {
      group: "facilitator",
      network,
      signal: listed,
      description: {
        what: `No sweep line from the facilitator on ${network} for 15 minutes, though it writes one every minute: the process is down, or its lines don't reach CloudWatch. It fires beside uptime when the process is down.`,
        next: `Check uptime first; then x402@${c.envName} on the server and telemetry-silent for the agent.`,
        noData: "Breaching: silence is what this alarm is for.",
      },
    });

    // 1 when any gauge sent no point in the period while the sweeps did (decision 28).
    const filled = Object.keys(gauges)
      .map((id) => `FILL(${id}, 0)`)
      .join(", ");
    f.level("gauges-silent", {
      group: "facilitator",
      network,
      signal: {
        expression: `(MIN([${filled}]) < 1) * (FILL(sweeps, 0) >= 1)`,
        using: {
          ...Object.fromEntries(
            Object.entries(gauges).map(([id, name]) => [id, { catalog: name, dims: { network } }]),
          ),
          sweeps: listed,
        },
      },
      statistic: "SampleCount",
      periodMinutes: 5,
      periods: 3,
      comparison: ">=",
      threshold: 1,
      missing: "notBreaching",
      description: {
        what: `A facilitator gauge on ${network} sent no point for 15 minutes while the sweeps did: its read keeps throwing, and its own alarm keeps its last state. Gauges: ${Object.values(gauges).join(", ")}.`,
        next: "Find the gauge with no recent data in x402-facilitator in the metrics console, then the error in the app logs.",
        noData:
          "With the process down the expression has no value or 0, and facilitator-silent fires instead.",
      },
    });
  }
}
