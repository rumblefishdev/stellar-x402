// The Prometheus rules for the monitoring VM (ADR 0011 "Monitoring stack", lore 0139 step 6), built
// from the same alarm rows as the CloudWatch alarms: `RuleSet` takes the factory's calls and turns
// each one that moves to Prometheus into a rule, with `network` a label instead of a matcher, so
// pubnet adds alert instances, not rules. Every Event row becomes one branch of a single rule. The
// rules the CloudWatch shapes can't express (liveness, the gauges' stamps, the textfiles' ages,
// the agent) are `serverRules`. Every series is the agent's, so every selector has
// `project="x402"` (deploy/metrics/prometheus.yml, `external_labels`), and every rule sets it as a
// label too: an aggregation drops it, and the VM's routes tell projects apart by it.
import type { StellarNetwork } from "@stellar-x402/config";
import { byName, type MetricName } from "@stellar-x402/metrics-catalog";
import { addAvailabilityAlarms } from "./alarms/availability.js";
import { addCostSilenceAlarms, watchedGauges } from "./alarms/cost-silence.js";
import {
  type Alarms,
  type Description,
  describe,
  type EventSpec,
  type LevelSpec,
  type MathSignal,
  type Severity,
  type Shape,
  type Signal,
  type SilenceSpec,
} from "./alarms/factory.js";
import { addHostAlarms } from "./alarms/host.js";
import { addMoneyAlarms } from "./alarms/money.js";
import { addProtocolAlarms } from "./alarms/protocol.js";
import { addSettlementAlarms } from "./alarms/settlement.js";
import { addUpstreamAlarms } from "./alarms/upstream.js";
import type { AlarmGroup, EnvironmentConfig } from "./config.js";
import { networkSuffix } from "./names.js";

export interface Rule {
  readonly alert: string;
  readonly expr: string;
  readonly for?: string;
  /** No `check` or `severity` on the Event rule: a rule's label overrides its branches'. */
  readonly labels: {
    readonly check?: string;
    readonly severity?: Severity;
    readonly shape: Shape | "server";
    readonly project: typeof PROJECT_NAME;
  };
  readonly annotations: { readonly description: string };
}

/** Why a row makes no rule: it stays in CloudWatch, or a server rule replaces it. */
export type Skip = { readonly check: string; readonly why: string };

const PROJECT_NAME = "x402";
const PROJECT = `project="${PROJECT_NAME}"`;

/**
 * Rows on a server-side metric that stay in CloudWatch all the same (ADR 0011, "Alerts"): the log
 * path's two, and OpenBao's audit disk, which must page when the VM can't.
 */
const STAYS = new Set(["audit-disk", "certificate", "credentials-stale"]);

/** CloudWatch rows on a series' arrival, which Prometheus reads another way (`serverRules`). */
const REPLACED: Record<string, string> = {
  "facilitator-silent": "x402-facilitator-silent",
  "gauges-silent": "x402-gauge-stale",
  "probe-silent": "x402-textfile-stale",
  "telemetry-silent": "stays in CloudWatch: it watches the CloudWatch agent",
};

/** The CloudWatch agent's two host metrics, as node_exporter's series give them. */
const NODE: Partial<Record<MetricName, (dims: Readonly<Record<string, string>>) => string>> = {
  mem_used_percent: () =>
    `100 * (1 - node_memory_MemAvailable_bytes{${PROJECT}} / node_memory_MemTotal_bytes{${PROJECT}})`,
  // ponytail: reserved blocks count as used here and not in the CloudWatch agent's figure, so it
  // reads a few points higher; the threshold stays.
  disk_used_percent: (d) => {
    const on = `${PROJECT},mountpoint="${d["path"]}"`;
    return `100 * (1 - node_filesystem_avail_bytes{${on}} / node_filesystem_size_bytes{${on}})`;
  },
};

const AGG = { Maximum: "max", Minimum: "min", Sum: "sum" } as const;
const isMath = (s: Signal | MathSignal): s is MathSignal => "expression" in s;
const minutes = (m: number) => `${m}m`;

/** `sum by (a, b) (x)`, or `sum(x)` with no labels. */
const agg = (op: string, by: readonly string[], x: string) =>
  by.length ? `${op} by (${by.join(", ")}) (${x})` : `${op}(${x})`;

/** The text for any network: the row's own network becomes the alert's `network` label. */
function anyNetwork(text: string, network?: StellarNetwork): string {
  if (!network) return text;
  // ponytail: the two spellings the rows use, the CAIP-2 id and `x402-db-<suffix>`.
  return text
    .replaceAll(network, "{{ $labels.network }}")
    .replaceAll(
      `x402-db-${networkSuffix(network)}`,
      'x402-db-{{ reReplaceAll "^stellar:" "" $labels.network }}',
    );
}

