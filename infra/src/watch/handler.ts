// The off-server check's handler logic (0027 decision 7), apart from the AWS SDK so tests run it
// with fakes: lambdas/watch/index.mjs only builds the CloudWatch client and passes it in.
import { rpc } from "@stellar/stellar-sdk";
import { type BalanceDeps, runBalance } from "./balance.js";
import { runProtocol } from "./protocol.js";
import { PROTOCOL_ENV, TARGETS_ENV, parseProtocolTargets, parseTargets } from "./targets.js";
import { type UpstreamDeps, fetchText, runUpstream } from "./upstream.js";

/** The schedule's input (watch-stack.ts): its scheduled time, `<aws.scheduler.scheduled-time>`. */
export interface WatchEvent {
  readonly scheduledTime?: string;
}

/**
 * The run's time: the scheduled one, so each point lands in its own 5-minute slot of the balance
 * alarms however late the run starts; now for a run by hand, or a time that doesn't parse.
 */
export function scheduledAt(event: WatchEvent | null | undefined, now: () => Date): Date {
  const scheduled = event?.scheduledTime ? new Date(event.scheduledTime) : undefined;
  return scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled : now();
}

/** Stellar RPC for a URL, as the facilitator builds it (https only: parseTargets checks it). */
export const stellarRpc = (url: string) => new rpc.Server(url);

export interface HandlerDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly publish: BalanceDeps["publish"];
  readonly log?: BalanceDeps["log"];
  readonly rpcFor?: BalanceDeps["rpcFor"];
  /** Horizon's root, for the protocol section; `globalThis.fetch` by default. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Upstream x402's files, for the upstream section; a plain GET by default. */
  readonly fetchText?: UpstreamDeps["fetchText"];
  readonly now?: () => Date;
}

/**
 * The Lambda handler: reads its targets and builds one RPC client per URL once, at the start, so
 * a warm container reuses its connections. Each run reads the balance and protocol sections at
 * once, and the run on the hour the upstream section too: upstream changes far slower. One that
 * fails doesn't stop the others from publishing, and the run then throws for `watch-errors`. It
 * resolves to nothing: the runtime serializes a handler's result as JSON, and the sections' results hold
 * bigints, so returning them failed every run with "Unable to stringify response body".
 */
export function createHandler(deps: HandlerDeps): (event?: WatchEvent | null) => Promise<void> {
  const targets = parseTargets(deps.env[TARGETS_ENV]);
  const protocolTargets = parseProtocolTargets(deps.env[PROTOCOL_ENV]);
  const build = deps.rpcFor ?? stellarRpc;
  const clients = new Map(targets.map((t) => [t.rpcUrl, build(t.rpcUrl)]));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  return async (event) => {
    const at = scheduledAt(event, now);
    const sections = await Promise.allSettled([
      runBalance({
        targets,
        rpcFor: (url) => clients.get(url) ?? build(url),
        publish: deps.publish,
        log,
        at,
      }),
      runProtocol({
        targets: protocolTargets,
        fetch: deps.fetch ?? ((url, init) => globalThis.fetch(url, init)),
        publish: deps.publish,
        log,
        at,
      }),
      ...(at.getUTCMinutes() === 0
        ? [runUpstream({ fetchText: deps.fetchText ?? fetchText, publish: deps.publish, log, at })]
        : []),
    ]);
    const failed = sections.flatMap((s) =>
      s.status === "rejected" ? [String((s.reason as Error)?.message ?? s.reason)] : [],
    );
    if (failed.length > 0) throw new Error(failed.join("; "));
  };
}
