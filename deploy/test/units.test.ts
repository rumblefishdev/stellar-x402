// The units and the rotation against the files table and each other (lore 0027 server-side spine:
// AD-2, AD-8, AD-9, AD-10, AD-13): every file is rotated by exactly one glob and the symlink by
// none, the probe writes where the agent reads, and the signing helper's unit has the settings
// whose absence would leave the agent without keys.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { absolute, FILES } from "./files.js";

const DEPLOY = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${DEPLOY}/${path}`, "utf8");
/** Exec lines may continue with a trailing backslash: joined, so a setting reads as one line. */
const unit = (name: string) => read(`systemd/${name}`).replace(/\\\n\s*/g, " ");
const settings = (text: string, key: string) =>
  [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!.trim());

/** A logrotate glob as a regex: `*` stays within one path segment. */
const globRe = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

describe("the rotation", () => {
  const conf = read("logrotate/x402-logs.conf");
  const globs = conf
    .split("\n")
    .filter((l) => l.startsWith("/"))
    .flatMap((l) => l.replace(/\s*\{\s*$/, "").split(/\s+/));

  test("rotates every file but the symlink with exactly one glob", () => {
    expect(globs.length).toBeGreaterThan(0);
    for (const row of FILES) {
      const hits = globs.filter((g) => globRe(g).test(absolute(row)));
      expect(hits, row.path).toHaveLength(row.symlinkTo ? 0 : 1);
    }
  });

  test("copies and truncates, bounded in size and count, its own state elsewhere", () => {
    for (const directive of [
      "copytruncate",
      "size 100M",
      "rotate 10",
      "compress",
      "delaycompress",
      "missingok",
      "notifempty",
    ])
      expect(conf).toMatch(new RegExp(`^\\s+${directive}$`, "m"));
    expect(conf).not.toMatch(/^\s+(create|su|postrotate)\b/m);
    const service = unit("x402-logrotate.service");
    expect(settings(service, "ExecStart")).toEqual([
      "/usr/sbin/logrotate --state /var/lib/x402-logrotate/status /etc/x402/logrotate.conf",
    ]);
  });
});

describe("the timers", () => {
  // Off the facilitator's EMF flush at :00, and the probe off the rotation.
  test.each([
    ["x402-host-probe", "*-*-* *:*:30"],
    ["x402-logrotate", "*:00/10:20"],
    ["x402-cloudwatch-credentials", "hourly"],
  ])("%s runs at %s, to the second, and its oneshot has a timeout", (name, calendar) => {
    const timer = unit(`${name}.timer`);
    expect(settings(timer, "OnCalendar")).toEqual([calendar]);
    expect(settings(timer, "AccuracySec")).toEqual(["1s"]);
    expect(settings(timer, "WantedBy")).toEqual(["timers.target"]);
    const service = unit(`${name}.service`);
    expect(settings(service, "Type")).toEqual(["oneshot"]);
    expect(settings(service, "TimeoutStartSec")).toHaveLength(1);
    // Started by the timer only, so the service has nothing to enable.
    expect(service).not.toMatch(/^\[Install\]/m);
  });

  test("the probe writes where the agent reads, and its unit doesn't redirect it", () => {
    const host = FILES.find((r) => r.stream === "host" && r.group === "metrics")!;
    expect(read("libexec/x402-host-probe")).toContain(`: "\${X402_HOST_EMF:=${absolute(host)}}"`);
    const service = unit("x402-host-probe.service");
    expect(service).not.toMatch(/^Standard(Output|Error)=/m);
    expect(settings(service, "ExecStart")).toEqual(["/usr/local/libexec/x402/x402-host-probe"]);
  });
});

describe("the signing helper's unit", () => {
  const service = unit("x402-cloudwatch-credentials.service");
  const exec = settings(service, "ExecStart")[0] ?? "";
  const flag = (name: string) => exec.match(new RegExp(`--${name} (\\S+)`))?.[1];

  test("asks once for a 12-hour session, under the agent's profile", () => {
    expect(exec).toMatch(/^\/usr\/local\/bin\/aws_signing_helper update --once /);
    expect(flag("session-duration")).toBe("43200");
    expect(flag("profile")).toBe("AmazonCloudWatchAgent");
    expect(read("cloudwatch-agent/common-config.toml")).toContain(
      'shared_credential_profile = "AmazonCloudWatchAgent"',
    );
  });

  test("writes the file the agent reads, kept between runs", () => {
    expect(settings(service, "Environment")).toContain(
      "AWS_SHARED_CREDENTIALS_FILE=/run/x402-cloudwatch/credentials",
    );
    expect(read("cloudwatch-agent/common-config.toml")).toContain(
      'shared_credential_file = "/run/x402-cloudwatch/credentials"',
    );
    expect(read("libexec/x402-host-probe")).toContain(
      ': "${X402_CREDENTIALS:=/run/x402-cloudwatch/credentials}"',
    );
    expect(settings(service, "RuntimeDirectory")).toEqual(["x402-cloudwatch"]);
    expect(settings(service, "RuntimeDirectoryMode")).toEqual(["0700"]);
    // `restart` or the default would remove the directory, and the keys, after every run.
    expect(settings(service, "RuntimeDirectoryPreserve")).toEqual(["yes"]);
    // With it, the hourly start would find the unit active and do nothing.
    expect(service).not.toMatch(/^RemainAfterExit=/m);
  });

  test("runs as cwagent, with the key only through systemd's credentials", () => {
    expect(settings(service, "User")).toEqual(["cwagent"]);
    expect(settings(service, "LoadCredentialEncrypted")).toEqual([
      "cloudwatch-agent-key:/srv/x402/production/creds/cloudwatch-agent-key.cred",
    ]);
    expect(flag("private-key")).toBe("%d/cloudwatch-agent-key");
  });

  test("reads the one certificate path the probe watches", () => {
    expect(flag("certificate")).toBe("/srv/x402/production/cloudwatch-agent.crt");
    expect(read("libexec/x402-host-probe")).toContain(`: "\${X402_CERT:=${flag("certificate")}}"`);
  });

  test("waits for the network, and retries a failed run", () => {
    expect(settings(service, "Wants")).toContain("network-online.target");
    expect(settings(service, "After")).toContain("network-online.target");
    expect(settings(service, "Restart")).toEqual(["on-failure"]);
    expect(settings(service, "RestartSec")).toEqual(["60s"]);
  });

  test("talks to the standard regional endpoint, with the ARNs from the playbook's file", () => {
    expect(flag("endpoint")).toBe("https://rolesanywhere.eu-central-1.amazonaws.com");
    expect(settings(service, "EnvironmentFile")).toEqual(["/etc/x402/cloudwatch-credentials.env"]);
    for (const [f, v] of [
      ["trust-anchor-arn", "${TRUST_ANCHOR_ARN}"],
      ["profile-arn", "${PROFILE_ARN}"],
      ["role-arn", "${ROLE_ARN}"],
    ])
      expect(flag(f!), f).toBe(v);
  });

  test("the agent waits for its first run at boot, and nothing waits for the agent", () => {
    const dropIn = unit("amazon-cloudwatch-agent.service.d/x402.conf");
    expect(settings(dropIn, "Wants")).toEqual(["x402-cloudwatch-credentials.service"]);
    expect(settings(dropIn, "After")).toEqual(["x402-cloudwatch-credentials.service"]);
    expect(dropIn).not.toMatch(/^(Environment|User|ExecStart)=/m);
    for (const file of readdirSync(`${DEPLOY}/systemd`).filter((f) => /\.(service|timer)$/.test(f)))
      for (const key of ["Requires", "Requisite", "BindsTo", "PartOf", "After", "Wants"])
        for (const value of settings(unit(file), key))
          expect(value, `${file} ${key}`).not.toMatch(/amazon-cloudwatch-agent/);
  });
});

// The dual-stack endpoints have AAAA records, and IPv6 would leave from an address the role's
// aws:SourceIp refuses (AD-8).
test("nothing under deploy/ points AWS at a dual-stack or overridden endpoint", () => {
  const files = (dir: string): string[] =>
    readdirSync(`${DEPLOY}/${dir}`, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? ["node_modules", "test"].includes(e.name)
          ? []
          : files(`${dir}${e.name}/`)
        : [`${dir}${e.name}`],
    );
  for (const file of files("")) {
    const text = read(file);
    expect(text, file).not.toMatch(/api\.aws|endpoint_override|AWS_ENDPOINT_URL/);
    expect(text, file).not.toMatch(/dualstack[^\n]*(true|=\s*1)/i);
  }
});