interface Series {
  /** An instant-vector selector or expression. */
  readonly inner: string;
  readonly counter: boolean;
  /** The labels the alert keeps: the row's dims, `network` among them. */
  readonly by: readonly string[];
}

export class RuleSet implements Alarms {
  readonly rules: Rule[] = [];
  readonly skipped: Skip[] = [];
  private readonly events = new Map<string, { expr: string; text: string }>();

  constructor(private readonly groups: Readonly<Record<AlarmGroup, boolean>>) {}

  event(base: string, spec: EventSpec): void {
    const check = this.take(base, spec);
    if (!check) return;
    if ((spec.statistic ?? "Sum") !== "Sum") throw new Error(`${check}: an Event rule sums`);
    const p = spec.periodMinutes ?? 1;
    const n = spec.periods ?? 15;
    const t = spec.threshold ?? 1;
    // One branch per term: a sum of FILLed counters fires when either term does.
    const signals = isMath(spec.signal) ? terms(check, spec.signal) : [spec.signal];
    const branches = signals.map((s) => {
      const { inner, by } = this.series(check, s);
      const inc = (m: number) => agg("sum", by, `increase(${inner}[${minutes(m)}])`);
      // "t in 1 of n periods": any increase in the window, or a period's at t or over.
      const expr =
        t === 1 ? `${inc(n * p)} > 0` : `max_over_time((${inc(p)})[${minutes(n * p)}:1m]) >= ${t}`;
      const labelled = `label_replace(${expr}, "check", "${check}", "", "")`;
      return `label_replace(${labelled}, "severity", "${spec.severity ?? "warning"}", "", "")`;
    });
    const expr = branches.join(" or ");
    const text = anyNetwork(describe(base, spec.description, "event"), spec.network);
    const seen = this.events.get(check);
    if (seen && seen.expr !== expr) throw new Error(`${check}: the networks' rows differ`);
    this.events.set(check, { expr, text });
  }

  level(base: string, spec: LevelSpec): void {
    const check = this.take(base, spec);
    if (!check) return;
    if (isMath(spec.signal)) throw new Error(`${check}: no Prometheus form for this expression`);
    if ((spec.datapoints ?? spec.periods) !== spec.periods || spec.missing)
      throw new Error(`${check}: only M of M periods, missing data ignored, carries over`);
    if (spec.statistic === "SampleCount") throw new Error(`${check}: SampleCount is CloudWatch's`);
    const { inner, counter, by } = this.series(check, spec.signal);
    const op = AGG[spec.statistic];
    const { periods: m, periodMinutes: p } = spec;
    // A counter's sum over the whole window; a gauge's statistic per period, held for M of them.
    const range = (w: number) =>
      inner.includes(" ") ? `(${inner})[${minutes(w)}:15s]` : `${inner}[${minutes(w)}]`;
    const value = counter
      ? agg("sum", by, `increase(${range(m * p)})`)
      : agg(op, by, `${op}_over_time(${range(p)})`);
    this.add(base, spec, "level", `${value} ${spec.comparison} ${spec.threshold}`, {
      ...(!counter && m > 1 && { for: minutes((m - 1) * p) }),
    });
  }

  silence(base: string, spec: SilenceSpec): void {
    const check = this.take(base, spec);
    if (!check) return;
    const by = REPLACED[base];
    if (!by) throw new Error(`${check}: a silence row needs a Prometheus replacement`);
    this.skipped.push({ check, why: by });
  }

  /** The single Event rule, every Event row a branch, its text chosen by `check`. */
  eventRule(): Rule | undefined {
    if (this.events.size === 0) return undefined;
    const entries = [...this.events];
    const text = entries
      .map(([check, e], i) => `{{ ${i ? "else if" : "if"} eq $labels.check "${check}" }}${e.text}`)
      .join("");
    return {
      alert: "x402-event",
      expr: entries.map(([, e]) => e.expr).join(" or "),
      labels: { shape: "event", project: PROJECT_NAME },
      annotations: { description: `${text}{{ end }}` },
    };
  }

  /** The row's name, or undefined for a row that makes no rule (recorded in `skipped`). */
  private take(
    base: string,
    spec: { group: AlarmGroup; qualifier?: string; signal: unknown },
  ): string | undefined {
    if (!this.groups[spec.group]) return undefined;
    const check = spec.qualifier ? `${base}-${spec.qualifier}` : base;
    if (STAYS.has(base)) return this.skip(check, "stays in CloudWatch (ADR 0011, Alerts)");
    const signals = allSignals(spec.signal as Signal | MathSignal);
    if (base === "gauges-silent") return this.skip(check, REPLACED[base]!);
    const off = signals.find(
      (s) => !("catalog" in s) || byName(s.catalog)?.namespace === "x402-watch",
    );
    if (off) return this.skip(check, "stays in CloudWatch: off the server or AWS's own metric");
    return check;
  }

