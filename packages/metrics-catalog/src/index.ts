// Typed catalog of every 0027 metric, across the three namespaces: what the facilitator writes as
// EMF (`x402-facilitator`), what the host probe and agent write (`x402-host`, #113) and what the
// off-server Lambdas publish (`x402-watch`, #115). Data and types only; identity, never alarm
// behaviour. Source of truth: lore 0027 notes/G-metrics.md and notes/S-pr112-spine.md (AD-1, AD-2).
// Below the data, the series rule (`effectiveSets`, `seriesDims`): the one home of which series a
// metric produces, shared by the facilitator's EMF builder, the alarms (#114) and the Lambdas (#115).
import { isStellarNetwork, type StellarNetwork } from "@stellar-x402/config";

/** A `network` dimension value: the CAIP-2 id from `STELLAR_NETWORKS`, never retyped. */
export type Network = StellarNetwork;

export type Namespace = "x402-facilitator" | "x402-host" | "x402-watch";
export type MetricKind = "counter" | "gauge";
/** Fixed for the metric's life: alarms omit `Unit`, and a mismatch leaves one without data. */
export type Unit = "Count" | "Seconds" | "None" | "Percent";
/** `network` puts `network` in every set (added by the writer); `process` never carries it. */
export type Scope = "network" | "process";
/**
 * `eager-first`: the first increment of a series in a window is written at once, later ones add
 * to the minute line (an Event alarm's deciding point leaves before a crash). It only governs the
 * facilitator's writer; the other namespaces are `aggregated`.
 */
export type Emit = "eager-first" | "aggregated";

/**
 * One CloudWatch dimension set. A line carries every set whose `when` matches its labels (each
 * key's label holds one of the listed values), and only if each of its dims has a valid value.
 * `network` is never listed here: a `network`-scoped metric gets it in every set, as
 * {@link effectiveSets} returns them.
 */
export interface DimSet {
  readonly dims: readonly string[];
  readonly when?: Readonly<Record<string, readonly string[]>>;
}

export interface MetricDef {
  readonly namespace: Namespace;
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit: Unit;
  readonly scope: Scope;
  readonly sets: readonly DimSet[];
  /**
   * The closed values of each billed dim. A facilitator dim includes `other`, and a value outside
   * is written as `other`; a host dim lists what the agent writes (the mount `/`). A label in no
   * set is a log field and is not restricted.
   */
  readonly values?: Readonly<Record<string, readonly string[]>>;
  /**
   * The labels a writer may add as log fields only: in no set, so not billed and not restricted.
   * With the sets' dims, their `when` keys and `values`, they are every label key the facilitator's
   * port accepts for the metric, so a mistyped key doesn't compile (decision 57).
   */
  readonly fields?: readonly string[];
  readonly emit: Emit;
}

/** Every EMF line starts with this; #113's agent filter shares it. */
export const EMF_LINE_PREFIX = '{"_aws":';

const FAC = "x402-facilitator";
const HOST = "x402-host";
const WATCH = "x402-watch";

/** The default: one set, plus `network` for a network-scoped metric. */
const PLAIN = [{ dims: [] }] as const;

