// The off-server check's protocol section (0027 decision 70): every 5 minutes it reads Horizon's
// root for each network in `watch.protocol`, served or not, and publishes the ledger's protocol
// (`current_protocol_version`) and the highest one the Stellar Core behind that Horizon supports
// (`core_supported_protocol_version`) to `x402-watch`. `protocol-changed` and
// `protocol-upgrade-coming` compare them with the version we run against, which lives in the
// alarms, not here. A network whose read fails publishes nothing; the run throws for watch-errors.
import type { StellarNetwork } from "@stellar-x402/config";
import type { PutMetricDataInput } from "./balance.js";
import { describeError } from "./errors.js";
import { NAMESPACE } from "./metric.js";

export const CURRENT = "protocol_version" as const;
export const SUPPORTED = "protocol_supported_version" as const;

/** Below the function's timeout, with room left to publish. */
export const PROTOCOL_DEADLINE_MS = 30_000;

/** One network whose protocol the check reads. */
export interface ProtocolTarget {
  readonly network: StellarNetwork;
  readonly horizonUrl: string;
}

export interface ProtocolReading {
  readonly network: StellarNetwork;
  readonly current: number;
  readonly supported: number;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProtocolDeps {
  readonly targets: readonly ProtocolTarget[];
  readonly fetch: Fetch;
  readonly publish: (input: PutMetricDataInput) => Promise<unknown>;
  readonly log: (line: Record<string, unknown>) => void;
  readonly at: Date;
  readonly deadlineMs?: number;
}

const isVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Reads one Horizon's root; throws on anything but a 200 with both versions as integers. */
export async function readProtocol(
  target: ProtocolTarget,
  fetch: Fetch,
  deadlineMs = PROTOCOL_DEADLINE_MS,
): Promise<ProtocolReading> {
  const res = await fetch(target.horizonUrl, {
    signal: AbortSignal.timeout(deadlineMs),
    headers: { accept: "application/json", "user-agent": "x402-watch" },
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`status ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown> | null;
  const current = body?.["current_protocol_version"];
  const supported = body?.["core_supported_protocol_version"];
  if (!isVersion(current) || !isVersion(supported))
    throw new Error(
      `no protocol versions in the answer (current ${JSON.stringify(current)}, supported ${JSON.stringify(supported)})`,
    );
  return { network: target.network, current, supported };
}

/** The `PutMetricData` input for the networks read: two points each, unit None. */
export function protocolMetricData(
  readings: readonly ProtocolReading[],
  at: Date,
): PutMetricDataInput {
  return {
    Namespace: NAMESPACE,
    MetricData: readings.flatMap((r) =>
      (
        [
          [CURRENT, r.current],
          [SUPPORTED, r.supported],
        ] as const
      ).map(([name, value]) => ({
        MetricName: name,
        Dimensions: [{ Name: "network", Value: r.network }],
        Value: value,
        Unit: "None",
        Timestamp: at,
      })),
    ),
  };
}

/**
 * One run of the section: read every network at once, publish the ones read, then throw if any
 * failed. A failed publish throws too.
 */
export async function runProtocol(deps: ProtocolDeps): Promise<void> {
  const results = await Promise.all(
    deps.targets.map(async (target) => {
      try {
        const reading = await readProtocol(target, deps.fetch, deps.deadlineMs);
        deps.log({ msg: "watch_protocol", ...reading });
        return reading;
      } catch (error) {
        const text = describeError(error, target.horizonUrl, `horizon(${target.network})`);
        deps.log({
          msg: "watch_section_failed",
          section: "protocol",
          network: target.network,
          error: text,
        });
        return { network: target.network, error: text };
      }
    }),
  );
  const read = results.filter((r): r is ProtocolReading => !("error" in r));
  if (read.length > 0) await deps.publish(protocolMetricData(read, deps.at));
  const failed = results.filter((r) => "error" in r);
  if (failed.length > 0)
    throw new Error(
      `protocol not read on ${failed.map((f) => `${f.network} (${"error" in f ? f.error : ""})`).join(", ")}`,
    );
}