  private skip(check: string, why: string): undefined {
    if (!this.skipped.some((s) => s.check === check)) this.skipped.push({ check, why });
    return undefined;
  }

  private series(check: string, s: Signal): Series {
    if (!("catalog" in s)) throw new Error(`${check}: not a catalog series`);
    const def = byName(s.catalog);
    if (!def) throw new Error(`${check}: ${s.catalog} is not in the catalog`);
    const dims = s.dims ?? {};
    const node = NODE[s.catalog];
    if (node) return { inner: node(dims), counter: false, by: [] };
    const matchers = Object.entries(dims)
      .filter(([k]) => k !== "network")
      .map(([k, v]) => `${k}="${v}"`);
    return {
      inner: `${s.catalog}{${[PROJECT, ...matchers].join(",")}}`,
      counter: def.kind === "counter",
      by: Object.keys(dims),
    };
  }

  private add(
    base: string,
    spec: {
      network?: StellarNetwork;
      qualifier?: string;
      description: Description;
      severity?: Severity;
    },
    shape: Shape,
    expr: string,
    extra: { for?: string },
  ): void {
    const check = spec.qualifier ? `${base}-${spec.qualifier}` : base;
    const alert = `x402-${check}`;
    const rule: Rule = {
      alert,
      expr,
      ...extra,
      labels: { check, severity: spec.severity ?? "warning", shape, project: PROJECT_NAME },
      annotations: {
        description: anyNetwork(describe(base, spec.description, shape), spec.network),
      },
    };
    const seen = this.rules.find((r) => r.alert === alert);
    if (!seen) this.rules.push(rule);
    else if (seen.expr !== rule.expr) throw new Error(`${alert}: the networks' rows differ`);
  }
}

function allSignals(s: Signal | MathSignal | { each: Record<string, Signal> }): Signal[] {
  if ("expression" in s) return Object.values(s.using);
  if ("each" in s) return Object.values(s.each);
  return [s];
}

/** `FILL(a, 0) + FILL(b, 0)`'s terms; any other expression has no Event form here. */
function terms(check: string, m: MathSignal): Signal[] {
  if (!/^FILL\(\w+, 0\)( \+ FILL\(\w+, 0\))*$/.test(m.expression))
    throw new Error(`${check}: no Event form for ${m.expression}`);
  return Object.values(m.using);
}

/** Only the textfiles the host probe writes (deploy/libexec/x402-host-probe). */
const TEXTFILES = ["host-probe", "watchdog_restarts_total", "facilitator_failures_total"];

/**
 * The rules a CloudWatch shape can't express: each needs a series the Prometheus side writes
 * (ADR 0011, "Metrics" and "Host metrics").
 */
