// The Alarms template against its two sources of truth: the catalog (names, namespaces,
// dimensions: the spine's AD-1) and the alarm list (shapes, statistics, periods, missing data:
// lore 0027 notes/G-alarm-list.md, read from the note itself so the two can't drift apart).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type MetricName, seriesDims } from "@stellar-x402/metrics-catalog";
import { describe, expect, test } from "vitest";
import { AWS_METRICS, type AlarmRecord } from "../src/lib/alarms/factory.js";
import { INFRA_ROOT } from "../src/lib/names.js";
import { allOn, ofType, production, type Resource, synth, type TemplateJson } from "./fixtures.js";

const all = synth(allOn());
const records: readonly AlarmRecord[] = all.x.alarms.alarms.records;
const alarms = ofType(all.alarms, "AWS::CloudWatch::Alarm");
const byName = new Map(alarms.map((a) => [a.Properties["AlarmName"] as string, a.Properties]));
const topicRef = {
  Ref: Object.keys(all.alarms.Resources).find(
    (k) => all.alarms.Resources[k]?.Type === "AWS::SNS::Topic",
  ),
};

type Dim = { Name: string; Value: string };
type MetricStat = {
  Metric: { Namespace: string; MetricName: string; Dimensions?: Dim[] };
  Period: number;
  Stat: string;
};
type MathMetric = { Id: string; Expression?: string; MetricStat?: MetricStat };

/** Every metric an alarm reads, from the template alone. */
function metricsOf(
  p: Record<string, unknown>,
): { namespace: string; name: string; dims: Record<string, string> }[] {
  const dims = (d?: Dim[]) => Object.fromEntries((d ?? []).map((x) => [x.Name, x.Value]));
  if (typeof p["MetricName"] === "string")
    return [
      {
        namespace: p["Namespace"] as string,
        name: p["MetricName"],
        dims: dims(p["Dimensions"] as Dim[]),
      },
    ];
  return (p["Metrics"] as MathMetric[])
    .filter((m) => m.MetricStat)
    .map((m) => ({
      namespace: m.MetricStat!.Metric.Namespace,
      name: m.MetricStat!.Metric.MetricName,
      dims: dims(m.MetricStat!.Metric.Dimensions),
    }));
}
const statOf = (p: Record<string, unknown>) =>
  (p["Statistic"] as string | undefined) ??
  (p["Metrics"] as MathMetric[]).find((m) => m.MetricStat)?.MetricStat?.Stat;
const periodOf = (p: Record<string, unknown>) =>
  (p["Period"] as number | undefined) ??
  (p["Metrics"] as MathMetric[]).find((m) => m.MetricStat)?.MetricStat?.Period;

describe("every alarm reads a series the catalog declares (AD-1)", () => {
  test.each(alarms.map((a) => [a.Properties["AlarmName"] as string, a]))("%s", (_, a: Resource) => {
    for (const m of metricsOf(a.Properties)) {
      if (m.namespace.startsWith("AWS/")) {
        const known = AWS_METRICS[m.namespace as keyof typeof AWS_METRICS];
        expect(known, m.namespace).toBeDefined();
        expect(known.metrics as readonly string[]).toContain(m.name);
        expect(Object.keys(m.dims)).toEqual([known.dim]);
        continue;
      }
      expect(seriesDims(m.name as MetricName, m.dims)).toEqual({
        ok: true,
        namespace: m.namespace,
      });
    }
  });
});

