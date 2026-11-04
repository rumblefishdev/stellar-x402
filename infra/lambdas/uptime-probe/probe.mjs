// @ts-check
// The uptime probe's logic (0027 decision 5), apart from the AWS SDK so tests run it with a fake
// fetch. Every minute it reads /health through the public hostname and publishes `ready`: 1 only
// when the answer is a 200 whose JSON body says `"ready": true`, 0 for anything else (a 502 before
// the first deploy, a timeout, a body it can't parse). The uptime alarm also treats a missing
// point as down, so a probe that fails to publish alarms too.

/** `x402-watch` `ready` in @stellar-x402/metrics-catalog: process-scoped, unit None. */
export const NAMESPACE = "x402-watch";
export const METRIC = "ready";
export const UNIT = "None";

/** Below the function's 30 s timeout, with room left to publish. */
export const TIMEOUT_MS = 10_000;

/**
 * @typedef {{ ready: 0 | 1, reason: string }} Reading
 * @typedef {(url: string, init: RequestInit) => Promise<Response>} Fetch
 */

/**
 * Reads `ready` from `/health`. Never throws: any failure reads as 0, with the reason.
 * @param {{ url: string, fetch: Fetch, timeoutMs?: number }} opts
 * @returns {Promise<Reading>}
 */
export async function readReady({ url, fetch, timeoutMs = TIMEOUT_MS }) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect isn't the facilitator answering: read it as down.
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
    const ready =
      body !== null && typeof body === "object"
        ? /** @type {{ ready?: unknown }} */ (body).ready
        : undefined;
    if (ready === true) return { ready: 1, reason: "ready" };
    return { ready: 0, reason: `ready is ${JSON.stringify(ready)}` };
  } catch (error) {
    const e = /** @type {{ name?: string, message?: string }} */ (error);
    return { ready: 0, reason: `${e?.name ?? "Error"}: ${e?.message ?? String(error)}` };
  }
}

/**
 * The `PutMetricData` input for one reading: no dimensions, the catalog's unit.
 * @param {0 | 1} ready
 * @param {Date} at
 */
export function readyMetricData(ready, at) {
  return {
    Namespace: NAMESPACE,
    MetricData: [{ MetricName: METRIC, Value: ready, Unit: UNIT, Timestamp: at }],
  };
}

/**
 * One run: read, log, publish. A failed publish throws, so the run fails and the point is missing,
 * which the uptime alarm counts as down.
 * @param {{
 *   url: string,
 *   fetch: Fetch,
 *   publish: (input: ReturnType<typeof readyMetricData>) => Promise<unknown>,
 *   log: (line: Record<string, unknown>) => void,
 *   now?: () => Date,
 *   timeoutMs?: number,
 * }} deps
 * @returns {Promise<Reading>}
 */
export async function runProbe({ url, fetch, publish, log, now = () => new Date(), timeoutMs }) {
  // Stamped when the run starts: a read that takes its full 10 s must still count for the
  // minute it was scheduled in, or one minute gets no point (down) and the next gets two.
  const at = now();
  const reading = await readReady({ url, fetch, timeoutMs });
  log({ msg: "uptime_probe", url, ready: reading.ready, reason: reading.reason });
  await publish(readyMetricData(reading.ready, at));
  return reading;
}
