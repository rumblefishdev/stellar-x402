// G-alarm-list, "Upstream": the off-server check's upstream and library sections (tasks 0029 and
// 0147), once a day at 08:00 UTC. `upstream-changed` fires while a file the conformance gate rests
// on, or the discovery spec, differs from the gate's pin, and clears once the pin moves to an
// upstream that has the change. `upstream-library-behind` fires while production asks for another
// `@x402/stellar` than npm's latest, and clears once a deploy brings it there. Each reads a day
// with no point as a breach: a read that broke can't pass as all clear, and `watch-errors` counts
// 2 of 3 five-minute runs, so a once-a-day failure never reaches it.
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type { AlarmFactory } from "./factory.js";

/**
 * Whole UTC days, not CloudWatch's default sliding 24 hours: that window loses yesterday's 08:00
 * point before today's lands and would fire and clear every morning (AWS, "Alarm evaluation
 * window"). A day's point is read once the day ends, at 00:00 UTC.
 */
function readWholeDays(alarm: cloudwatch.Alarm | undefined): void {
  if (alarm)
    (alarm.node.defaultChild as cloudwatch.CfnAlarm).evaluationWindow = { wallClockWindow: {} };
}

export function addUpstreamAlarms(f: AlarmFactory): void {
  // FILL(m, 1) turns a day with no point into a breach; `breaching` covers a series that was never
  // written, which metric math alone can't see (the factory's Silence shape, the Prices API's 0222).
  const changed = f.level("upstream-changed", {
    group: "upstream",
    signal: { expression: "FILL(m, 1)", using: { m: { catalog: "upstream_files_changed" } } },
    statistic: "Maximum",
    periodMinutes: 24 * 60,
    periods: 1,
    comparison: ">=",
    threshold: 1,
    missing: "breaching",
    description: {
      what: "Upstream x402 main changed, since the conformance gate's pin, a file its suite rests on (the x402 spec, the Stellar exact scheme, the suite's Stellar routes) or the discovery spec (bazaar.md); or the day's read failed.",
      next: "Read the check's 08:00 UTC log: watch_upstream lists the files that differ, watch_section_failed with section upstream names the read that failed. Bump the pin in conformance/src/upstream.ts and rerun the gate (conformance/README.md), or say in the channel why not.",
      noData: "Breaching: a day with no point is a read that failed.",
    },
  });

  const behind = f.level("upstream-library-behind", {
    group: "upstream",
    signal: { expression: "FILL(m, 1)", using: { m: { catalog: "upstream_library_behind" } } },
    statistic: "Maximum",
    periodMinutes: 24 * 60,
    periods: 1,
    comparison: ">=",
    threshold: 1,
    missing: "breaching",
    description: {
      what: "Production's facilitator asks for another @x402/stellar than the one npm calls latest; or the day's read failed (/health, GitHub or npm).",
      next: "Read the check's 08:00 UTC log: watch_library names both versions, watch_section_failed with section library names the read that failed. Raise the @x402 packages (AD-14 in docs/architecture/m1-spine.md) and deploy, or say in the channel why not.",
      noData: "Breaching: a day with no point is a read that failed.",
    },
  });

  readWholeDays(changed);
  readWholeDays(behind);
}
