// The units and the rotation against the files table and each other (lore 0027 server-side spine:
// AD-2, AD-8, AD-9, AD-10, AD-13): every file is rotated by exactly one glob and the symlink by
// none, the probe writes where the agent reads, and the signing helper's unit has the settings
// whose absence would leave the agent without keys.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { byName } from "@stellar-x402/metrics-catalog";
import { describe, expect, test } from "vitest";
import { absolute, ENV, FILES } from "./files.js";

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
    ["x402-openbao-snapshot", "*-*-* 03:15:00 UTC"],
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

describe("the units' output", () => {
  const services = readdirSync(`${DEPLOY}/systemd`).filter((f) => f.endsWith(".service"));
  /** Each unit's append: paths, with %i as the environment. */
  const appends = (file: string) =>
    [...unit(file).matchAll(/^Standard(Output|Error)=append:(.*)$/gm)].map((m) =>
      m[2]!.trim().replaceAll("%i", ENV),
    );
  const writers: Record<string, string> = {
    "x402@.service": "facilitator",
    "x402-db-testnet@.service": "postgres-testnet",
    "x402-tunnel@.service": "cloudflared",
    "x402-openbao.service": "openbao",
    "x402-deploy@.service": "deploy",
  };

  test("every file a unit appends to is a row, and every unit's row has its unit", () => {
    const rows = new Set(FILES.map(absolute));
    for (const file of services)
      for (const path of appends(file)) expect(rows.has(path), `${file}: ${path}`).toBe(true);
    for (const [file, stream] of Object.entries(writers)) {
      const mine = FILES.filter((r) => r.group === "app" && r.stream === stream).map(absolute);
      expect(appends(file), file).toEqual(expect.arrayContaining(mine));
    }
  });

  test("only the facilitator splits stdout and stderr; the others write both in order", () => {
    expect(appends("x402@.service")).toEqual([
      `/var/log/x402/${ENV}/facilitator.log`,
      `/var/log/x402/${ENV}/facilitator.err.log`,
    ]);
    for (const file of Object.keys(writers).filter((f) => f !== "x402@.service")) {
      expect(appends(file), file).toHaveLength(1);
      expect(settings(unit(file), "StandardError"), file).toEqual(["inherit"]);
    }
  });

  test("every docker compose up writes raw lines", () => {
    for (const file of Object.keys(writers).filter((f) => f !== "x402-deploy@.service")) {
      const ups = settings(unit(file), "ExecStart").filter((e) => / up /.test(e));
      expect(ups, file).toHaveLength(1);
      expect(ups[0], file).toMatch(/ up --no-log-prefix --no-color /);
    }
  });

  // An Exec line that prints into a full disk fails, and with it the start (the spike).
  test("the wait loops print nothing", () => {
    for (const file of ["x402-db-testnet@.service", "x402-openbao.service"])
      for (const post of settings(unit(file), "ExecStartPost"))
        expect(post, file).toMatch(/exec -T [^;]*> \/dev\/null 2>&1;/);
  });

  test("no unit re-owns a shared directory or changes its files' mode", () => {
    for (const file of services) {
      const text = unit(file);
      expect(text, file).not.toMatch(/^(LogsDirectory|StateDirectory|UMask)=/m);
    }
  });

  test("x402@ counts every end but a success, without ever failing for it", () => {
    expect(settings(unit("x402@.service"), "ExecStopPost")).toEqual([
      "-/usr/local/libexec/x402/x402-host-probe stopped",
    ]);
  });

  test("x402@ takes Compose's 130 after a planned stop as a success, and nothing else", () => {
    // Without it, every deploy and drain counted facilitator_failures_total (0027's drill).
    expect(settings(unit("x402@.service"), "SuccessExitStatus")).toEqual(["130"]);
  });

  test("every count the scripts write is a host counter of the catalog", () => {
    const calls = readdirSync(`${DEPLOY}/libexec`).flatMap((f) => [
      ...read(`libexec/${f}`).matchAll(/x402-host-probe count ([a-z0-9_]+)/g),
    ]);
    expect(calls.map((m) => m[1])).toEqual(["watchdog_restarts_total"]);
    for (const m of calls) {
      const def = byName(m[1]!);
      expect(def?.namespace, m[1]).toBe("x402-host");
      expect(def?.kind, m[1]).toBe("counter");
    }
  });

  test("every oneshot a timer starts has a timeout", () => {
    for (const timer of readdirSync(`${DEPLOY}/systemd`).filter((f) => f.endsWith(".timer"))) {
      const service = timer.replace(/\.timer$/, ".service");
      expect(settings(unit(service), "TimeoutStartSec"), service).toHaveLength(1);
    }
  });

  // Under set -e, a failed echo into a full disk ended the deploy before its rollback.
  test("the deploy prints only through say, which ignores a failed write", () => {
    const script = read("libexec/x402-deploy");
    expect(script).toContain(`say() { printf '%s\\n' "$*" || :; }`);
    expect(script).not.toMatch(/^\s*(echo|printf '%s\\n' "\$\w+" >&2)\b/m);
    expect(script.match(/\becho\b/g)).toBeNull();
  });
});

