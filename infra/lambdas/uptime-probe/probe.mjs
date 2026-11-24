// @ts-check
// The uptime probe's logic (0027 decision 5), apart from the AWS SDK so tests run it with a fake
// fetch. Every minute it reads one URL through its public hostname and publishes one metric: 1
// only when the answer is a 200 whose JSON body holds every field of its expectation, 0 for
// anything else (a 502 before the first deploy, a redirect, a timeout, a body it can't parse). Its
// alarm also treats a missing point as down, so a probe that fails to publish alarms too.
//
// One function per target, each with its own target (0106 decision 21): the facilitator's
// `/health` (`ready`, `{"ready":true}`), the portal backend's (`portal_ready`, the same), and the
// API hub's backend through the explorer's CloudFront (`hub_ready`, `{"authenticated":false}`:
// that distribution answers other paths 200 with the explorer's HTML, so a status proves nothing).

/** The catalog's `x402-watch` metrics a probe may publish: process-scoped, unit None. */
export const NAMESPACE = "x402-watch";
export const METRICS = /** @type {const} */ (["ready", "portal_ready", "hub_ready"]);
export const UNIT = "None";

/** Below the function's 30 s timeout, with room left to publish. */
export const TIMEOUT_MS = 10_000;

/**
 * @typedef {{ ready: 0 | 1, reason: string }} Reading
 * @typedef {(url: string, init: RequestInit) => Promise<Response>} Fetch
 * @typedef {string | number | boolean | null} Primitive
 * @typedef {Readonly<Record<string, Primitive>>} Expectation
 * @typedef {(typeof METRICS)[number]} Metric
 * @typedef {{ url: string, metric: Metric, expect: Expectation }} Target
 */

/**
 * Reads one answer. Never throws: any failure reads as 0, with the reason.
 * @param {{ url: string, expect: Expectation, fetch: Fetch, timeoutMs?: number }} opts
 * @returns {Promise<Reading>}
 */
export async function readReady({ url, expect, fetch, timeoutMs = TIMEOUT_MS }) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect isn't the service answering: read it as down.
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "x402-uptime-probe" },
    });
    if (res.status !== 200) {
      // Unread, the body would hold its socket open in a warm container.
      await res.body?.cancel();
      return { ready: 0, reason: `status ${res.status}` };
    }
    /** @type {unknown} */
    const body = await res.json();
    const fields =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? /** @type {Record<string, unknown>} */ (body)
        : {};
    for (const [key, want] of Object.entries(expect)) {
      const got = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (got !== want) return { ready: 0, reason: `${key} is ${JSON.stringify(got)}` };
    }
    return { ready: 1, reason: "ready" };
  } catch (error) {
    const e = /** @type {{ name?: string, message?: string }} */ (error);
    return { ready: 0, reason: `${e?.name ?? "Error"}: ${e?.message ?? String(error)}` };
  }
}

/**
 * The `PutMetricData` input for one reading: no dimensions, the catalog's unit.
 * @param {Metric} metric
 * @param {0 | 1} ready
 * @param {Date} at
 */
export function readyMetricData(metric, ready, at) {
  return {
    Namespace: NAMESPACE,
    MetricData: [{ MetricName: metric, Value: ready, Unit: UNIT, Timestamp: at }],
  };
}

/**
 * The target from the function's environment, which the Uptime stack sets: `HEALTH_URL`, `METRIC`
 * (one of {@link METRICS}) and `EXPECT`, a JSON object of the fields a ready answer holds, each a
 * string, number, boolean or null. Throws on anything else, so a bad setting fails every run and
 * the alarm reads the missing points as down rather than a wrong check as up.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {Target}
 */
export function targetFromEnv(env) {
  const url = env["HEALTH_URL"];
  if (!url) throw new Error("HEALTH_URL is not set");
  const metric = env["METRIC"];
  if (!METRICS.includes(/** @type {Metric} */ (metric)))
    throw new Error(`METRIC must be one of ${METRICS.join(", ")}, got: ${String(metric)}`);
  const raw = env["EXPECT"];
  if (!raw) throw new Error("EXPECT is not set");
  /** @type {unknown} */
  const expect = JSON.parse(raw);
  if (
    expect === null ||
    typeof expect !== "object" ||
    Array.isArray(expect) ||
    Object.keys(expect).length === 0 ||
    !Object.values(expect).every((v) => v === null || typeof v !== "object")
  )
    throw new Error(`EXPECT must be a JSON object of at least one plain field, got: ${raw}`);
  return {
    url,
    metric: /** @type {Metric} */ (metric),
    expect: /** @type {Expectation} */ (expect),
  };
}

/**
 * One run: read, log, publish. A failed publish throws, so the run fails and the point is missing,
 * which the alarm counts as down.
 * @param {Target & {
 *   fetch: Fetch,
 *   publish: (input: ReturnType<typeof readyMetricData>) => Promise<unknown>,
 *   log: (line: Record<string, unknown>) => void,
 *   now?: () => Date,
 *   timeoutMs?: number,
 * }} deps
 * @returns {Promise<Reading>}
 */
export async function runProbe({
  url,
  metric,
  expect,
  fetch,
  publish,
  log,
  now = () => new Date(),
  timeoutMs,
}) {
  // Stamped when the run starts: a read that takes its full 10 s must still count for the
  // minute it was scheduled in, or one minute gets no point (down) and the next gets two.
  const at = now();
  const reading = await readReady({ url, expect, fetch, timeoutMs });
  log({ msg: "uptime_probe", url, metric, ready: reading.ready, reason: reading.reason });
  await publish(readyMetricData(metric, reading.ready, at));
  return reading;
}