describe("the Alarms template", () => {
  test("has every alarm of the list once per network, 82 with two networks", () => {
    expect(alarms).toHaveLength(82);
    expect(new Set(byName.keys()).size).toBe(alarms.length);
  });

  test("never sets Unit, which would leave an alarm with no data on a mismatch", () => {
    expect(JSON.stringify(alarms)).not.toMatch(/"Unit"/);
  });

  test("is printable ASCII throughout, so cdk diff reads it back as written", () => {
    for (const t of all.all) expect(JSON.stringify(t)).toMatch(/^[\x20-\x7e]*$/);
  });

  test("gives each alarm a description under 1,024 characters naming the runbook", () => {
    for (const a of alarms) {
      const d = a.Properties["AlarmDescription"] as string;
      expect(d.length).toBeLessThanOrEqual(1024);
      expect(d).toMatch(/ No data: .+ Runbook: docs\/monitoring\.md, [a-z0-9-]+\.$/);
    }
  });

  test("never makes an alarm without its actions (decision 26)", () => {
    for (const a of alarms) {
      expect(a.Properties["ActionsEnabled"]).toBe(true);
      expect(a.Properties["AlarmActions"]).toEqual([topicRef]);
    }
  });

  test("sends an OK only for the Level and Silence shapes, saying how they re-arm", () => {
    for (const r of records) {
      const p = byName.get(r.alarmName);
      const rearms = (p?.["AlarmDescription"] as string).includes(" OK once ");
      if (r.shape === "level" || r.shape === "silence") {
        expect(p?.["OKActions"], r.alarmName).toEqual([topicRef]);
        expect(rearms, r.alarmName).toBe(true);
      } else {
        expect(p?.["OKActions"], r.alarmName).toBeUndefined();
        expect(rearms, r.alarmName).toBe(false);
      }
    }
  });

  test("fits every evaluation range in a day, which CloudWatch checks only at deploy", () => {
    for (const a of alarms)
      expect(
        (periodOf(a.Properties) ?? 0) * (a.Properties["EvaluationPeriods"] as number),
      ).toBeLessThanOrEqual(86_400);
  });

  test("has no CPU alarm (decision 20) and no metric-issue alarm (decision 22)", () => {
    expect(JSON.stringify(alarms)).not.toMatch(/cpu/i);
    expect([...byName.keys()].some((n) => n.includes("metric-issue"))).toBe(false);
  });

  test("names the fee account and the top-up step in each balance alarm (ADR 0013)", () => {
    const balance = records.filter((r) => ["balance-low", "balance-critical"].includes(r.base));
    expect(balance).toHaveLength(4);
    for (const r of balance) {
      const d = byName.get(r.alarmName)!["AlarmDescription"] as string;
      expect(d, r.alarmName).toContain(allOn().feeAccounts[r.network!]!);
      expect(d, r.alarmName).toContain("docs/runbook.md, Topping up the fee account");
    }
  });

  test("keeps the backup and snapshot alarms out of host, apart from it and each other (40)", () => {
    const bases = (g: string) =>
      [...new Set(records.filter((r) => r.group === g).map((r) => r.base))].sort();
    expect(bases("backups")).toEqual(["backup-age", "wal-failing", "wal-stale"]);
    expect(bases("snapshots")).toEqual(["snapshot-age"]);
    expect(bases("host")).toEqual([
      "audit-disk",
      "certificate",
      "credentials-stale",
      "facilitator-failed",
      "openbao-down",
      "probe-silent",
      "telemetry-silent",
      "watchdog-restart",
    ]);
  });

  test("keeps the balance alarms and the check's health apart from theft and secret reads (68)", () => {
    const bases = (g: string) =>
      [...new Set(records.filter((r) => r.group === g).map((r) => r.base))].sort();
    expect(bases("watch")).toEqual([
      "balance-critical",
      "balance-low",
      "watch-errors",
      "watch-no-invocations",
    ]);
    expect(bases("watchSecurity")).toEqual([
      "account-effects",
      "account-state",
      "backup-secret-read",
    ]);
  });

  test("makes a network-scoped alarm once per configured network", () => {
    const perBase = new Map<string, string[]>();
    for (const r of records)
      if (r.network) perBase.set(r.base, [...(perBase.get(r.base) ?? []), r.network]);
    // breaker-opened is one alarm per breaker kind on each network.
    const per = (base: string) => (base === "breaker-opened" ? 3 : 1);
    for (const [base, nets] of perBase)
      expect(nets.sort(), base).toEqual(
        ["stellar:pubnet", "stellar:testnet"].flatMap((n) => Array<string>(per(base)).fill(n)),
      );
  });

  test("makes breaker-opened once per breaker kind, each on its own series", () => {
    const testnet = records.filter(
      (r) => r.base === "breaker-opened" && r.network === "stellar:testnet",
    );
    expect(testnet.map((r) => r.series[0]?.dims["breaker"])).toEqual(["payer", "pay_to", "asset"]);
    expect(testnet.map((r) => r.alarmName)).toEqual([
      "x402-production-breaker-opened-testnet-payer",
      "x402-production-breaker-opened-testnet-pay-to",
      "x402-production-breaker-opened-testnet-asset",
    ]);
  });
});

