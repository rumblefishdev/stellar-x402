// G-alarm-list, "Availability".
import type { EnvironmentConfig } from "../config.js";
import type { Alarms } from "./factory.js";

const FACILITATOR_SILENT = "Keeps its state; facilitator-silent covers a stopped process.";
const PROBE_STOPPED =
  "A missing point counts as down, so a probe that stops publishing fires this too: the probe, its schedule or eu-central-1 may be the fault.";

export function addAvailabilityAlarms(f: Alarms, c: EnvironmentConfig): void {
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
      what: `The facilitator was not ready to settle for ${t.uptimeFailingMinutes} minutes in a row, as the uptime probe reads ${c.uptime.url} through Cloudflare: the process is down or in a crash loop that stays down that long, it holds no lease, or the tunnel or Cloudflare is failing. A deploy's usual downtime stays under this window; uptime-flapping covers a loop that comes up in between.`,
      next: `Open the URL, then on the server check x402@${c.envName} (systemctl status, then /var/log/x402/${c.envName}/facilitator.log and facilitator.err.log) and the tunnel's cloudflared.log; the probe's own log names what it read.`,
      noData:
        "A missing point counts as down, so a probe that stops publishing fires this too: the probe, its schedule or eu-central-1 may be the fault.",
    },
  });

  // A crash loop that comes up for a minute between restarts never gives uptime its run of 7
  // (Karol's review of #114, point 4): count the failing minutes in a longer window instead.
  f.level("uptime-flapping", {
    group: "uptime",
    signal: { catalog: "ready" },
    statistic: "Minimum",
    periodMinutes: 1,
    periods: t.uptimeFlapWindowMinutes,
    datapoints: t.uptimeFlapFailingMinutes,
    comparison: "<",
    threshold: 1,
    missing: "breaching",
    description: {
      what: `The facilitator was not ready to settle in ${t.uptimeFlapFailingMinutes} of the last ${t.uptimeFlapWindowMinutes} minutes, as the uptime probe reads ${c.uptime.url}: it keeps going down and coming back, a crash loop, a lease that moves, or a tunnel that drops. One deploy stays under this count.`,
      next: `On the server: the restarts and how each ended in /var/log/x402/host/metrics.log (facilitator_failures_total, watchdog_restarts_total) and facilitator-failed's messages; then /var/log/x402/${c.envName}/cloudflared.log.`,
      noData:
        "A missing point counts as down, as for uptime, which fires too when the probe stops.",
    },
  });

  // The same probe on the portal's backend and on the API hub's backend (0106 decision 21), each
  // with its own metric and group, at uptime's run: a deploy of either takes seconds, not a drain.
  // No flapping alarm for them yet.
  f.level("portal-uptime", {
    group: "portalUptime",
    signal: { catalog: "portal_ready" },
    statistic: "Minimum",
    periodMinutes: 1,
    periods: t.uptimeFailingMinutes,
    comparison: "<",
    threshold: 1,
    missing: "breaching",
    description: {
      what: `The portal's backend, which issues, shows and revokes x402's API keys for the API hub, was not ready for ${t.uptimeFailingMinutes} minutes in a row, as its probe reads ${c.uptime.portalUrl} through Cloudflare: the process is down, its database doesn't answer, or the tunnel or Cloudflare is failing. The hub's x402 tab fails meanwhile; the facilitator doesn't need it.`,
      next: `Open the URL, then on the server check x402-portal@${c.envName} (systemctl status, then /var/log/x402/${c.envName}/portal.log) and cloudflared.log; the probe's log names what it read.`,
      noData: PROBE_STOPPED,
    },
  });

  f.level("hub-uptime", {
    group: "hubUptime",
    signal: { catalog: "hub_ready" },
    statistic: "Minimum",
    periodMinutes: 1,
    periods: t.uptimeFailingMinutes,
    comparison: "<",
    threshold: 1,
    missing: "breaching",
    description: {
      what: `The API hub's backend did not answer ${c.uptime.hubUrl} with a 200 and authenticated false for ${t.uptimeFailingMinutes} minutes in a row, read through the explorer's CloudFront as a browser reaches it: no member can sign in or use the x402 and Prices API tabs. The hub's Lambda, its URL or the distribution's route to it is failing.`,
      next: "Open the URL: a redirect or HTML is the distribution's (soroban-block-explorer infra), anything else the hub's backend, whose own alarms and logs are sorobanscan-api-portal's. The probe's log names what it read.",
      noData: PROBE_STOPPED,
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
        next: "Read rpc_failover in the app logs and check the endpoints in RPC_URLS by their RPC_URLS[i]#fingerprint names; fix or reorder them.",
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
