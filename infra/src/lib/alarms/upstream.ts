// G-alarm-list, "Upstream": the off-server check's upstream section (task 0029), once an hour. It
// fires while a file the conformance gate's suite rests on differs from the gate's pin, and clears
// once the pin moves to an upstream that has the change.
import type { AlarmFactory } from "./factory.js";

export function addUpstreamAlarms(f: AlarmFactory): void {
  f.level("upstream-changed", {
    group: "watch",
    signal: { catalog: "upstream_files_changed" },
    statistic: "Maximum",
    periodMinutes: 60,
    periods: 1,
    comparison: ">=",
    threshold: 1,
    description: {
      what: "Upstream x402 main changed a file the conformance gate's suite rests on since the gate's pin: the x402 spec, the Stellar exact scheme or the suite's Stellar routes.",
      next: "Read the check's watch_upstream log line for the files, then the change upstream. Bump the pin in conformance/src/upstream.ts and rerun the gate (conformance/README.md), or say in the channel why not.",
      noData: "Keeps its state; watch-errors and watch-no-invocations cover the check.",
    },
  });
}