describe("the path to Slack", () => {
  test("has no topic policy, which would replace the default one alarms publish through", () => {
    for (const t of all.all) expect(ofType(t, "AWS::SNS::TopicPolicy")).toEqual([]);
    expect(ofType(all.alarms, "AWS::SNS::Topic")[0]?.Properties).not.toHaveProperty(
      "KmsMasterKeyId",
    );
  });

  test("logs Chatbot's errors and keeps its channel read-only", () => {
    const slack = ofType(all.alarms, "AWS::Chatbot::SlackChannelConfiguration");
    expect(slack).toHaveLength(1);
    const readOnly = {
      "Fn::Join": [
        "",
        ["arn:", { Ref: "AWS::Partition" }, ":iam::aws:policy/CloudWatchReadOnlyAccess"],
      ],
    };
    expect(slack[0]?.Properties).toMatchObject({
      ConfigurationName: "x402-production-alarms",
      LoggingLevel: "ERROR",
      GuardrailPolicies: [readOnly],
      SnsTopicArns: [topicRef],
    });
    expect(ofType(all.alarms, "AWS::IAM::Role")[0]?.Properties["ManagedPolicyArns"]).toEqual([
      readOnly,
    ]);
  });

  test("reads the Slack IDs from SSM at deploy, not from the repo", () => {
    const defaults = Object.values(
      all.alarms.Parameters as Record<string, { Default: string }>,
    ).map((p) => p.Default);
    expect(defaults).toEqual(
      expect.arrayContaining([
        "/x402/production/slack-workspace-id",
        "/x402/production/slack-channel-id",
      ]),
    );
  });
});

test("no stack imports from another (decision 27)", () => {
  for (const t of all.all) {
    expect(JSON.stringify(t)).not.toContain("Fn::ImportValue");
    for (const o of Object.values(t.Outputs ?? {})) expect(o).not.toHaveProperty("Export");
  }
});

test("production as committed makes only the groups that are on", () => {
  const prod = synth(production());
  expect(prod.x.alarms.alarms.records.map((r) => r.alarmName).sort()).toEqual([
    "x402-production-emf-parsing",
    "x402-production-emf-validation",
  ]);
});

// ---- G-alarm-list, row by row ----

interface Row {
  readonly name: string;
  readonly shape: string;
  readonly missing: string | undefined;
}

function alarmListPath(): string {
  const tasks = join(INFRA_ROOT, "..", "lore", "1-tasks");
  for (const status of ["active", "blocked", "archive"]) {
    const dir = readdirSync(join(tasks, status)).find((d) => d.startsWith("0027_"));
    if (dir) return join(tasks, status, dir, "notes", "G-alarm-list.md");
  }
  throw new Error("task 0027 not found under lore/1-tasks");
}

function alarmList(): Row[] {
  const rows: Row[] = [];
  let previous: string | undefined;
  for (const line of readFileSync(alarmListPath(), "utf8").split("\n")) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 5 || !cells[0]?.startsWith("`")) continue;
    const [name, , shape, , missingCell] = cells as [string, string, string, string, string];
    let missing: string | undefined;
    if (/^As above/i.test(missingCell)) missing = previous;
    else if (/^Not breaching/.test(missingCell)) missing = "notBreaching";
    else if (/^Ignore/.test(missingCell)) missing = "ignore";
    else if (/^Breaching/.test(missingCell)) missing = "breaching";
    previous = missing;
    rows.push({ name: name.replaceAll("`", ""), shape, missing });
  }
  return rows;
}

const PERIOD: Record<string, number> = { "one-minute": 60, "five-minute": 300, "one-hour": 3600 };

// ---- What the list's "Fires when" column says, written out ----

const t = allOn().thresholds;
const OP = {
  "<": "LessThanThreshold",
  ">": "GreaterThanThreshold",
  ">=": "GreaterThanOrEqualToThreshold",
} as const;

/**
 * Each Level and metric-math alarm's comparison, threshold, statistic, period in seconds and
 * "M of N", by hand: the list's "Fires when" column is prose, and `memory` and `log-volume` say only
 * "Level" (decision 34). Thresholds come from the config the template is built from.
 */
