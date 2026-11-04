// G-alarm-list, "Availability".
import type { EnvironmentConfig } from "../config.js";
import type { AlarmFactory } from "./factory.js";

const FACILITATOR_SILENT = "Keeps its state; facilitator-silent covers a stopped process.";

export function addAvailabilityAlarms(f: AlarmFactory, c: EnvironmentConfig): void {
  const t = c.thresholds;
  f.level("uptime", {
    group: "uptime",
    signal: { catalog: "ready" },
    statistic: "Minimum",
    periodMinutes: 1,
    periods: t.uptimeFailingMinutes,
    comparison: "<",
    threshold: 1,
    // A missing point counts as down (decision 5): a broken probe alarms rather than going quiet.
    missing: "breaching",
    description: {
      what: `The facilitator was not ready to settle for ${t.uptimeFailingMinutes} minutes in a row, as the uptime probe reads ${c.uptime.url} through Cloudflare: the process is down or in a crash loop, it holds no lease, or the tunnel or Cloudflare is failing. A deploy's usual downtime stays under this window.`,
      next: `Open the URL, then on the server check x402@${c.envName} (systemctl status, journalctl) and the tunnel; the probe's own log names what it read.`,
      noData:
        "A missing point counts as down, so a probe that stops publishing fires this too: the probe, its schedule or eu-central-1 may be the fault.",
    },
  });

  for (const network of c.networks) {
    f.level("rpc-stalled", {
      group: "facilitator",
      network,
      signal: { catalog: "rpc_stalled_seconds", dims: { network } },
      statistic: "Maximum",
      periodMinutes: 1,
      periods: 5,
      comparison: ">",
      threshold: t.rpcStalledSeconds,
      description: {
        what: `The latest ledger on ${network}, read through the facilitator's RPC, has not moved for over ${t.rpcStalledSeconds} s for 5 minutes: the active endpoint is frozen or unreachable, and verify and settle read stale state. ready does not show this.`,
        next: "Read rpc_failover and rpc_failback in the app logs and check the endpoints in RPC_URLS by their RPC_URLS[i]#fingerprint names; fix or reorder them.",
        noData: FACILITATOR_SILENT,
      },
    });

    f.level("balance-stale", {
      group: "facilitator",
      network,
      signal: { catalog: "balance_reading_age_seconds", dims: { network } },
      statistic: "Maximum",
      periodMinutes: 1,
      periods: 1,
      comparison: ">",
      threshold: t.balanceStaleSeconds,
      description: {
        what: `The fee account's last good balance reading on ${network} is older than ${t.balanceStaleSeconds} s: the balance floor fails closed and settle refuses every payment with facilitator_underfunded, while ready stays 1 and the balance read off the server looks fine.`,
        next: "Check the RPC (rpc-stalled, rpc-on-fallback) and the floor's failed reads in the app logs; a floor bound other than 300 s logs balance_stale_threshold_mismatch at startup.",
        noData: FACILITATOR_SILENT,
      },
    });
  }
}
