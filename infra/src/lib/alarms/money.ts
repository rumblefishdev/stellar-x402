// G-alarm-list, "Money and security": the off-server check's metrics (#115), every 5 minutes, so
// they fire with the server down. Built here, in the `watch` group, which goes on with #115's
// Lambda (decision 23). Root on the server can write into `x402-watch` too, so each alarm takes
// the statistic a forged point can't hide a real one behind: `Minimum` for a balance, `Maximum`
// for a count (G-alarm-list, "Statistics"). A forged point can still hold a theft alarm in ALARM,
// so #115's check posts each finding to the topic itself and these are its backstop (decision 64).
import type { EnvironmentConfig } from "../config.js";
import { names } from "../names.js";
import type { AlarmFactory } from "./factory.js";

const WATCH_SILENT = "Keeps its state; watch-errors and watch-no-invocations cover the check.";
const xlm = (stroops: number) => `${stroops / 10_000_000} XLM`;

export function addMoneyAlarms(f: AlarmFactory, c: EnvironmentConfig): void {
  const t = c.thresholds;
  const n = names(c.envName);

  for (const network of c.networks) {
    // validateConfig refuses a served network without one.
    const account = c.feeAccounts[network]!;
    const topUp = `Top up ${account} as in docs/runbook.md, Topping up the fee account.`;

    f.level("balance-low", {
      group: "watch",
      network,
      signal: { catalog: "spendable_stroops", dims: { network } },
      statistic: "Minimum",
      periodMinutes: 5,
      periods: 1,
      comparison: "<",
      threshold: t.balanceLowStroops,
      description: {
        what: `The fee account ${account}'s spendable balance on ${network} is below ${xlm(t.balanceLowStroops)}, about 5 days before the floor stops settlement at 1,000 settlements a day (ADR 0013).`,
        next: `${topUp} The alarm's value is the balance in stroops.`,
        noData: WATCH_SILENT,
      },
    });

    f.level("balance-critical", {
      group: "watch",
      network,
      signal: { catalog: "spendable_stroops", dims: { network } },
      statistic: "Minimum",
      periodMinutes: 5,
      periods: 1,
      comparison: "<",
      threshold: t.balanceCriticalStroops,
      description: {
        what: `The fee account ${account}'s spendable balance on ${network} is below ${xlm(t.balanceCriticalStroops)}, about a day before the floor stops settlement.`,
        next: `${topUp} Do it now. The alarm's value is the balance in stroops. If balance-low didn't fire first, the balance dropped at once: check account-effects.`,
        noData: WATCH_SILENT,
      },
    });

    f.level("account-state", {
      group: "watch",
      network,
      signal: { catalog: "account_state_mismatches", dims: { network } },
      statistic: "Maximum",
      periodMinutes: 5,
      periods: 2,
      comparison: ">=",
      threshold: 1,
      description: {
        what: `On ${network}, the signers or a threshold of the fee account or a channel differ from the declared set, or an account is gone, in 2 reads in a row: a theft, or a key rotation or channel setup made before the declared set changed. One alarm covers every account, so while it is in ALARM another account's change sends nothing new.`,
        next: "If no one is rotating keys or setting up channels, treat it as a theft of the facilitator key (ADR 0013). The check's log names the account.",
        noData: WATCH_SILENT,
      },
    });

    f.event("account-effects", {
      group: "watch",
      network,
      signal: { catalog: "account_effects_unexpected", dims: { network } },
      statistic: "Maximum",
      periodMinutes: 5,
      periods: 3,
      description: {
        what: `An effect other than account_credited or a claimable balance naming us reached the fee account or a channel on ${network}: funds or signers may have moved without a settlement.`,
        next: "Read the check's log for the account and the effect, then Horizon; if no one on the team caused it, treat it as a theft of the facilitator key (ADR 0013).",
        noData:
          "Nothing was seen; after a gap the check reads every effect it missed. watch-errors and watch-no-invocations cover the check.",
      },
    });
  }

  f.event("backup-secret-read", {
    group: "watch",
    signal: { catalog: "backup_secret_reads" },
    statistic: "Maximum",
    periodMinutes: 5,
    periods: 3,
    description: {
      what: `Someone read x402/${c.envName}/openbao-backup in Secrets Manager (CloudTrail, about 15 minutes late): a drill, or anyone with access to the OpenBao recovery key.`,
      next: "Ask in the channel who read it; if no one owns the read, treat the backup and its recovery key as exposed (ADR 0013).",
      noData:
        "Nothing was read; after a gap the check reads the hour before its last full read. watch-errors and watch-no-invocations cover the check.",
    },
  });

  f.level("watch-errors", {
    group: "watch",
    signal: { aws: "AWS/Lambda", metric: "Errors", dims: { FunctionName: n.watchFunction } },
    statistic: "Sum",
    periodMinutes: 5,
    periods: 3,
    datapoints: 2,
    comparison: ">=",
    threshold: 1,
    description: {
      what: "The off-server check failed in 2 of its last 3 runs: a balance, an account check or the secret reads were not published.",
      next: `Read the ${n.watchFunction} log for the section that threw; the others published before it.`,
      noData: "Keeps its state; watch-no-invocations covers runs that don't happen.",
    },
  });

  f.silence("watch-no-invocations", {
    group: "watch",
    signal: { aws: "AWS/Lambda", metric: "Invocations", dims: { FunctionName: n.watchFunction } },
    description: {
      what: "The off-server check has not run for 15 minutes, so the balance, theft and secret-read alarms see nothing.",
      next: `Check ${n.watchFunction} and its schedule in the Watch stack.`,
      noData: "Breaching: no runs is what this alarm is for.",
    },
  });
}
