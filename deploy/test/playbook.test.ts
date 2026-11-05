// The playbook against the files table, the units and the spine's rules for it (lore 0027
// server-side spine AD-2, AD-11, AD-13, AD-14): the directories and files it makes are the
// table's, it makes them before it copies a unit that writes there, it fetches pinned versions,
// and it starts no CloudWatch unit itself. Also the certificate check it runs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { absolute, ENV, FILES, LOG_ROOT } from "./files.js";

const DEPLOY = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${DEPLOY}/${path}`, "utf8");
const PLAYBOOK = read("ansible/playbook.yaml").replaceAll("{{ x402_environment }}", ENV);

/** A top-level var's list, as the playbook writes it: `  name:` then `      - item` lines. */
const listVar = (name: string) => {
  const block = PLAYBOOK.match(new RegExp(`^ {4}${name}:\\n((?: {6}- .*\\n)+)`, "m"));
  expect(block, name).not.toBeNull();
  return block![1]!
    .trim()
    .split("\n")
    .map((l) => l.replace(/^\s*- /, "").replace(/^"|"$/g, ""));
};
/** Each task as text, by its name. */
const TASKS = new Map(
  PLAYBOOK.split(/\n(?= {4}- name: )/)
    .slice(1)
    .map((t) => [t.match(/- name: (.*)/)![1]!, t]),
);
const task = (name: string) => {
  const t = TASKS.get(name);
  expect(t, name).toBeDefined();
  return t!;
};
const order = (name: string) => [...TASKS.keys()].indexOf(name);

describe("the playbook", () => {
  test("makes the files table's directories and files, and the symlink", () => {
    const rows = FILES.filter((r) => !r.symlinkTo);
    expect(listVar("x402_log_files").sort()).toEqual(rows.map(absolute).sort());
    const dirs = new Set([LOG_ROOT, ...FILES.map((r) => dirname(absolute(r)))]);
    expect(listVar("x402_log_dirs").sort()).toEqual([...dirs].sort());
    const link = FILES.find((r) => r.symlinkTo)!;
    const t = task("The EMF entry's path to the facilitator's stdout");
    expect(t).toContain(`path: "${absolute(link)}"`);
    expect(t).toContain(`src: ${link.symlinkTo}`);
    expect(t).toContain("state: link");
    for (const [name, mode] of [
      ["The log directories, read by the agent", '"2750"'],
      ["The log files", '"0640"'],
    ] as const) {
      expect(task(name)).toContain("group: cwagent");
      expect(task(name)).toContain(`mode: ${mode}`);
    }
  });

  // A reloaded unit opens its new append: files at its next stop or start (AD-9).
  test("installs the package, then the log paths, then the scripts and the units", () => {
    const steps = [
      "The CloudWatch agent's package",
      "The CloudWatch agent",
      "The log directories, read by the agent",
      "The log files",
      "The EMF entry's path to the facilitator's stdout",
      "The units' scripts",
      "The units",
    ].map(order);
    expect(steps.every((i) => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  test("fetches pinned versions from versioned URLs, checked by SHA-256", () => {
    for (const name of ["IAM Roles Anywhere's signing helper", "The CloudWatch agent's package"]) {
      const t = task(name);
      expect(t).toMatch(/url: ".*\{\{ (cwagent|signing_helper)_version \}\}/);
      expect(t).toMatch(/checksum: "sha256:\{\{ (cwagent|signing_helper)_sha256 \}\}"/);
    }
    expect(PLAYBOOK).not.toMatch(/\/latest\//);
    expect(PLAYBOOK).toMatch(/^ {4}cwagent_sha256: [0-9a-f]{64}$/m);
    expect(PLAYBOOK).toMatch(/^ {4}signing_helper_sha256: [0-9a-f]{64}$/m);
  });

  test("puts each file where the units read it", () => {
    const helper = read("systemd/x402-cloudwatch-credentials.service");
    expect(task("IAM Roles Anywhere's signing helper")).toContain(
      "dest: /usr/local/bin/aws_signing_helper",
    );
    expect(helper).toContain("ExecStart=/usr/local/bin/aws_signing_helper ");
    expect(task("The logging role's ARNs, for the signing helper")).toContain(
      "dest: /etc/x402/cloudwatch-credentials.env",
    );
    expect(helper).toContain("EnvironmentFile=/etc/x402/cloudwatch-credentials.env");
    expect(task("The rotation of our logs")).toContain("dest: /etc/x402/logrotate.conf");
    expect(read("systemd/x402-logrotate.service")).toContain(" /etc/x402/logrotate.conf");
    expect(task("The agent's certificate")).toContain(
      `dest: "/srv/x402/${ENV}/cloudwatch-agent.crt"`,
    );
    expect(task("The agent's credentials setting")).toContain(
      'dest: "{{ cwagent_etc }}/common-config.toml"',
    );
    expect(PLAYBOOK).toContain("cwagent_etc: /opt/aws/amazon-cloudwatch-agent/etc");
  });

  test("builds the role's ARN from the anchor's account and decision 24's name", () => {
    expect(task("The logging role's ARNs, for the signing helper")).toContain(
      `ROLE_ARN=arn:aws:iam::{{ logging_trust_anchor_arn.split(':')[4] }}:role/x402-${ENV}-logging`,
    );
  });

  test("applies the agent's config with a region, without starting the agent", () => {
    const t = task("The agent's config, applied");
    expect(t).toContain("AWS_REGION={{ aws_region }}");
    expect(t).toContain("-a fetch-config -m onPremise -c file:/etc/x402/cloudwatch-agent.json");
    // -s would start the agent, or restart a running one, before the runbook's admin step.
    const ctl = t.slice(t.indexOf("amazon-cloudwatch-agent-ctl")).split("\n    ")[0]!;
    expect(ctl.replace(/\s+/g, " ")).not.toMatch(/ -s\b/);
    expect(t).toContain("notify: Restart the CloudWatch agent if it runs");
    expect(PLAYBOOK).toContain(
      "ansible.builtin.command: systemctl try-restart amazon-cloudwatch-agent.service",
    );
  });

  test("starts only the watchdog's, the probe's and the rotation's timers", () => {
    const started = [...TASKS.values()].filter((t) => /state: started/.test(t));
    const units = started.flatMap((t) => [
      ...t.matchAll(/(?:name: "|- )(x402[\w@{}.-]*\.(?:timer|service)|amazon[\w.-]*)/g),
    ]);
    expect(units.map((m) => m[1]).sort()).toEqual([
      "x402-host-probe.timer",
      "x402-logrotate.timer",
      `x402-watchdog@${ENV}.timer`,
    ]);
  });
});

describe("check-agent-certificate.sh", () => {
  const CHECK = `${DEPLOY}/scripts/check-agent-certificate.sh`;
  const CN = `x402-cloudwatch-agent-${ENV}`;
  const dir = mkdtempSync(join(tmpdir(), "x402-cert-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cert = (name: string, cn: string, ext: string[], days = 365) => {
    const path = join(dir, `${name}.crt`);
    const conf = join(dir, `${name}.cnf`);
    writeFileSync(
      conf,
      `[req]\ndistinguished_name=dn\n[dn]\n[x]\n${ext.join("\n")}\nsubjectKeyIdentifier=hash\n`,
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "-keyout",
        "/dev/null",
        "-days",
        String(days),
        "-subj",
        `/CN=${cn}`,
        "-config",
        conf,
        "-extensions",
        "x",
        "-out",
        path,
      ],
      { stdio: "ignore" },
    );
    return path;
  };
  const GOOD = [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=clientAuth",
  ];
  const run = (path: string, cn = CN, left?: string) =>
    spawnSync("sh", [CHECK, path, cn, ...(left ? [left] : [])], { encoding: "utf8" });

  test("passes the certificate the trust policy accepts", () => {
    const r = run(cert("good", CN, GOOD));
    expect([r.status, r.stderr]).toEqual([0, ""]);
  });
  test.each([
    ["another CN", () => cert("cn", "prices-api-production", GOOD), /not CN=/],
    [
      "a CA",
      () => cert("ca", CN, ["basicConstraints=critical,CA:TRUE", ...GOOD.slice(1)]),
      /CA:FALSE/,
    ],
    [
      "no client auth",
      () => cert("eku", CN, [...GOOD.slice(0, 2), "extendedKeyUsage=serverAuth"]),
      /Client/,
    ],
    ["no certificate", () => CHECK, /not a PEM certificate/],
  ])("refuses %s", (_, make, why) => {
    const r = run(make());
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(why);
  });
  test("refuses one that expires within the time asked", () => {
    const r = run(cert("short", CN, GOOD, 1), CN, String(2 * 86_400));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/expires/);
  });

  const committed = `${DEPLOY}/ansible/files/cloudwatch-agent-${ENV}.crt`;
  test.skipIf(!existsSync(committed))("passes the committed certificate", () => {
    const r = run(committed);
    expect([r.status, r.stderr]).toEqual([0, ""]);
  });
});
