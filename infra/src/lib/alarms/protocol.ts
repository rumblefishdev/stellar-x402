// G-alarm-list, "Protocol" (decision 70): the off-server check reads each network's ledger
// protocol and the highest one the Stellar Core behind its Horizon supports every 5 minutes, served
// network or not. On 2026-11-03 testnet moved to protocol 30 and an older SDK stopped reading its
// ledgers; no alarm saw it. `Maximum`, so a forged lower point from the server can't hide a real
// higher one (G-alarm-list, "Statistics").
import type { EnvironmentConfig } from "../config.js";
import type { AlarmFactory } from "./factory.js";

const NO_DATA = "Keeps its state; watch-errors and watch-no-invocations cover the check.";

export function addProtocolAlarms(f: AlarmFactory, c: EnvironmentConfig): void {
  for (const [key, watched] of Object.entries(c.watch.protocol)) {
    const network = key as keyof typeof c.watch.protocol;
    const { expected, supported } = watched!;
    const config = `watch.protocol in infra/envs/${c.envName}.json`;

    f.level("protocol-changed", {
      group: "protocol",
      network,
      signal: { catalog: "protocol_version", dims: { network } },
      statistic: "Maximum",
      // 2 of 2: one odd answer from a node behind the balancer doesn't page on its own. A lagging
      // node shows the old version, which can't breach; it only delays the alarm by a period.
      periodMinutes: 5,
      periods: 2,
      comparison: ">",
      threshold: expected,
      description: {
        what: `${network}'s ledger protocol is above ${expected}, the version we have checked: the network upgraded. On 2026-11-03 testnet's move to 30 left an older SDK unable to read ledgers.`,
        next: `On a network we serve, check that /verify and /settle still work. Check that @stellar/stellar-sdk and the RPC support the new version; then raise expected for ${network} in ${config} in a PR, and supported with it if it is lower, and deploy the alarms.`,
        noData: NO_DATA,
      },
    });

    f.level("protocol-upgrade-coming", {
      group: "protocol",
      network,
      signal: { catalog: "protocol_supported_version", dims: { network } },
      statistic: "Maximum",
      // 2 of 2: during a rolling Core upgrade, Horizon nodes behind the balancer differ.
      periodMinutes: 5,
      periods: 2,
      comparison: ">",
      threshold: supported,
      description: {
        what: `The Stellar Core behind ${network}'s Horizon supports a protocol above ${supported}, the highest we have checked: the validators can vote the upgrade once enough of them run it.`,
        next: `Find the upgrade's date in Stellar's announcements and plan a test of the SDK and the RPC against the new version on testnet before it reaches ${network}; then raise supported for ${network} in ${config} in a PR. protocol-changed fires on the upgrade itself.`,
        noData: NO_DATA,
      },
    });
  }
}
