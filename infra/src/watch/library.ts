// The off-server check's library section (task 0147): once a day it asks whether the facilitator
// production runs asks for the `@x402/stellar` npm calls `latest`, and publishes 1 when it doesn't,
// 0 when it does, to `x402-watch` `upstream_library_behind`. The version is the one production
// runs: `/health` names its commit, and that commit's `package.json` names the range, so a bump
// merged but not deployed still shows. A read that fails publishes nothing, and the alarm reads the
// missing day as behind.
import type { PutMetricDataInput } from "./balance.js";
import { NAMESPACE } from "./metric.js";
import { PROTOCOL_DEADLINE_MS } from "./protocol.js";
import { OUR_RAW } from "./upstream.js";

export const HEALTH_ENV = "WATCH_HEALTH_URL";
export const PACKAGE_PATH = "apps/facilitator/package.json";
export const NPM_LATEST_URL = "https://registry.npmjs.org/@x402/stellar/latest";

/** `x402-watch` `upstream_library_behind` in @stellar-x402/metrics-catalog: no dimension, unit Count. */
export const LIBRARY_METRIC = "upstream_library_behind";

export interface LibraryDeps {
  readonly healthUrl: string;
  readonly fetchText: (url: string, signal: AbortSignal) => Promise<string>;
  readonly publish: (input: PutMetricDataInput) => Promise<unknown>;
  readonly log: (line: Record<string, unknown>) => void;
  readonly at: Date;
}

/**
 * One run of the section. A read that fails is logged as `watch_section_failed` like the other
 * sections and throws, so the run counts in `watch-errors`.
 */
export async function runLibrary(deps: LibraryDeps): Promise<void> {
  try {
    await compare(deps);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    deps.log({ msg: "watch_section_failed", section: "library", error: text });
    throw new Error(`library not read (${text})`, { cause: error });
  }
}

/** A body as JSON, or a throw naming the URL: a challenge page in place of JSON says where it came from. */
async function readJson(deps: LibraryDeps, url: string, signal: AbortSignal): Promise<unknown> {
  const text = await deps.fetchText(url, signal);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url} answered no JSON`, { cause: error });
  }
}

async function compare(deps: LibraryDeps): Promise<void> {
  // One deadline for every read, the protocol section's, inside the function's 60 s timeout.
  const signal = AbortSignal.timeout(PROTOCOL_DEADLINE_MS);

  const health = (await readJson(deps, deps.healthUrl, signal)) as { commit?: unknown };
  const commit = health.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error(`${deps.healthUrl} names no commit`);

  const packageUrl = `${OUR_RAW}/${commit}/${PACKAGE_PATH}`;
  const pkg = (await readJson(deps, packageUrl, signal)) as {
    dependencies?: Record<string, string>;
  };
  // AD-14 pins every @x402 package as `~X.Y.Z`; another shape is a change this read must hear of.
  const range = pkg.dependencies?.["@x402/stellar"];
  const pinned = /^~(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (!pinned) throw new Error(`${packageUrl} asks for @x402/stellar ${range}, not ~X.Y.Z`);
  const production = pinned[1]!;

  const npm = (await readJson(deps, NPM_LATEST_URL, signal)) as { version?: unknown };
  const latest = npm.version;
  if (typeof latest !== "string") throw new Error(`${NPM_LATEST_URL} names no version`);

  deps.log({ msg: "watch_library", commit, production, latest });
  await deps.publish({
    Namespace: NAMESPACE,
    MetricData: [
      {
        MetricName: LIBRARY_METRIC,
        Dimensions: [],
        Value: production === latest ? 0 : 1,
        Unit: "Count",
        Timestamp: deps.at,
      },
    ],
  });
}
