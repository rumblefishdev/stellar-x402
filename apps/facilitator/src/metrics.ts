import type {
  CounterName,
  GaugeName,
  Network,
  NetworkCounterName,
  NetworkGaugeName,
  ProcessCounterName,
  ProcessGaugeName,
} from "@stellar-x402/metrics-catalog";

export type Labels = Record<string, string | number | boolean | bigint>;

export type GaugeRead = () => { value: number; labels?: Labels };

/**
 * The root, for the parts that serve every network (the HTTP app, discovery, the cataloger, the
 * pruner). Counters push, gauges pull, and `increment` never throws. Names are typed against the
 * catalog by scope (0027 AD-3): the root takes only process-scoped names, so a network-scoped
 * metric written without its `network` doesn't compile. Labels stay a permissive record, and
 * `network` is reserved for `for()`.
 */
export interface ProcessMetrics {
  increment(name: ProcessCounterName, labels?: Labels, by?: number): void;
  registerGauge(name: ProcessGaugeName, read: GaugeRead): void;
  /** A child scoped to one network: it adds `network` to every label set, over any given. */
  for(scope: { network: Network }): NetworkMetrics;
}

/**
 * One network's child, for that network's parts (settlement, records, reconciliation, the pool,
 * the lease, the spend lane, the balance floor, the signer). It takes only network-scoped names.
 */
export interface NetworkMetrics {
  increment(name: NetworkCounterName, labels?: Labels, by?: number): void;
  registerGauge(name: NetworkGaugeName, read: GaugeRead): void;
}

/** What a writer implements underneath both: any facilitator name, labels as given. */
export interface MetricsWriter {
  increment(name: CounterName, labels?: Labels, by?: number): void;
  registerGauge(name: GaugeName, read: GaugeRead): void;
}

/** One series' identity: its name and its labels, stringified and sorted. */
export const seriesKey = (name: string, labels: Labels = {}) =>
  `${name}${JSON.stringify(
    Object.entries(labels)
      .map(([k, v]) => [k, String(v)])
      .sort(),
  )}`;

/** A thin child over `writer` that adds `network` to every label set. */
export function scoped(writer: MetricsWriter, network: Network): NetworkMetrics {
  return {
    increment(name, labels, by) {
      writer.increment(name, { ...labels, network }, by);
    },
    registerGauge(name, read) {
      writer.registerGauge(name, () => {
        const r = read();
        return { ...r, labels: { ...r.labels, network } };
      });
    },
  };
}

/**
 * In-process metrics double, also the default when `compose()` gets no writer. It takes every
 * facilitator name itself, so a test can hand it to a part of either scope; its `for()` child is a
 * plain `NetworkMetrics`. The scope is checked where production code passes the root or a child,
 * by those parts' types.
 */
export function memoryMetrics(): MetricsWriter & {
  for(scope: { network: Network }): NetworkMetrics;
  /**
   * A counter's sum for exactly these labels. A gauge's value: with no labels, the last one
   * registered under the name; with labels, the one whose (merged) labels match exactly.
   */
  value(name: CounterName | GaugeName, labels?: Labels): number;
} {
  const counts = new Map<string, number>();
  const gauges = new Map<string, GaugeRead[]>();
  const id = seriesKey;
  const root: MetricsWriter = {
    increment(name, labels, by = 1) {
      const key = id(name, labels);
      counts.set(key, (counts.get(key) ?? 0) + by);
    },
    registerGauge(name, read) {
      gauges.set(name, [...(gauges.get(name) ?? []), read]);
    },
  };
  return {
    ...root,
    for: (scope) => scoped(root, scope.network),
    value(name, labels) {
      const reads = gauges.get(name);
      if (reads) {
        if (!labels) return reads[reads.length - 1]!().value;
        const want = id(name, labels);
        for (const read of [...reads].reverse()) {
          const r = read();
          if (id(name, r.labels) === want) return r.value;
        }
        return 0;
      }
      return counts.get(id(name, labels)) ?? 0;
    },
  };
}
