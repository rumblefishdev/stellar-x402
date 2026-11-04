// The only way to make an alarm (G-alarm-list, "Shapes"): one method per shape, with the shape's
// statistic, periods, missing-data rule and OK message as defaults a row can override where the
// list says so. Names and dimensions come only through the catalog (`seriesDims`, the spine's
// AD-1), and an alarm never sets `Unit`: units are fixed per metric, and a mismatch leaves an alarm
// with no data. Each alarm records what it reads, for the template tests and `make check-series`.
import type { StellarNetwork } from "@stellar-x402/config";
import { type MetricName, seriesDims } from "@stellar-x402/metrics-catalog";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { Construct } from "constructs";
import type { AlarmGroup } from "../config.js";
import { networkSuffix } from "../names.js";

export type Shape = "event" | "count" | "level" | "silence";

/**
 * The AWS metrics an alarm may read. The catalog declares only our three namespaces, so these are
 * listed here, with the dimension each takes (AWS/Logs and AWS/Lambda docs, 2026-11-04).
 */
export const AWS_METRICS = {
  "AWS/Logs": {
    metrics: ["EMFValidationErrors", "EMFParsingErrors", "IncomingBytes"],
    dim: "LogGroupName",
  },
  "AWS/Lambda": { metrics: ["Errors", "Invocations"], dim: "FunctionName" },
} as const;
type AwsNamespace = keyof typeof AWS_METRICS;

/** A series an alarm reads, before the shape gives it a statistic and a period. */
export type Signal =
  | { readonly catalog: MetricName; readonly dims?: Readonly<Record<string, string>> }
  | {
      readonly aws: AwsNamespace;
      readonly metric: string;
      readonly dims: Readonly<Record<string, string>>;
    };

/** A metric-math signal: `expression` over the named signals, each read with the shape's statistic. */
export interface MathSignal {
  readonly expression: string;
  readonly using: Readonly<Record<string, Signal>>;
}

export type Statistic = "Sum" | "Minimum" | "Maximum" | "SampleCount";

export interface Description {
  /** What happened, as the reader in Slack sees it. */
  readonly what: string;
  /** The first step to take, and where the runbook says more. */
  readonly next: string;
  /** What a missing point means for this alarm and which alarm covers that silence. */
  readonly noData: string;
}

/** What one alarm reads, as written to the template. */
export interface SeriesRef {
  readonly namespace: string;
  readonly metricName: string;
  readonly dims: Readonly<Record<string, string>>;
}

export interface AlarmRecord {
  readonly alarmName: string;
  /** The row's name in G-alarm-list, without environment or network. */
  readonly base: string;
  readonly group: AlarmGroup;
  readonly shape: Shape;
  readonly network?: StellarNetwork;
  readonly series: readonly SeriesRef[];
}

interface Common {
  readonly group: AlarmGroup;
  readonly network?: StellarNetwork;
  /** Ends the name after the network, for a row with one alarm per mount or log group. */
  readonly qualifier?: string;
  readonly description: Description;
}

export interface EventSpec extends Common {
  readonly signal: Signal | MathSignal;
  /** Default `Sum`; the off-server counts take `Maximum` (G-alarm-list, "Statistics"). */
  readonly statistic?: Statistic;
  /** Default 1. */
  readonly periodMinutes?: number;
  /** The N in "1 of N periods", default 15, so a late point still counts. */
  readonly periods?: number;
  /** Default 1. */
  readonly threshold?: number;
}

export interface CountSpec extends Common {
  readonly signal: Signal;
  readonly threshold: number;
}

export interface LevelSpec extends Common {
  readonly signal: Signal | MathSignal;
  readonly statistic: Statistic;
  readonly periodMinutes: number;
  /** M in "M of M periods". */
  readonly periods: number;
  /** Default M: every period of the window. `watch-errors` takes 2 of 3. */
  readonly datapoints?: number;
  readonly comparison: ">" | ">=" | "<";
  readonly threshold: number;
  /** Default `ignore` (decision 19); `uptime` breaches on a missing point. */
  readonly missing?: "ignore" | "breaching" | "notBreaching";
}

