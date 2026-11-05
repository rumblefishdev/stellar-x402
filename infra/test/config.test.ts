import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ALARM_GROUPS, type EnvironmentConfig, validateConfig } from "../src/lib/config.js";
import { INFRA_ROOT } from "../src/lib/names.js";
import { production } from "./fixtures.js";

const invalid = (change: (c: EnvironmentConfig) => unknown) => {
  const c = production() as unknown as Record<string, unknown>;
  change(c as unknown as EnvironmentConfig);
  return () => validateConfig(c as unknown as EnvironmentConfig);
};
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const m = (c: EnvironmentConfig) => c as Mutable<EnvironmentConfig>;

describe("envs/production.json", () => {
  test("validates", () => {
    expect(() => validateConfig(production())).not.toThrow();
  });

  test("serves testnet only, for now", () => {
    expect(production().networks).toEqual(["stellar:testnet"]);
  });

  test("starts with the EMF error alarms on, the rest off until their series exist (26, 37)", () => {
    const on = Object.entries(production().alarmGroups)
      .filter(([, v]) => v)
      .map(([g]) => g);
    expect(on).toEqual(["telemetry"]);
  });

  test("names the fee account /supported shows as the signer", () => {
    expect(production().feeAccounts).toEqual({
      "stellar:testnet": "GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP",
    });
  });

  test("names every group", () => {
    expect(Object.keys(production().alarmGroups).sort()).toEqual([...ALARM_GROUPS].sort());
  });
});

describe("validateConfig", () => {
  test.each<[string, (c: EnvironmentConfig) => unknown, RegExp]>([
    ["an unknown network", (c) => (m(c).networks = ["stellar:futurenet" as never]), /networks/],
    ["no network", (c) => (m(c).networks = []), /at least one/],
    ["a network twice", (c) => (m(c).networks = ["stellar:testnet", "stellar:testnet"]), /twice/],
    ["a bad CN", (c) => (m(c).logging.certificateCn = "X402 Agent"), /certificateCn/],
    [
      "a CA path outside infra/",
      (c) => (m(c).logging.trustAnchorCertificate = "../ca.crt"),
      /trustAnchor/,
    ],
    ["a relative SSM name", (c) => (m(c).logging.serverIpSsmParam = "x402/ip"), /serverIpSsmParam/],
    [
      "a session past Roles Anywhere's 12 h",
      (c) => (m(c).logging.sessionHours = 13),
      /sessionHours/,
    ],
    ["an http uptime URL", (c) => (m(c).uptime.url = "http://example.com/health"), /uptime.url/],
    [
      "a Slack ID in place of its SSM name",
      (c) => (m(c).slack.channelIdSsmParam = "C012345"),
      /slack/,
    ],
    [
      "a group left out",
      (c) => delete (m(c).alarmGroups as Partial<Record<string, boolean>>).host,
      /alarmGroups.host/,
    ],
    [
      "an unknown group",
      (c) => ((m(c).alarmGroups as Record<string, boolean>)["cpu"] = false),
      /cpu is not a group/,
    ],
    ["a zero threshold", (c) => (m(c).thresholds.pendingSeconds = 0), /pendingSeconds/],
    ["a percentage over 100", (c) => (m(c).thresholds.auditDiskUsedPercent = 101), /percentage/],
    ["a fractional count", (c) => (m(c).thresholds.sequenceResyncCount = 2.5), /integer/],
    [
      "a null threshold that has no measure step",
      (c) => (m(c).thresholds.walStaleSeconds = null as never),
      /walStaleSeconds/,
    ],
    [
      "a flap count at uptime's run",
      (c) => (m(c).thresholds.uptimeFlapFailingMinutes = 7),
      /uptimeFlapFailingMinutes/,
    ],
    [
      "a flap count at its window",
      (c) => (m(c).thresholds.uptimeFlapFailingMinutes = 30),
      /uptimeFlapFailingMinutes/,
    ],
    [
      "critical not below low",
      (c) => (m(c).thresholds.balanceCriticalStroops = 250_000_000),
      /below balanceLow/,
    ],
    [
      "an unknown threshold",
      (c) => ((m(c).thresholds as Record<string, number>)["cpu"] = 1),
      /cpu is not a threshold/,
    ],
    ["disk on with no threshold", (c) => (m(c).alarmGroups.disk = true), /alarmGroups.disk/],
    ["memory on with no threshold", (c) => (m(c).alarmGroups.memory = true), /alarmGroups.memory/],
    [
      "log volume on with no threshold",
      (c) => (m(c).alarmGroups.logVolume = true),
      /alarmGroups.logVolume/,
    ],
    [
      "host on with no audit mount",
      (c) => {
        m(c).alarmGroups.host = true;
        m(c).host = { ...m(c).host, auditDiskMount: null };
      },
      /auditDiskMount/,
    ],
    [
      "a network with no fee account",
      (c) => delete (m(c).feeAccounts as Partial<Record<string, string>>)["stellar:testnet"],
      /feeAccounts.stellar:testnet/,
    ],
    [
      "a fee account whose checksum fails",
      (c) =>
        ((m(c).feeAccounts as Record<string, string>)["stellar:testnet"] =
          "GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRQ"),
      /feeAccounts.stellar:testnet/,
    ],
    [
      "a fee account's secret key",
      (c) =>
        ((m(c).feeAccounts as Record<string, string>)["stellar:testnet"] =
          "SAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP"),
      /feeAccounts.stellar:testnet/,
    ],
    [
      "a fee account for a network not served",
      (c) =>
        ((m(c).feeAccounts as Record<string, string>)["stellar:pubnet"] =
          "GCW5TAO7CB6FDNXLMZJZHQKKKGDBEAXMOGGYO2MCI2WXMKNGFWLLG7VY"),
      /feeAccounts.stellar:pubnet is not in networks/,
    ],
  ])("refuses %s", (_, change, message) => {
    expect(invalid(change)).toThrow(message);
  });

  test("reports every problem at once", () => {
    const run = invalid((c) => {
      m(c).networks = [];
      m(c).thresholds.pendingSeconds = -1;
    });
    expect(run).toThrow(/networks[\s\S]*pendingSeconds/);
  });

  test("lets disk on once its threshold and mounts are set", () => {
    const c = m(production());
    c.alarmGroups.disk = true;
    c.thresholds.diskUsedPercent = 80;
    c.host.diskMounts = ["/"];
    expect(() => validateConfig(c)).not.toThrow();
  });
});

describe("the trust anchor's CA (decision 29)", () => {
  const pem = readFileSync(join(INFRA_ROOT, production().logging.trustAnchorCertificate), "utf8");
  const ca = new X509Certificate(pem);

  test("is the ClickHouse project's client CA", () => {
    expect(ca.subject).toBe("O=Soroban\nCN=soroban-internal-ca-2026");
    expect(ca.issuer).toBe(ca.subject);
  });

  test("is a CA, as Roles Anywhere requires of an anchor", () => {
    expect(ca.ca).toBe(true);
    expect(ca.verify(ca.publicKey)).toBe(true);
  });

  test("has a year left at least, so a rotation is planned rather than found", () => {
    const yearAhead = Date.now() + 365 * 24 * 3600 * 1000;
    expect(new Date(ca.validTo).getTime()).toBeGreaterThan(yearAhead);
  });

  test("is one certificate, no key", () => {
    expect(pem.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
    expect(pem).not.toMatch(/PRIVATE KEY/);
  });
});