export const CATALOG = [
  // ---- x402-facilitator, on develop today ----
  {
    namespace: FAC,
    name: "settlement_outcomes_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: [{ dims: ["result"] }],
    values: { result: ["success", "error", "other"] },
    fields: ["reason", "replay"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_refused_after_verify_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: [{ dims: ["stage"], when: { stage: ["pool"] } }],
    values: { stage: ["check", "pool", "other"] },
    fields: ["reason"],
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "settlement_record_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "settlement_history_gone_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "settlement_landed_after_expired_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["state"],
    emit: "eager-first",
  },
  // 0087: our inner transaction landed under someone else's fee bump, or bare. Free for us, a
  // warning only: no alarm.
  {
    namespace: FAC,
    name: "settlement_rewrapped_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["state"],
    emit: "aggregated",
  },
  // The OpenBao signer holds one network's keys (openbao-signer.ts logs its `network`).
  {
    namespace: FAC,
    name: "signer_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["reason", "step"],
    emit: "eager-first",
  },
  // From the submitter's `onEvent` in main.ts: one pool per network.
  {
    namespace: FAC,
    name: "pool_events_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: [{ dims: [] }, { dims: ["type"], when: { type: ["sequence-resync"] } }],
    // signer-pool's SubmitterEvent types.
    values: {
      type: [
        "sent",
        "sequence-resync",
        "channel-quarantined",
        "resolved",
        "read-retry",
        "send-retry",
        "prepared-ahead",
        "fee-raised",
        "final",
        "refused",
        "other",
      ],
    },
    fields: ["status"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_uncertain_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_submit_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "settlement_budget_exhausted_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["signed"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_reconciled_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    // `state` only for `expired`: a payment that never landed, which `settlement-expired` reads.
    sets: [{ dims: [] }, { dims: ["state"], when: { state: ["expired"] } }],
    values: { state: ["rejected", "success", "failed", "expired", "other"] },
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "settlement_reopened_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["reason"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_lease_fenced_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_hook_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["hook"],
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "settlement_already_settled_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_nonce_reuse_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  // The lease is one network's channel set (lease.ts, `leaseName(network)`).
  {
    namespace: FAC,
    name: "lease_changes_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["held"],
    emit: "aggregated",
  },
  // The pruner deletes from whole tables shared by every network (rate_limits, spend_*), not one
  // network's rows, so it is process-scoped.
  {
    namespace: FAC,
    name: "store_prune_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    fields: ["table"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "catalog_internal_errors_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    fields: ["stage", "origin"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "catalog_rejections_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    fields: ["origin", "reason"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "catalog_upsert_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    fields: ["origin"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "catalog_upserts_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    fields: ["origin", "outcome"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "catalog_route_template_ignored_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    fields: ["origin"],
    emit: "aggregated",
  },
  // An HTTP route's query check; `discoveryResources` takes a network only for its answer.
  {
    namespace: FAC,
    name: "discovery_unknown_params_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },

  // ---- x402-facilitator, from 0024 (#105): the spend policy is per network ----
  {
    namespace: FAC,
    name: "spend_breaker_opened_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    // One series per kind, so payer breakers opened with fresh accounts don't hide a pay_to or
    // an asset one behind an alarm already in ALARM (Karol's review of #114, point 7).
    sets: [{ dims: ["breaker"] }],
    // policy.ts BreakerKind.
    values: { breaker: ["payer", "pay_to", "asset", "other"] },
    emit: "eager-first",
  },
  // `payer` and `pay_to` write no metric: one buyer or seller near its budget is the budget
  // working (G-alarm-list). `budget` matches the set but is never a dimension.
  {
    namespace: FAC,
    name: "spend_budget_nearing_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: [{ dims: [], when: { budget: ["asset", "other", "global"] } }],
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "spend_failure_attributed_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: [{ dims: ["fault"], when: { fault: ["ours"] } }],
    // policy.ts FAULT_LABELS: fault classes, never addresses.
    values: { fault: ["payer", "pay_to", "asset", "ours", "other"] },
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "spend_commit_unmatched_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["state"],
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "spend_store_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["op"],
    emit: "eager-first",
  },
  {
    namespace: FAC,
    name: "spend_refused_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["reason"],
    emit: "aggregated",
  },
  // The floor reads one network's fee account (balance-floor.ts).
  {
    namespace: FAC,
    name: "balance_read_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },

  // ---- x402-facilitator, new in #112 ----
  // Process-scoped: a route serves both networks once 0077 lands.
  {
    namespace: FAC,
    name: "http_requests_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: [{ dims: ["route"] }, { dims: ["status"], when: { status: ["500"] } }],
    values: {
      route: ["/verify", "/settle", "/supported", "/health", "/discovery", "other"],
      // What http/app.ts and rate-limit.ts answer (400, 413 and 415 from body-parser, 304 from
      // Express's weak ETag on a repeated GET), and `aborted` for a client that left before the
      // answer.
      status: ["200", "304", "400", "404", "413", "415", "429", "500", "503", "aborted", "other"],
    },
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_sweeps_total",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: [{ dims: ["outcome"] }],
    values: { outcome: ["listed", "failed", "other"] },
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "settlement_oldest_open_seconds",
    kind: "gauge",
    unit: "Seconds",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "pool_queued",
    kind: "gauge",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    fields: ["channels", "busy"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "pool_quarantined",
    kind: "gauge",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "rpc_on_fallback",
    kind: "gauge",
    unit: "None",
    scope: "network",
    sets: PLAIN,
    fields: ["rpc"],
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "rpc_stalled_seconds",
    kind: "gauge",
    unit: "Seconds",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "balance_reading_age_seconds",
    kind: "gauge",
    unit: "Seconds",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: FAC,
    name: "fee_charged_stroops",
    kind: "counter",
    unit: "None",
    scope: "network",
    sets: PLAIN,
    fields: ["state"],
    emit: "aggregated",
  },
  // 0089: declared, emitter not yet on develop
  {
    namespace: FAC,
    name: "channel_longest_hold_seconds",
    kind: "gauge",
    unit: "Seconds",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },

  // ---- x402-host: the host probe and the agent (#113), one host ----
  {
    namespace: HOST,
    name: "openbao_up",
    kind: "gauge",
    unit: "None",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: HOST,
    name: "wal_failing",
    kind: "gauge",
    unit: "None",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: HOST,
    name: "wal_last_archived_age_seconds",
    kind: "gauge",
    unit: "Seconds",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: HOST,
    name: "backup_age_seconds",
    kind: "gauge",
    unit: "Seconds",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: HOST,
    name: "snapshot_age_seconds",
    kind: "gauge",
    unit: "Seconds",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  // Days, negative after expiry; CloudWatch has no day unit.
  {
    namespace: HOST,
    name: "certificate_days_left",
    kind: "gauge",
    unit: "None",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: HOST,
    name: "host_probe_heartbeat",
    kind: "gauge",
    unit: "None",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  // Since the signing helper last wrote the agent's credentials file; it runs hourly.
  {
    namespace: HOST,
    name: "credentials_age_seconds",
    kind: "gauge",
    unit: "Seconds",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: HOST,
    name: "watchdog_restarts_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  // An end of x402@<env> other than `success`, written by its ExecStopPost: a crash, a failed
  // start, a drain cut short, a dockerd crash, the watchdog's kill of a hung process.
  {
    namespace: HOST,
    name: "facilitator_failures_total",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: HOST,
    name: "mem_used_percent",
    kind: "gauge",
    unit: "Percent",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  // `path` is the mount point, under the name the agent's disk plugin gives it: the agent can't
  // rename a dimension. One mount: `/` holds everything of ours, OpenBao's audit volume too.
  {
    namespace: HOST,
    name: "disk_used_percent",
    kind: "gauge",
    unit: "Percent",
    scope: "process",
    sets: [{ dims: ["path"] }],
    values: { path: ["/"] },
    emit: "aggregated",
  },

  // ---- x402-watch: PutMetricData from the uptime probe and the off-server check (#115) ----
  {
    namespace: WATCH,
    name: "ready",
    kind: "gauge",
    unit: "None",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: WATCH,
    name: "spendable_stroops",
    kind: "gauge",
    unit: "None",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  // The network's ledger protocol and the highest one the Stellar Core behind its Horizon
  // supports, from Horizon's root, so a coming upgrade and a done one both show (0027 decision 70).
  {
    namespace: WATCH,
    name: "protocol_version",
    kind: "gauge",
    unit: "None",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: WATCH,
    name: "protocol_supported_version",
    kind: "gauge",
    unit: "None",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  {
    namespace: WATCH,
    name: "account_state_mismatches",
    kind: "gauge",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  // Effects seen since the cursor: a count per run.
  {
    namespace: WATCH,
    name: "account_effects_unexpected",
    kind: "counter",
    unit: "Count",
    scope: "network",
    sets: PLAIN,
    emit: "aggregated",
  },
  // `GetSecretValue` events not counted before: one AWS account, no network.
  {
    namespace: WATCH,
    name: "backup_secret_reads",
    kind: "counter",
    unit: "Count",
    scope: "process",
    sets: PLAIN,
    emit: "aggregated",
  },
] as const satisfies readonly MetricDef[];

type Entry = (typeof CATALOG)[number];
type FacilitatorEntry = Extract<Entry, { namespace: typeof FAC }>;

export type MetricName = Entry["name"];
/** The facilitator's counter names: what the `Metrics` port's `increment` accepts. */
export type CounterName = Extract<FacilitatorEntry, { kind: "counter" }>["name"];
/** The facilitator's gauge names: what the `Metrics` port's `registerGauge` accepts. */
export type GaugeName = Extract<FacilitatorEntry, { kind: "gauge" }>["name"];

type SetKeys<S> =
  | (S extends { dims: readonly (infer D)[] } ? D : never)
  | (S extends { when: infer W } ? keyof W : never);
type EntryKeys<E> =
  | (E extends { sets: readonly (infer S)[] } ? SetKeys<S> : never)
  | (E extends { values: infer V } ? keyof V : never)
  | (E extends { fields: readonly (infer F)[] } ? F : never);
/**
 * The label keys a metric's writer may pass: its sets' dims and `when` keys, its `values` and its
 * `fields`. `network` is never one: the port's `for()` adds it (decision 57).
 */
export type LabelKey<N extends MetricName> = Exclude<
  EntryKeys<Extract<Entry, { name: N }>>,
  "network"
> &
  string;

type Scoped<K extends MetricKind, S extends Scope> = Extract<
  FacilitatorEntry,
  { kind: K; scope: S }
>["name"];
/** Counters a network's parts write, through the child `for({ network })` returns. */
export type NetworkCounterName = Scoped<"counter", "network">;
/** Counters the process-wide parts write, through the root. */
export type ProcessCounterName = Scoped<"counter", "process">;
/** Gauges a network's parts register, through the child. */
export type NetworkGaugeName = Scoped<"gauge", "network">;
/** Gauges the process-wide parts register, through the root: none yet. */
export type ProcessGaugeName = Scoped<"gauge", "process">;

// Names are unique across namespaces too (the catalog test checks it), so a name alone is a key.
const BY_NAME: ReadonlyMap<string, MetricDef> = new Map(CATALOG.map((m) => [m.name, m]));

/** The entry for `name`, or `undefined` for a name the catalog doesn't declare. */
export function byName(name: string): MetricDef | undefined {
  return BY_NAME.get(name);
}

/** The names written eager-first: the facilitator metrics an Event-shape alarm reads. */
export const eagerNames: ReadonlySet<string> = new Set(
  CATALOG.filter((m) => m.emit === "eager-first").map((m) => m.name),
);

/**
 * A set as it is written: `network` first in `dims` for a `network`-scoped metric, `when` as the
 * catalog declares it (absent for a set written whatever the labels).
 */
export interface EffectiveSet {
  readonly dims: readonly string[];
  readonly when?: Readonly<Record<string, readonly string[]>>;
}

/** The metric's sets as written, in catalog order: what every writer and every alarm reads. */
export function effectiveSets(def: MetricDef): EffectiveSet[] {
  const lead = def.scope === "network" ? ["network"] : [];
  return def.sets.map((set) => ({
    dims: [...lead, ...set.dims],
    ...(set.when && { when: set.when }),
  }));
}

/** CloudWatch's limit on a dimension value's length. */
const MAX_DIM_LENGTH = 1024;
/** Printable ASCII, with at least one non-space: what CloudWatch accepts as a dimension value. */
const PRINTABLE = /^[\x20-\x7e]*[\x21-\x7e][\x20-\x7e]*$/;

/** Whether CloudWatch takes `value` as a dimension value: printable, non-blank, 1024 at most. */
export function isDimValue(value: string): boolean {
  return value.length <= MAX_DIM_LENGTH && PRINTABLE.test(value);
}

/**
 * Whether a set's `when` holds: each of its labels has one of the listed values. `valueOf` gives
 * a label's value, `undefined` for a label that has none (which fails the condition).
 */
export function whenHolds(
  set: Pick<EffectiveSet, "when">,
  valueOf: (label: string) => string | undefined,
): boolean {
  return Object.entries(set.when ?? {}).every(([label, allowed]) => {
    const v = valueOf(label);
    return v !== undefined && allowed.includes(v);
  });
}

export type SeriesCheck = { ok: true; namespace: Namespace } | { ok: false; why: string };

/**
 * Whether `dims` name a series the metric writes: they are exactly one effective set's dims, each
 * value is one CloudWatch takes and one the dim allows (its closed `values`, any for an open dim,
 * a `STELLAR_NETWORKS` value for `network`), and the set's `when` holds on them. A `when` label
 * that is not a dim of the set (`spend_budget_nearing_total`'s `budget`) decides which lines
 * write the series, not which series it is, so it doesn't restrict `dims`. With the namespace an
 * alarm on the series names, and no unit, since alarms omit `Unit`; what an alarm calls per metric
 * and dimension map (#114).
 */
export function seriesDims(name: MetricName, dims: Readonly<Record<string, string>>): SeriesCheck {
  const def = byName(name);
  if (!def) return { ok: false, why: `${name} is not in the catalog` };
  const keys = Object.keys(dims);
  const set = effectiveSets(def).find(
    (s) => s.dims.length === keys.length && s.dims.every((d) => Object.hasOwn(dims, d)),
  );
  if (!set) {
    const sets = effectiveSets(def)
      .map((s) => `[${s.dims.join(", ")}]`)
      .join(", ");
    return { ok: false, why: `${name} writes no set [${keys.join(", ")}]; its sets: ${sets}` };
  }
  for (const [dim, value] of Object.entries(dims)) {
    if (!isDimValue(value))
      return { ok: false, why: `${name}: ${dim} "${value}" is no CloudWatch dimension value` };
    // Only a network-scoped set holds `network`, and its values are the configured networks.
    const closed = def.values?.[dim];
    const allowed =
      dim === "network" ? isStellarNetwork(value) : closed === undefined || closed.includes(value);
    if (!allowed) return { ok: false, why: `${name}: ${dim} "${value}" is not one of its values` };
  }
  const onDims = Object.fromEntries(
    Object.entries(set.when ?? {}).filter(([label]) => set.dims.includes(label)),
  );
  if (!whenHolds({ when: onDims }, (label) => dims[label]))
    return {
      ok: false,
      why: `${name}: the set [${set.dims.join(", ")}] is written only when ${JSON.stringify(set.when)}`,
    };
  return { ok: true, namespace: def.namespace };
}