// OpenBao's snapshot job against the probe, the playbook and ADR 0013 (task 0026).
describe("the snapshot job", () => {
  const script = read("libexec/x402-openbao-snapshot");
  const playbook = read("ansible/playbook.yaml");
  const defaultOf = (name: string) =>
    script.match(new RegExp(`: "\\$\\{${name}:=([^}]+)\\}"`))?.[1];

  test("touches the stamp the probe reads, as its last step", () => {
    expect(defaultOf("X402_STAMPS")).toBe("/var/lib/x402/last-ok");
    expect(read("libexec/x402-host-probe")).toContain(': "${X402_STAMPS:=/var/lib/x402/last-ok}"');
    expect(read("libexec/x402-host-probe")).toContain("stamp_age openbao-snapshot");
    const steps = [
      "borg create ",
      "borg prune ",
      "borg compact",
      'touch "$X402_STAMPS/openbao-snapshot"',
    ];
    const at = steps.map((s) => script.indexOf(s));
    expect(
      at.every((i) => i >= 0),
      at.join(),
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("retries a failed run the same night, well inside the 26-hour alarm", () => {
    const service = unit("x402-openbao-snapshot.service");
    expect(settings(service, "Restart")).toEqual(["on-failure"]);
    expect(settings(service, "RestartSec")).toEqual(["20min"]);
  });

  // Without the limit a failure that lasts retried every 20 minutes all day, each try a login to
  // OpenBao and an SSH session to the shared box (0123, D2).
  test("stops after the run and two retries, until the next night's timer", () => {
    const service = unit("x402-openbao-snapshot.service");
    const inUnit = service.slice(service.indexOf("[Unit]"), service.indexOf("[Service]"));
    expect(settings(inUnit, "StartLimitIntervalSec")).toEqual(["3h"]);
    expect(settings(inUnit, "StartLimitBurst")).toEqual(["3"]);
    // The limit counts starts inside the window, from a burst's first. A window shorter than
    // three whole tries lets the first start leave it before the fourth, and the retries never
    // stop; one of a day or more refuses every next night's run after a failed one.
    const minutes = (key: string, unset?: number) => {
      const value = settings(service, key)[0];
      if (value === undefined && unset !== undefined) return unset;
      const [, n, unitOfTime] = /^(\d+)(h|min|s)$/.exec(value ?? "") ?? [];
      expect(unitOfTime, key).toBeDefined();
      return Number(n) * ({ h: 60, min: 1, s: 1 / 60 }[unitOfTime as "h" | "min" | "s"] ?? 0);
    };
    const tries = Number(settings(inUnit, "StartLimitBurst")[0]);
    // A try that reaches its timeout is stopped, which takes up to TimeoutStopSec (systemd's 90 s
    // when the unit sets none), before the wait for the next one starts.
    const wholeTry =
      minutes("TimeoutStartSec") + minutes("TimeoutStopSec", 1.5) + minutes("RestartSec");
    expect(minutes("StartLimitIntervalSec")).toBeGreaterThan(tries * wholeTry);
    expect(minutes("StartLimitIntervalSec")).toBeLessThan(24 * 60);
  });

  // x402-creds decrypts into a dot file and renames it: a decrypt that stops between the two
  // leaves the dot file, which the script's own test can't reach (it runs on plain files).
  test("cleans up a half-decrypted credential too", () => {
    expect(read("libexec/x402-creds")).toContain('mv -f "$dst/.$name" "$dst/$name"');
    expect(script).toContain('rm -f "$run/$c" "$run/.$c"');
  });

  test("fails on any step, and keeps both AppRole IDs off the command line", () => {
    expect(script).toMatch(/^#!\/bin\/bash\n/);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("auth/approle/login -)");
    expect(script).not.toMatch(/role_id=\$|secret_id=\$/);
  });

  test("pins the Storage Box's host key where the playbook puts it", () => {
    expect(defaultOf("X402_KNOWN_HOSTS")).toBe("/etc/x402/storage-box.known_hosts");
    expect(playbook).toContain("dest: /etc/x402/storage-box.known_hosts");
    expect(script).toContain(
      "-o StrictHostKeyChecking=yes -o UserKnownHostsFile=$X402_KNOWN_HOSTS",
    );
    const pinned = read("ansible/files/storage-box.known_hosts")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatch(/^\[u595862-sub2\.your-storagebox\.de\]:23 ssh-ed25519 \S+$/);
  });

  test("decrypts its credentials from the directory the playbook makes", () => {
    expect(script).toContain("creds=(storage-box-ssh-key borg-passphrase)");
    expect(script).toContain("creds+=(snapshot-role-id snapshot-secret-id)");
    expect(script).toContain('x402-creds backup "${creds[@]/%/:0}"');
    expect(playbook).toContain('{ path: /srv/x402/backup/creds, owner: root, mode: "0700" }');
    expect(read("libexec/x402-creds")).toContain("src=/srv/x402/$1/creds");
  });

  test("keeps 14 daily archives (ADR 0013)", () => {
    expect(script).toContain("--keep-daily 14");
  });

  test("the policy allows the snapshot and nothing else", () => {
    const policy = read("openbao/x402-snapshot.hcl").replace(/^#.*\n/gm, "");
    expect([...policy.matchAll(/^path "([^"]+)"/gm)].map((m) => m[1])).toEqual([
      "sys/storage/raft/snapshot",
    ]);
    expect(policy).toContain('capabilities = ["read"]');
  });
});