const LEVEL: Record<string, readonly [keyof typeof OP, number, string, number, number, number]> = {
  uptime: ["<", 1, "Minimum", 60, t.uptimeFailingMinutes, t.uptimeFailingMinutes],
  "uptime-flapping": ["<", 1, "Minimum", 60, t.uptimeFlapFailingMinutes, t.uptimeFlapWindowMinutes],
  "rpc-stalled": [">", t.rpcStalledSeconds, "Maximum", 60, 5, 5],
  "balance-stale": [">", t.balanceStaleSeconds, "Maximum", 60, 1, 1],
  "balance-low": ["<", t.balanceLowStroops, "Minimum", 300, 1, 1],
  "balance-critical": ["<", t.balanceCriticalStroops, "Minimum", 300, 1, 1],
  "account-state": [">=", 1, "Maximum", 300, 2, 2],
  pending: [">", t.pendingSeconds, "Maximum", 60, 3, 3],
  "channel-held": [">", t.channelHeldSeconds, "Maximum", 60, 1, 1],
  "queue-waiting": [">", 0, "Minimum", 60, 3, 3],
  "channel-quarantined": [">=", 1, "Maximum", 60, 1, 1],
  "sweeps-stopped": ["<", 1, "Sum", 60, 5, 5],
  "rpc-on-fallback": [">=", 1, "Minimum", 60, 15, 15],
  disk: [">", t.diskUsedPercent!, "Maximum", 300, 3, 3],
  memory: [">", t.memoryUsedPercent!, "Minimum", 300, 3, 3],
  "audit-disk": [">=", t.auditDiskUsedPercent, "Maximum", 300, 3, 3],
  "openbao-down": ["<", 1, "Minimum", 60, 3, 3],
  "wal-failing": [">=", 1, "Maximum", 60, 3, 3],
  "wal-stale": [">", t.walStaleSeconds, "Minimum", 60, 3, 3],
  "backup-age": [">", t.backupAgeSeconds, "Minimum", 60, 3, 3],
  "snapshot-age": [">", t.snapshotAgeSeconds, "Minimum", 60, 3, 3],
  certificate: ["<", t.certificateDaysLeft, "Maximum", 3600, 1, 1],
  "credentials-stale": [">", t.credentialsAgeSeconds, "Minimum", 60, 3, 3],
  "log-volume": [">", t.logVolumeBytesPerHour!, "Sum", 3600, 1, 1],
  "gauges-silent": [">=", 1, "SampleCount", 300, 3, 3],
  "watch-errors": [">=", 1, "Sum", 300, 2, 3],
};

/** Each Event alarm's threshold other than 1, which the list writes as "at N or more". */
const EVENT_THRESHOLD: Record<string, number> = {
  "pool-health": t.sequenceResyncCount,
};

describe("each alarm matches its row in G-alarm-list", () => {
  const rows = alarmList().filter((r) => !r.shape.startsWith("None"));

  test("the list and the template name the same alarms", () => {
    expect([...new Set(records.map((r) => r.base))].sort()).toEqual(rows.map((r) => r.name).sort());
  });

  test("LEVEL writes out every Level alarm, and only those", () => {
    const bases = (shape: string) =>
      [...new Set(records.filter((r) => r.shape === shape).map((r) => r.base))].sort();
    expect(Object.keys(LEVEL).sort()).toEqual(bases("level"));
  });

  test("an Event row says its threshold exactly when it isn't 1", () => {
    for (const row of rows.filter((r) => r.shape.startsWith("Event"))) {
      const said = /at (\d+) or more/.exec(row.shape)?.[1];
      expect(said === undefined ? 1 : Number(said), row.name).toBe(EVENT_THRESHOLD[row.name] ?? 1);
    }
  });

  test.each(rows.map((r) => [r.name, r]))("%s", (base, row: Row) => {
    const made = records.filter((r) => r.base === base);
    expect(made.length).toBeGreaterThan(0);
    for (const r of made) {
      const p = byName.get(r.alarmName)!;
      const stat = /`(Minimum|Maximum|Sum)`/.exec(row.shape)?.[1];
      expect(p["TreatMissingData"], "missing data").toBe(row.missing);

      if (row.shape.startsWith("Event")) {
        expect(r.shape).toBe("event");
        expect(statOf(p)).toBe(stat ?? "Sum");
        expect(periodOf(p)).toBe(/5-minute periods/.test(row.shape) ? 300 : 60);
        expect(p["EvaluationPeriods"]).toBe(Number(/N = (\d+)/.exec(row.shape)?.[1] ?? 15));
        expect(p["DatapointsToAlarm"]).toBe(1);
        expect([p["ComparisonOperator"], p["Threshold"]]).toEqual([
          "GreaterThanOrEqualToThreshold",
          EVENT_THRESHOLD[base] ?? 1,
        ]);
      } else if (row.shape.startsWith("Silence")) {
        expect(r.shape).toBe("silence");
        // telemetry-silent watches both of the agent's series, so a lost disk series fires too.
        expect((p["Metrics"] as MathMetric[]).find((m) => m.Expression)?.Expression).toBe(
          base === "telemetry-silent" ? "MIN([FILL(mem, 0), FILL(disk, 0)])" : "FILL(m, 0)",
        );
        expect([statOf(p), periodOf(p), p["EvaluationPeriods"], p["DatapointsToAlarm"]]).toEqual([
          "SampleCount",
          300,
          3,
          3,
        ]);
        expect([p["ComparisonOperator"], p["Threshold"]]).toEqual(["LessThanThreshold", 1]);
      } else if (row.shape.startsWith("Level") || row.shape.startsWith("Metric math")) {
        expect(r.shape).toBe("level");
        if (stat) expect(statOf(p)).toBe(stat);
        const window = /(\d+) of (\d+) (one-minute|five-minute|one-hour) period/.exec(row.shape);
        if (window) {
          expect(p["DatapointsToAlarm"]).toBe(Number(window[1]));
          expect(p["EvaluationPeriods"]).toBe(Number(window[2]));
          expect(periodOf(p)).toBe(PERIOD[window[3]!]);
        }
        const [op, threshold, statistic, period, m, n] = LEVEL[base]!;
        expect({
          comparison: p["ComparisonOperator"],
          threshold: p["Threshold"],
          statistic: statOf(p),
          period: periodOf(p),
          window: [p["DatapointsToAlarm"], p["EvaluationPeriods"]],
        }).toEqual({ comparison: OP[op], threshold, statistic, period, window: [m, n] });
      } else {
        throw new Error(`${base}: shape "${row.shape}" not understood`);
      }
    }
  });
});

