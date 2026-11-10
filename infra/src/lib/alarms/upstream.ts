// G-alarm-list, "Upstream": the off-server check's upstream section (task 0029), once a day at
// 08:00 UTC. `upstream-changed` fires while a file the conformance gate rests on, or the discovery
// spec, differs from the gate's pin, and clears once the pin moves to an upstream that has the
// change. `upstream-silent` fires when the section published nothing for two days: `watch-errors`
// counts 2 of 3 five-minute runs, so a once-a-day failure never reaches it.
import type { AlarmFactory } from "./factory.js";

export function addUpstreamAlarms(f: AlarmFactory): void {
  f.level("upstream-changed", {
    group: "upstream",
    signal: { catalog: "upstream_files_changed" },
    statistic: "Maximum",
    periodMinutes: 24 * 60,
    periods: 1,
    comparison: ">=",
    threshold: 1,
    description: {
      what: "Upstream x402 main changed, since the conformance gate's pin, a file its suite rests on (the x402 spec, the Stellar exact scheme, the suite's Stellar routes) or the discovery spec (bazaar.md).",
      next: "Read the check's watch_upstream log line for the files, then the change upstream. Bump the pin in conformance/src/upstream.ts and rerun the gate (conformance/README.md), or say in the channel why not.",
      noData: "Keeps its state; upstream-silent covers a section that stops publishing.",
    },
  });

  // A day with no point breaches. 2 of 2: one failed day pages no one, as the next day's run retries.
  f.level("upstream-silent", {
    group: "upstream",
    signal: { catalog: "upstream_files_changed" },
    statistic: "SampleCount",
    periodMinutes: 24 * 60,
    periods: 2,
    comparison: "<",
    threshold: 1,
    missing: "breaching",
    description: {
      what: "The off-server check's daily upstream read published nothing for two days, so upstream-changed sees nothing: GitHub refused or timed out, a file moved upstream, or the pin file changed shape.",
      next: "Read the check's log at 08:00 UTC for watch_section_failed with section upstream: it names the file that failed, or the publish.",
      noData: "Breaching: no point is what this alarm is for.",
    },
  });
}