export function serverRules(c: EnvironmentConfig): Rule[] {
  const on = c.alarmGroups;
  const rules: Rule[] = [];
  const rule = (
    check: string,
    group: AlarmGroup,
    expr: string,
    d: Description,
    wait?: number,
    severity: Severity = "warning",
  ): void => {
    if (!on[group]) return;
    rules.push({
      alert: `x402-${check}`,
      expr,
      ...(wait && { for: minutes(wait) }),
      labels: { check, severity, shape: "server", project: PROJECT_NAME },
      annotations: { description: describe(check, d) },
    });
  };
  const started = `facilitator_started_timestamp_seconds{${PROJECT}}`;
  const nodeUp = `up{${PROJECT},job="node"}`;

  rule(
    "facilitator-silent",
    "facilitator",
    `absent(${started})`,
    {
      what: "The facilitator's liveness series has been missing for 10 minutes: the process is down, its /metrics isn't scraped, or the agent's samples don't reach the VM. It fires beside uptime when the process is down.",
      next: `Check uptime first; then x402@${c.envName} on the server, and server-silent and target-down for the agent.`,
      noData: "Absence is what this rule is for.",
    },
    10,
    // 0138's D2: the money rules can't see without it.
    "critical",
  );

  // Each gauge's stamp moves at each successful read; a read that keeps throwing stops it while
  // the process runs (0138, "What doesn't carry over"). A stamp exists only after the first good
  // read, so each network has its absent() too (Adam's review of #200). 10 minutes old plus the
  // rule's 5 is gauges-silent's 15; the 5 keep a starting process's absent() quiet.
  const gauges = Object.values(watchedGauges(c));
  const stale = gauges.map((g) => {
    const stamp = `${g}_last_read_timestamp_seconds{${PROJECT}}`;
    const old = `label_replace(time() - ${stamp} > 600, "gauge", "${g}", "", "")`;
    const none = c.networks.map(
      (n) =>
        `label_replace(absent(${g}_last_read_timestamp_seconds{${PROJECT},network="${n}"}), "gauge", "${g}", "", "")`,
    );
    return [old, ...none].join(" or ");
  });
  rule(
    "gauge-stale",
    "facilitator",
    `(${stale.join(" or ")}) and on() ${started}`,
    {
      what: "A facilitator gauge on {{ $labels.network }} has had no successful read for 15 minutes, or none since the start, while the process runs: its read keeps failing, and the rules on it see its last value or nothing. Gauge: {{ $labels.gauge }}.",
      next: "Find the gauge's read error in the app logs (metric_issue, read-failed).",
      noData: "With the process down, facilitator-silent fires instead.",
    },
    5,
    // 0138's D2, as facilitator-silent: a stale gauge blinds the rules on it.
    "critical",
  );

  // The collector keeps serving a file's last values when nobody writes it, so each file has an
  // age (ADR 0011, "Host metrics"); a missing file reads as a probe that never ran.
  const mtime = `node_textfile_mtime_seconds{${PROJECT}}`;
  const absentFiles = TEXTFILES.map(
    (f) =>
      `label_replace(absent(node_textfile_mtime_seconds{${PROJECT},file=~"(.*/)?${f}\\\\.prom"}), "file", "${f}.prom", "", "")`,
  );
  rule(
    "textfile-stale",
    "host",
    `time() - ${mtime} > 300 or node_textfile_scrape_error{${PROJECT}} > 0 or ((${absentFiles.join(" or ")}) and on() ${nodeUp} == 1)`,
    {
      what: "A host probe textfile ({{ $labels.file }}) is over 5 minutes old, missing, or unreadable, so the probe's rules read stale values: OpenBao, WAL, the backups, the snapshot and the certificates.",
      next: "On the server: the x402-host-probe timer and its journal, and the files in /var/lib/x402/textfile.",
      noData: "A stopped agent sends nothing; server-silent fires instead.",
    },
  );

  rule("server-silent", "host", `absent_over_time(${nodeUp}[5m])`, {
    what: "No sample from ch-prod-01's metrics agent for 5 minutes: the agent, the server or its way out is down, or the VM refuses its writes. The metrics from before are kept.",
    next: "On the server: systemctl status x402-metrics and /var/log/x402/metrics/agent.log (docs/runbook.md, The metrics agent), then the agent's certificate.",
    noData: "Absence is what this rule is for.",
  });

  rule(
    "target-down",
    "host",
    `up{${PROJECT}} == 0`,
    {
      what: "The metrics agent on ch-prod-01 has failed to scrape {{ $labels.job }} for 5 minutes, so its rules see nothing new.",
      next: "On the server: the target's container in /srv/x402/metrics, or the facilitator's /metrics on the x402-metrics network.",
      noData: "A stopped agent sends nothing; server-silent fires instead.",
    },
    5,
  );

  rule(
    "agent-certificate",
    "host",
    `certificate_days_left{${PROJECT},certificate="metrics-agent"} < ${c.thresholds.certificateDaysLeft}`,
    {
      what: `The metrics agent's client certificate has under ${c.thresholds.certificateDaysLeft} days left, or its check fails. When it expires, the VM refuses the agent's writes and server-silent fires with no cause shown.`,
      next: "Renew it as docs/runbook.md, The metrics agent, says.",
      noData: "textfile-stale covers a stopped probe.",
    },
  );

  return rules;
}

/** Every rule for an environment, and why each row that makes none doesn't. */
export function buildRules(c: EnvironmentConfig): { rules: Rule[]; skipped: Skip[] } {
  const set = new RuleSet(c.alarmGroups);
  addAvailabilityAlarms(set, c);
  addMoneyAlarms(set, c);
  addProtocolAlarms(set, c);
  addSettlementAlarms(set, c);
  addHostAlarms(set, c);
  addCostSilenceAlarms(set, c);
  addUpstreamAlarms(set);
  const event = set.eventRule();
  return {
    rules: [...set.rules, ...(event ? [event] : []), ...serverRules(c)],
    skipped: set.skipped,
  };
}

/** The rule file Prometheus reads: JSON is YAML, so no YAML library. */
export function ruleFile(c: EnvironmentConfig): string {
  const { rules } = buildRules(c);
  const doc = { groups: [{ name: `x402-${c.envName}`, rules }] };
  return `# Generated by \`make rules\` in infra/ from the alarm rows (lore 0139 step 6). Don't edit.\n${JSON.stringify(doc, null, 2)}\n`;
}