// ---- The two metric-math alarms, pinned ----

/** A metric-math alarm as written: its expression, the statistics it reads, and each id's metric. */
function mathOf(template: TemplateJson, alarmName: string) {
  const p = ofType(template, "AWS::CloudWatch::Alarm").find(
    (a) => a.Properties["AlarmName"] === alarmName,
  )!.Properties;
  const metrics = (p["Metrics"] as MathMetric[]).filter((m) => m.MetricStat);
  return {
    expression: (p["Metrics"] as MathMetric[]).find((m) => m.Expression)?.Expression,
    stats: [...new Set(metrics.map((m) => m.MetricStat!.Stat))],
    ids: Object.fromEntries(
      metrics.map((m) => {
        const dims = Object.fromEntries(
          (m.MetricStat!.Metric.Dimensions ?? []).map((d) => [d.Name, d.Value]),
        );
        return [m.Id, [m.MetricStat!.Metric.MetricName, dims]];
      }),
    ),
  };
}

const SIX = {
  oldest: "settlement_oldest_open_seconds",
  queued: "pool_queued",
  quarantined: "pool_quarantined",
  fallback: "rpc_on_fallback",
  stalled: "rpc_stalled_seconds",
  balance: "balance_reading_age_seconds",
};

describe("gauges-silent (decision 28)", () => {
  const on = allOn();
  const heldOff = { ...on, alarmGroups: { ...on.alarmGroups, channelHeld: false } };

  test.each([
    ["on", all, { ...SIX, held: "channel_longest_hold_seconds" }],
    ["off", synth(heldOff), SIX],
  ] as const)(
    "with channelHeld %s, fires on any watched gauge's silence while the sweeps arrive",
    (_, built, gauges) => {
      const made = built.x.alarms.alarms.records.filter((r) => r.base === "gauges-silent");
      expect(made.map((r) => r.network).sort()).toEqual(["stellar:pubnet", "stellar:testnet"]);
      for (const r of made) {
        const fill = Object.keys(gauges)
          .map((id) => `FILL(${id}, 0)`)
          .join(", ");
        const on = { network: r.network };
        expect(mathOf(built.alarms, r.alarmName)).toEqual({
          expression: `(MIN([${fill}]) < 1) * (FILL(sweeps, 0) >= 1)`,
          // SampleCount, so a gauge at 0 still counts as a point.
          stats: ["SampleCount"],
          ids: {
            ...Object.fromEntries(Object.entries(gauges).map(([id, name]) => [id, [name, on]])),
            sweeps: ["settlement_sweeps_total", { ...on, outcome: "listed" }],
          },
        });
      }
    },
  );
});

test("store-outage adds both failure counters, either one missing read as 0", () => {
  const made = records.filter((r) => r.base === "store-outage");
  expect(made).toHaveLength(2);
  for (const r of made) {
    const on = { network: r.network };
    expect(mathOf(all.alarms, r.alarmName)).toEqual({
      expression: "FILL(records, 0) + FILL(spend, 0)",
      stats: ["Sum"],
      ids: {
        records: ["settlement_record_failures_total", on],
        spend: ["spend_store_failures_total", on],
      },
    });
  }
});
