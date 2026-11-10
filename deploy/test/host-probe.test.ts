// Runs the real x402-host-probe under /bin/sh with fakes first on PATH (docker, date) and a real
// unix-socket server playing OpenBao, then checks every line against the metric catalog (lore 0027
// spine AD-4, AD-5) and each scenario's value against the alarms' thresholds (AD-6, decision 10).
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { byName, CATALOG, EMF_LINE_PREFIX, seriesDims } from "@stellar-x402/metrics-catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PROBE = fileURLToPath(new URL("../libexec/x402-host-probe", import.meta.url));
const NO_AGE = 1_000_000_000;
const DAY = 86_400;
/** What the probe's run writes: every x402-host gauge but the agent's two. */
const AGENT = new Set(["mem_used_percent", "disk_used_percent"]);
const PROBE_NAMES = CATALOG.filter(
  (m) => m.namespace === "x402-host" && m.kind === "gauge" && !AGENT.has(m.name),
).map((m) => m.name);

const dir = mkdtempSync(join(tmpdir(), "x402-probe-"));
const fakes = join(dir, "bin");
const stamps = join(dir, "last-ok");
const cert = join(dir, "agent.crt");
const credentials = join(dir, "credentials");
// A unix socket path holds at most 108 bytes; relative to the cwd keeps it short anywhere.
const socket = relative(process.cwd(), join(dir, "bao.sock"));
// Docker's data root, as `docker info` reports it: the probe finds testnet's socket under it.
const dockerRoot = relative(process.cwd(), join(dir, "docker"));
const rootSocket = join(dockerRoot, "volumes/x402-openbao-testnet/_data/bao.sock");
let health = 200;
const servers: Server[] = [];
let certEnd: number;