export interface SilenceSpec extends Common {
  readonly signal: Signal;
}

const COMPARISON = {
  ">": cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  ">=": cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  "<": cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
} as const;

const MISSING = {
  ignore: cloudwatch.TreatMissingData.IGNORE,
  breaching: cloudwatch.TreatMissingData.BREACHING,
  notBreaching: cloudwatch.TreatMissingData.NOT_BREACHING,
} as const;

/** CloudWatch's limit on an alarm description. */
const MAX_DESCRIPTION = 1024;
/**
 * Printable ASCII only: `cdk diff` reads a deployed non-ASCII character back as `?`, so the string
 * shows as a change forever (the explorer's cloudwatch-stack.ts).
 */
const ASCII = /^[\x20-\x7e]*$/;

/** How a shape with an OK message re-arms, said in its description (G-alarm-list, "Shapes"). */
const REARM: Partial<Record<Shape, string>> = {
  level: "OK once it is back within its threshold; the next crossing fires it again.",
  silence: "OK once points arrive again; it fires again if they stop.",
};

export function describe(base: string, d: Description, shape?: Shape): string {
  const ok = shape && REARM[shape] ? ` ${REARM[shape]}` : "";
  const text = `${d.what} Next: ${d.next} No data: ${d.noData}${ok} Runbook: docs/monitoring.md, ${base}.`;
  if (!ASCII.test(text)) throw new Error(`${base}: the description must be printable ASCII`);
  if (text.length > MAX_DESCRIPTION)
    throw new Error(
      `${base}: the description is ${text.length} characters, over ${MAX_DESCRIPTION}`,
    );
  return text;
}

const isMath = (s: Signal | MathSignal): s is MathSignal => "expression" in s;

export interface AlarmFactoryProps {
  readonly envName: string;
  readonly groups: Readonly<Record<AlarmGroup, boolean>>;
  /** Every alarm's ALARM action, and the OK action of the shapes that send one. */
  readonly action: cloudwatch.IAlarmAction;
}

export class AlarmFactory {
  /** The alarms made, in order: groups that are off make none. */
  readonly records: AlarmRecord[] = [];

  constructor(
    private readonly scope: Construct,
    private readonly props: AlarmFactoryProps,
  ) {}

  /** The Event shape: the statistic at or over the threshold in 1 of N periods, no OK message. */
  event(base: string, spec: EventSpec): cloudwatch.Alarm | undefined {
    const periods = spec.periods ?? 15;
    return this.make(base, "event", spec, {
      metric: this.metric(spec.signal, spec.statistic ?? "Sum", spec.periodMinutes ?? 1),
      comparisonOperator: COMPARISON[">="],
      threshold: spec.threshold ?? 1,
      evaluationPeriods: periods,
      datapointsToAlarm: 1,
      treatMissingData: MISSING.notBreaching,
    });
  }

  /** The Count shape: `Sum` over 5 minutes at or over the threshold, 1 of 3, no OK message. */
  count(base: string, spec: CountSpec): cloudwatch.Alarm | undefined {
    return this.make(base, "count", spec, {
      metric: this.metric(spec.signal, "Sum", 5),
      comparisonOperator: COMPARISON[">="],
      threshold: spec.threshold,
      evaluationPeriods: 3,
      datapointsToAlarm: 1,
      treatMissingData: MISSING.notBreaching,
    });
  }

  /** The Level shape: past the threshold in M of M periods; keeps its state without data. */
  level(base: string, spec: LevelSpec): cloudwatch.Alarm | undefined {
    return this.make(base, "level", spec, {
      metric: this.metric(spec.signal, spec.statistic, spec.periodMinutes),
      comparisonOperator: COMPARISON[spec.comparison],
      threshold: spec.threshold,
      evaluationPeriods: spec.periods,
      datapointsToAlarm: spec.datapoints ?? spec.periods,
      treatMissingData: MISSING[spec.missing ?? "ignore"],
    });
  }

