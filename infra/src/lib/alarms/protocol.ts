// G-alarm-list, "Protocol" (decision 70): the off-server check reads each network's ledger
// protocol and the highest one its Stellar Core supports from Horizon every 5 minutes, served
// network or not. On 2026-11-03 testnet moved to protocol 30 and an older SDK stopped reading its
// ledgers; no alarm saw it. `Maximum`, so a forged lower point from the server can't hide a real
// higher one (G-alarm-list, "Statistics").
import type { EnvironmentConfig } from "../config.js";
import type { AlarmFactory } from "./factory.js";

const NO_DATA = "Keeps its state; watch-errors and watch-no-invocations cover the check.";

export function addProtocolAlarms(f: AlarmFactory, c: EnvironmentConfig): void {
  for (const [key, watched] of Object.entries(c.watch.protocol)) {
    const network = key as keyof typeof c.watch.protocol;
    const { expected } = watched!;
    const raise = `then raise watch.protocol's expected for ${network} to the new version in infra/envs/${c.envName}.json in a PR and deploy the alarms`;

    f.level("protocol-changed", {
      group: "protocol",
      network,
      signal: { catalog: "protocol_version", dims: { network } },
      statistic: "Maximum",
      periodMinutes: 5,
      periods: 1,
      comparison: ">",
      threshold: expected,
      description: {
        what: `${network}'s ledger protocol is above ${expected}, the version we run against: the network upgraded. On 2026-11-03 testnet's move to 30 left an older SDK unable to read ledgers.`,
        next: `Check that /verify and /settle still work on ${network} and that @stellar/stellar-sdk and the RPC support the new version; ${raise}.`,
        noData: NO_DATA,
      },
    });

    f.level("protocol-upgrade-coming", {
      group: "protocol",
      network,
      signal: { catalog: "protocol_supported_version", dims: { network } },
      statistic: "Maximum",
      periodMinutes: 5,
      periods: 1,
      comparison: ">",
      threshold: expected,
      description: {
        what: `Stellar Core on ${network} supports a protocol above ${expected}, the version we run against: the validators can vote the upgrade at any time.`,
        next: `Find the upgrade's date in Stellar's announcements, and test the SDK and the RPC against the new version on testnet before it reaches ${network}. After the upgrade, protocol-changed fires too; ${raise}, which puts both back to OK.`,
        noData: NO_DATA,
      },
    });
  }
}