const script = (name: string, body: string) => {
  writeFileSync(join(fakes, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(fakes, name), 0o755);
};
const listen = (path: string) =>
  new Promise<void>((ok) => {
    const s = createServer((_, res) => res.writeHead(health).end());
    servers.push(s);
    s.listen(path, ok);
  });

beforeAll(async () => {
  mkdirSync(fakes);
  mkdirSync(stamps);
  mkdirSync(join(dir, "docker/volumes/x402-openbao-testnet/_data"), { recursive: true });
  script(
    "docker",
    `case $1 in
  info) [ -n "\${FAKE_DOCKER_ROOT:-}" ] && echo "$FAKE_DOCKER_ROOT" && exit 0; exit 1 ;;
  ps) [ -n "\${FAKE_PG_ID:-}" ] && echo "$FAKE_PG_ID"; exit 0 ;;
  exec) [ -n "\${FAKE_PSQL:-}" ] && echo "$FAKE_PSQL"; exit "\${FAKE_PSQL_EXIT:-0}" ;;
esac
exit 1`,
  );
  const realDate = execFileSync("sh", ["-c", "command -v date"]).toString().trim();
  script(
    "date",
    `[ "$*" = "+%s%3N" ] && [ -n "\${FAKE_NOW_MS:-}" ] && { echo "$FAKE_NOW_MS"; exit 0; }
exec ${realDate} "$@"`,
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
      "365",
      "-subj",
      "/CN=x402-cloudwatch-agent-test",
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  const end = execFileSync("openssl", ["x509", "-noout", "-enddate", "-in", cert]).toString();
  certEnd = Math.floor(Date.parse(end.replace("notAfter=", "")) / 1000);
  writeFileSync(credentials, "[AmazonCloudWatchAgent]\naws_access_key_id = x\n");
  await listen(socket);
  await listen(rootSocket);
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  values: Record<string, number>;
  lines: string[];
  objects: Record<string, unknown>[];
  stdout: string;
  stderr: string;
  status: number | null;
}
// Async: the fake OpenBao answers on this process's event loop, which spawnSync would block.
async function probe(env: Record<string, string> = {}, args: string[] = []): Promise<Run> {
  const out = join(dir, `emf-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(out, "");
  const child = spawn("sh", [PROBE, ...args], {
    env: {
      PATH: `${fakes}:${process.env["PATH"]}`,
      X402_HOST_EMF: out,
      X402_OPENBAO_SOCKET: socket,
      X402_STAMPS: stamps,
      X402_CERT: cert,
      X402_CREDENTIALS: credentials,
      FAKE_PG_ID: "pg",
      FAKE_PSQL: "0 42",
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const status = await new Promise<number | null>((ok) => child.on("close", ok));
  const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
  const objects = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const values: Record<string, number> = {};
  for (const o of objects) {
    const name = metricOf(o).Name;
    values[name] = o[name] as number;
  }
  return { values, lines, objects, stdout, stderr, status };
}
type Aws = {
  Timestamp: number;
  CloudWatchMetrics: {
    Namespace: string;
    Dimensions: string[][];
    Metrics: { Name: string; Unit: string }[];
  }[];
};
const awsOf = (o: Record<string, unknown>) => o["_aws"] as Aws;
const metricOf = (o: Record<string, unknown>) => awsOf(o).CloudWatchMetrics[0]!.Metrics[0]!;
const at = (s: number) => ({ FAKE_NOW_MS: String(s * 1000) });
const touched = (path: string, mtime: number) => utimesSync(path, mtime, mtime);

describe.skipIf(process.platform !== "linux")("x402-host-probe", () => {
  describe("every line is a catalog series", () => {
    test.each([
      ["a healthy run", {}, []],
      [
        "a run where every check fails",
        {
          X402_OPENBAO_SOCKET: "missing.sock",
          FAKE_PG_ID: "",
          X402_CERT: "/missing",
          X402_CREDENTIALS: "/missing",
        },
        [],
      ],
      ["the watchdog's count", {}, ["count", "watchdog_restarts_total"]],
      ["a failed end of x402@", { SERVICE_RESULT: "exit-code", EXIT_STATUS: "137" }, ["stopped"]],
    ])("%s", async (_, env, args) => {
      const { objects, lines } = await probe(env, args as string[]);
      expect(lines.length).toBeGreaterThan(0);
      for (const [i, o] of objects.entries()) {
        expect(lines[i]!.startsWith(EMF_LINE_PREFIX)).toBe(true);
        const aws = awsOf(o);
        expect(Object.keys(aws)).toEqual(["Timestamp", "CloudWatchMetrics"]);
        expect(Number.isInteger(aws.Timestamp)).toBe(true);
        expect(aws.CloudWatchMetrics).toHaveLength(1);
        const [d] = aws.CloudWatchMetrics;
        expect(d!.Metrics).toHaveLength(1);
        const m = metricOf(o);
        const def = byName(m.Name);
        expect(def, m.Name).toBeDefined();
        expect(d!.Namespace).toBe(def!.namespace);
        expect(m.Unit).toBe(def!.unit);
        for (const set of d!.Dimensions)
          expect(
            seriesDims(def!.name as never, Object.fromEntries(set.map((k) => [k, String(o[k])]))),
          ).toEqual({ ok: true, namespace: "x402-host" });
        expect(Number.isInteger(o[m.Name])).toBe(true);
      }
    });

    test("a run writes each probe metric once, one timestamp, the heartbeat last", async () => {
      const { lines, values, objects, stdout } = await probe();
      expect(Object.keys(values).sort()).toEqual([...PROBE_NAMES].sort());
      expect(lines).toHaveLength(PROBE_NAMES.length);
      expect(new Set(objects.map((o) => awsOf(o).Timestamp)).size).toBe(1);
      expect(lines.at(-1)).toContain('"host_probe_heartbeat":1');
      expect(stdout).toBe("");
    });
  });

  describe("each check", () => {
    test.each([
      ["unsealed", 200, 1],
      ["sealed", 503, 0],
      ["not initialised", 501, 0],
    ])("openbao_up when %s", async (_, code, up) => {
      health = code;
      try {
        expect((await probe()).values["openbao_up"]).toBe(up);
      } finally {
        health = 200;
      }
    });
    test("openbao_up with no socket", async () => {
      expect((await probe({ X402_OPENBAO_SOCKET: "missing.sock" })).values["openbao_up"]).toBe(0);
    });
    test("openbao_up finds testnet's socket under Docker's data root", async () => {
      const env = { X402_OPENBAO_SOCKET: "", FAKE_DOCKER_ROOT: dockerRoot };
      expect((await probe(env)).values["openbao_up"]).toBe(1);
      const r = await probe({ X402_OPENBAO_SOCKET: "", FAKE_DOCKER_ROOT: "" });
      expect(r.values["openbao_up"]).toBe(0);
      expect(r.stderr).toMatch(/docker info/);
    });

    test.each([
      ["archiving", { FAKE_PSQL: "0 42" }, 0, 42],
      ["never archived (the SQL's answer)", { FAKE_PSQL: `1 ${NO_AGE}` }, 1, NO_AGE],
      ["archive failing", { FAKE_PSQL: "1 900" }, 1, 900],
      ["no Postgres running", { FAKE_PG_ID: "" }, 1, NO_AGE],
      ["psql failing", { FAKE_PSQL: "", FAKE_PSQL_EXIT: "2" }, 1, NO_AGE],
      ["an answer it can't read", { FAKE_PSQL: "f\t" }, 1, NO_AGE],
    ])("wal when %s", async (_, env, failing, age) => {
      const { values } = await probe(env);
      expect(values["wal_failing"]).toBe(failing);
      expect(values["wal_last_archived_age_seconds"]).toBe(age);
    });

    test("backup and snapshot ages from their stamps", async () => {
      const now = 2_000_000_000;
      writeFileSync(join(stamps, "pgbackrest-backup"), "");
      writeFileSync(join(stamps, "openbao-snapshot"), "");
      touched(join(stamps, "pgbackrest-backup"), now - 3600);
      touched(join(stamps, "openbao-snapshot"), now - 27 * 3600);
      let v = (await probe(at(now))).values;
      expect([v["backup_age_seconds"], v["snapshot_age_seconds"]]).toEqual([3600, 27 * 3600]);
      touched(join(stamps, "pgbackrest-backup"), now + 60); // a clock step back reads as fresh
      expect((await probe(at(now))).values["backup_age_seconds"]).toBe(0);
      v = (await probe({ ...at(now), X402_STAMPS: join(dir, "none") })).values;
      expect([v["backup_age_seconds"], v["snapshot_age_seconds"]]).toEqual([NO_AGE, NO_AGE]);
    });

    test.each([
      ["100 days left", 100 * DAY + 1, 100],
      ["29 days and a bit", 30 * DAY - 1, 29],
      ["expired an hour ago", -3600, -1],
      ["expired a day and a half ago", -1.5 * DAY, -2],
    ])("certificate_days_left with %s", async (_, left, days) => {
      expect((await probe(at(certEnd - left))).values["certificate_days_left"]).toBe(days);
    });
    test.each([
      ["missing", "/missing"],
      ["not a certificate", PROBE],
    ])("certificate %s", async (_, path) => {
      expect((await probe({ X402_CERT: path })).values["certificate_days_left"]).toBe(-1);
    });

    test("credentials_age_seconds from the credentials file", async () => {
      const now = 2_000_000_000;
      touched(credentials, now - 1800);
      expect((await probe(at(now))).values["credentials_age_seconds"]).toBe(1800);
      const missing = await probe({ ...at(now), X402_CREDENTIALS: join(dir, "none") });
      expect(missing.values["credentials_age_seconds"]).toBe(NO_AGE);
      const empty = join(dir, "empty-credentials");
      writeFileSync(empty, "");
      touched(empty, now - 10);
      const r = await probe({ ...at(now), X402_CREDENTIALS: empty });
      expect(r.values["credentials_age_seconds"]).toBe(NO_AGE);
    });
  });

  describe("stopped, x402@'s ExecStopPost", () => {
    test("writes nothing when the unit ended in success", async () => {
      const r = await probe({ SERVICE_RESULT: "success", EXIT_STATUS: "0" }, ["stopped"]);
      expect([r.status, r.lines]).toEqual([0, []]);
    });
    test("counts any other end once, with how it ended as log fields", async () => {
      const r = await probe(
        { SERVICE_RESULT: "exit-code", EXIT_CODE: "killed", EXIT_STATUS: "KILL" },
        ["stopped"],
      );
      expect(r.status).toBe(0);
      expect(r.values).toEqual({ facilitator_failures_total: 1 });
      expect(r.objects[0]).toMatchObject({
        result: "exit-code",
        exit_code: "killed",
        exit_status: "KILL",
      });
      expect(awsOf(r.objects[0]!).CloudWatchMetrics[0]!.Dimensions).toEqual([[]]);
    });
    // systemd 255 sets neither when no main process ran: a failed ExecStartPre, a start timeout.
    test("counts a failed start with neither EXIT_ variable set", async () => {
      const r = await probe({ SERVICE_RESULT: "exit-code" }, ["stopped"]);
      expect(r.values).toEqual({ facilitator_failures_total: 1 });
      expect(r.objects[0]).toMatchObject({ exit_code: "", exit_status: "" });
    });
    test("keeps a value it can't vouch for out of the line", async () => {
      const r = await probe({ SERVICE_RESULT: 'exit-code"}', EXIT_STATUS: "1\n2" }, ["stopped"]);
      expect(r.values).toEqual({ facilitator_failures_total: 1 });
      expect(r.objects[0]).toMatchObject({ result: "", exit_status: "" });
    });
    test("refuses to run outside systemd", async () => {
      const r = await probe({}, ["stopped"]);
      expect([r.status, r.lines]).toEqual([2, []]);
    });
  });

  describe("robustness", () => {
    test("a check that fails leaves the others and says why on stderr", async () => {
      const r = await probe({ FAKE_PSQL: "", FAKE_PSQL_EXIT: "1" });
      expect(r.status).toBe(0);
      expect(r.values["openbao_up"]).toBe(1);
      expect(r.values["host_probe_heartbeat"]).toBe(1);
      expect(r.stderr).toMatch(/wal: psql in pg failed/);
    });
    test("an output it can't append to fails the run", async () => {
      const r = await probe({ X402_HOST_EMF: join(dir, "no-dir", "x.log") });
      expect(r.status).toBe(1);
    });
    test("count takes only a host counter", async () => {
      expect((await probe({}, ["count", "openbao_up"])).status).toBe(2);
      const unknown = await probe({}, ["count", "nope_total"]);
      expect([unknown.status, unknown.lines]).toEqual([2, []]);
      const ok = await probe({}, ["count", "facilitator_failures_total"]);
      expect(ok.values).toEqual({ facilitator_failures_total: 1 });
    });
    test("an unknown mode writes nothing", async () => {
      const r = await probe({}, ["nope"]);
      expect([r.status, r.lines]).toEqual([2, []]);
    });
  });
});
