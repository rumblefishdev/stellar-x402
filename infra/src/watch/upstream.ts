// The off-server check's upstream section (task 0029): once an hour it compares the three upstream
// x402 files the conformance gate's suite rests on, at the gate's pin, with upstream main, and
// publishes how many differ to `x402-watch` `upstream_files_changed`. The pin is read from this
// repo's develop, so bumping it moves the comparison and clears the alarm. Every file is public and
// read from raw.githubusercontent.com, so the check needs no token.
import type { PutMetricDataInput } from "./balance.js";
import { NAMESPACE } from "./metric.js";

export const OUR_PIN_URL =
  "https://raw.githubusercontent.com/rumblefishdev/stellar-x402/develop/conformance/src/upstream.ts";
export const UPSTREAM_RAW = "https://raw.githubusercontent.com/x402-foundation/x402";

/** The x402 spec, the Stellar `exact` scheme and the suite's list of Stellar routes. */
export const FILES = [
  "specs/x402-specification-v2.md",
  "specs/schemes/exact/scheme_exact_stellar.md",
  "e2e/config/mechanisms_stellar.json",
];

/** `x402-watch` `upstream_files_changed` in @stellar-x402/metrics-catalog: no dimension, unit Count. */
export const UPSTREAM_METRIC = "upstream_files_changed";

export interface UpstreamDeps {
  readonly fetchText: (url: string) => Promise<string>;
  readonly publish: (input: PutMetricDataInput) => Promise<unknown>;
  readonly log: (line: Record<string, unknown>) => void;
  readonly at: Date;
}

/** A file's text, or a throw on a failed request, so a run that couldn't compare publishes nothing. */
export async function fetchText(url: string): Promise<string> {
  const answer = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  return answer.text();
}

/**
 * One run of the section: the files that changed since the pin, published as their count. A read
 * that fails publishes nothing, is logged as `watch_section_failed` like the other sections, and
 * throws, so the run counts in `watch-errors`.
 */
export async function runUpstream(deps: UpstreamDeps): Promise<string[]> {
  try {
    return await compare(deps);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    deps.log({ msg: "watch_section_failed", section: "upstream", error: text });
    throw new Error(`upstream not read (${text})`, { cause: error });
  }
}

async function compare(deps: UpstreamDeps): Promise<string[]> {
  const pins = (await deps.fetchText(OUR_PIN_URL)).match(/[0-9a-f]{40}/g) ?? [];
  if (pins.length !== 1)
    throw new Error(`expected one commit in ${OUR_PIN_URL}, found ${pins.length}`);
  const pin = pins[0]!;
  const changed: string[] = [];
  for (const path of FILES) {
    const [atPin, onMain] = await Promise.all([
      deps.fetchText(`${UPSTREAM_RAW}/${pin}/${path}`),
      deps.fetchText(`${UPSTREAM_RAW}/main/${path}`),
    ]);
    if (atPin !== onMain) changed.push(path);
  }
  deps.log({ msg: "watch_upstream", pin, changed });
  await deps.publish({
    Namespace: NAMESPACE,
    MetricData: [
      {
        MetricName: UPSTREAM_METRIC,
        Dimensions: [],
        Value: changed.length,
        Unit: "Count",
        Timestamp: deps.at,
      },
    ],
  });
  return changed;
}
