// The fixed names of what the stacks create (0027 decision 24). Stacks never pass resources to each
// other (decision 27): an alarm finds a log group or a function by these names.
import type { StellarNetwork } from "@stellar-x402/config";
import { fileURLToPath } from "node:url";

/** `infra/`, from `src/lib/` or `dist/lib/` alike. */
export const INFRA_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const stackPrefix = (envName: string) => `X402-${envName}`;

export const names = (envName: string) => ({
  /** App lines of our units: the facilitator, Postgres, `cloudflared`, OpenBao, the deploy. */
  appLogGroup: `/x402/${envName}/app`,
  /** EMF lines, which CloudWatch turns into metrics. */
  metricsLogGroup: `/x402/${envName}/metrics`,
  loggingRole: `x402-${envName}-logging`,
  trustAnchor: `x402-${envName}-logging`,
  rolesAnywhereProfile: `x402-${envName}-logging`,
  alarmTopic: `x402-${envName}-alarms`,
  slackChannel: `x402-${envName}-alarms`,
  uptimeProbe: `x402-${envName}-uptime-probe`,
  /** #115's off-server check: the `watch-*` alarms read `AWS/Lambda` by this name. */
  watchFunction: `x402-${envName}-watch`,
});

/** `stellar:testnet` -> `testnet`: the suffix of a network-scoped alarm's name. */
export function networkSuffix(network: StellarNetwork): string {
  const short = network.split(":")[1];
  if (!short) throw new Error(`not a CAIP-2 network: ${network}`);
  return short;
}
