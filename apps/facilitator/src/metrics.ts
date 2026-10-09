/** Counters for the lanes until 0027 brings the exporter. Labels come from closed sets only. */
export interface Metrics {
  increment(name: string, labels?: Record<string, string>): void;
}

/** In-process counters, also the production default until 0027. */
export function memoryMetrics(): Metrics & {
  value(name: string, labels?: Record<string, string>): number;
} {
  const counts = new Map<string, number>();
  const id = (name: string, labels: Record<string, string> = {}) =>
    `${name}${JSON.stringify(Object.entries(labels).sort())}`;
  return {
    increment(name, labels) {
      const key = id(name, labels);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    value: (name, labels) => counts.get(id(name, labels)) ?? 0,
  };
}
