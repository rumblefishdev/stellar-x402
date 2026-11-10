// The off-server check's upstream section (task 0029): once a day it compares the upstream x402
// files the conformance gate's suite rests on, and the discovery spec the RFP names, at the gate's
// pin, with upstream main, and publishes how many differ to `x402-watch` `upstream_files_changed`.
// The pin is read from this repo's develop, so bumping it moves the comparison and clears the
// alarm. Every file is public and read from raw.githubusercontent.com, so the check needs no token.
import type { PutMetricDataInput } from "./balance.js";
import { NAMESPACE } from "./metric.js";
import { PROTOCOL_DEADLINE_MS } from "./protocol.js";

export const OUR_PIN_URL =
  "https://raw.githubusercontent.com/rumblefishdev/stellar-x402/develop/conformance/src/upstream.ts";
export const UPSTREAM_RAW = "https://raw.githubusercontent.com/x402-foundation/x402";

/**
 * The x402 spec, the Stellar `exact` scheme, the suite's list of Stellar routes, and the discovery
 * spec: the RFP asks to track its evolution through the grant.
 */
export const FILES = [
  "specs/x402-specification-v2.md",
  "specs/schemes/exact/scheme_exact_stellar.md",
  "e2e/config/mechanisms_stellar.json",
  "specs/extensions/bazaar.md",
];

/** `x402-watch` `upstream_files_changed` in @stellar-x402/metrics-catalog: no dimension, unit Count. */
export const UPSTREAM_METRIC = "upstream_files_changed";

export interface UpstreamDeps {
  readonly fetchText: (url: string, signal: AbortSignal) => Promise<string>;
  readonly publish: (input: PutMetricDataInput) => Promise<unknown>;
  readonly log: (line: Record<string, unknown>) => void;
  readonly at: Date;
}

/**
 * The run at 08:00 UTC, once a day: upstream changed these four files 22 times in the 27 weeks
 * from May to November 2026.
 */
export function isUpstreamRun(at: Date): boolean {
  return at.getUTCHours() === 8 && at.getUTCMinutes() === 0;
}

/**
 * A file's text, or a throw naming the file, so a run that couldn't compare publishes nothing and
 * its log says which read failed.
 */
export async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  let answer: Response;
  try {
    answer = await fetch(url, { signal });
  } catch (error) {
    throw new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
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
  // One deadline for every read, the protocol section's, so a slow GitHub ends the section inside
  // the function's 60 s timeout and its failure is logged.
  const signal = AbortSignal.timeout(PROTOCOL_DEADLINE_MS);
  const pins = (await deps.fetchText(OUR_PIN_URL, signal)).match(/[0-9a-f]{40}/g) ?? [];
  if (pins.length !== 1)
    throw new Error(`expected one commit in ${OUR_PIN_URL}, found ${pins.length}`);
  const pin = pins[0]!;
  const perFile = await Promise.all(
    FILES.map(async (path) => {
      const [atPin, onMain] = await Promise.all([
        deps.fetchText(`${UPSTREAM_RAW}/${pin}/${path}`, signal),
        deps.fetchText(`${UPSTREAM_RAW}/main/${path}`, signal),
      ]);
      return atPin === onMain ? [] : [path];
    }),
  );
  const changed = perFile.flat();
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