  /**
   * The Silence shape: `FILL(SampleCount(m), 0) < 1` in 3 of 3 five-minute periods, so it tests
   * that points arrive, not their value. `BREACHING` is the backstop for a series that has never
   * existed (the Prices API's 0222: a breaching-only silence alarm missed a 3-hour halt).
   */
  silence(base: string, spec: SilenceSpec): cloudwatch.Alarm | undefined {
    return this.make(base, "silence", spec, {
      metric: this.metric(
        { expression: "FILL(m, 0)", using: { m: spec.signal } },
        "SampleCount",
        5,
      ),
      comparisonOperator: COMPARISON["<"],
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: MISSING.breaching,
    });
  }

  private make(
    base: string,
    shape: Shape,
    spec: Common,
    props: Omit<cloudwatch.AlarmProps, "alarmName" | "alarmDescription" | "actionsEnabled">,
  ): cloudwatch.Alarm | undefined {
    if (!this.props.groups[spec.group]) return undefined;
    const alarmName = [
      `x402-${this.props.envName}-${base}`,
      ...(spec.network ? [networkSuffix(spec.network)] : []),
      ...(spec.qualifier ? [spec.qualifier] : []),
    ].join("-");
    if (!/^[a-z0-9-]+$/.test(alarmName)) throw new Error(`${alarmName}: not an alarm name`);
    const alarm = new cloudwatch.Alarm(this.scope, alarmName, {
      ...props,
      alarmName,
      alarmDescription: describe(base, spec.description, shape),
      // Never false: an alarm without its actions is a muted alarm (decision 26).
      actionsEnabled: true,
    });
    alarm.addAlarmAction(this.props.action);
    // An OK on an Event or Count alarm proves nothing about the cause (G-alarm-list).
    if (shape === "level" || shape === "silence") alarm.addOkAction(this.props.action);
    this.records.push({
      alarmName,
      base,
      group: spec.group,
      shape,
      ...(spec.network && { network: spec.network }),
      series: this.seriesOf(props.metric),
    });
    return alarm;
  }

  private metric(signal: Signal | MathSignal, statistic: Statistic, periodMinutes: number) {
    const period = cdk.Duration.minutes(periodMinutes);
    if (!isMath(signal)) return this.single(signal, statistic, period);
    const usingMetrics = Object.fromEntries(
      Object.entries(signal.using).map(([id, s]) => [id, this.single(s, statistic, period)]),
    );
    return new cloudwatch.MathExpression({ expression: signal.expression, usingMetrics, period });
  }

  private single(signal: Signal, statistic: Statistic, period: cdk.Duration): cloudwatch.Metric {
    if ("catalog" in signal) {
      const dims = signal.dims ?? {};
      const check = seriesDims(signal.catalog, dims);
      if (!check.ok) throw new Error(`alarm series: ${check.why}`);
      return new cloudwatch.Metric({
        namespace: check.namespace,
        metricName: signal.catalog,
        dimensionsMap: { ...dims },
        statistic,
        period,
      });
    }
    const known = AWS_METRICS[signal.aws];
    const keys = Object.keys(signal.dims);
    if (!(known.metrics as readonly string[]).includes(signal.metric))
      throw new Error(`alarm series: ${signal.aws} ${signal.metric} is not one an alarm may read`);
    if (keys.length !== 1 || keys[0] !== known.dim)
      throw new Error(`alarm series: ${signal.aws} ${signal.metric} takes only ${known.dim}`);
    return new cloudwatch.Metric({
      namespace: signal.aws,
      metricName: signal.metric,
      dimensionsMap: { ...signal.dims },
      statistic,
      period,
    });
  }

  private seriesOf(metric: cloudwatch.IMetric): SeriesRef[] {
    const one = (m: cloudwatch.Metric): SeriesRef => ({
      namespace: m.namespace,
      metricName: m.metricName,
      dims: { ...(m.dimensions as Record<string, string> | undefined) },
    });
    if (metric instanceof cloudwatch.Metric) return [one(metric)];
    if (metric instanceof cloudwatch.MathExpression)
      return Object.values(metric.usingMetrics).flatMap((m) => this.seriesOf(m));
    throw new Error("alarm series: an unknown metric type");
  }
}
