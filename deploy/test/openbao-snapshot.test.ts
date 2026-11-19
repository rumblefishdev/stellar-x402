// Runs the real x402-openbao-snapshot under bash with fakes first on PATH (docker, borg, sleep):
// the stamp 0027's snapshot-age alarm reads is touched only after a whole snapshot is archived,
// pruned and compacted, and every failure leaves none (task 0026, ADR 0013). The decrypt through
// x402-creds is the server's: X402_CREDS_DIR stands in for it with plain files.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

const SCRIPT = fileURLToPath(new URL("../libexec/x402-openbao-snapshot", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "x402-snapshot-"));
const fakes = join(dir, "bin");
const creds = join(dir, "creds");
const stamps = join(dir, "last-ok");
const log = join(dir, "calls.log");
const lock = join(dir, "lock");
const snapshots = {
  whole: join(dir, "whole.snap"),
  empty: join(dir, "empty.snap"),
  partial: join(dir, "partial.snap"),
};
const stamp = join(stamps, "openbao-snapshot");

const fake = (name: string, body: string) => {
  writeFileSync(join(fakes, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(fakes, name), 0o755);
};

beforeAll(() => {
  mkdirSync(fakes);
  mkdirSync(creds);
  for (const [name, value] of [
    ["storage-box-ssh-key", "key"],
    ["borg-passphrase", "pass"],
    ["snapshot-role-id", "11111111-1111-1111-1111-111111111111"],
    ["snapshot-secret-id", "22222222-2222-2222-2222-222222222222"],
  ]) {
    writeFileSync(join(creds, name!), value!);
  }
  const whole = gzipSync(Buffer.from("raft snapshot"));
  writeFileSync(snapshots.whole, whole);
  writeFileSync(snapshots.empty, "");
  writeFileSync(snapshots.partial, whole.subarray(0, whole.length - 8));
  // `docker compose -f FILE exec -T [-e BAO_TOKEN] openbao CMD...`: CMD after the service name.
  // FAKE_SEALED is how many status calls answer sealed (exit 2) before it is active.
  fake(
    "docker",
    `echo "docker $*" >> "$FAKE_LOG"
while [ $# -gt 0 ] && [ "$1" != openbao ]; do shift; done
shift
case "$1 $2" in
  "bao status")
    n=$(cat "$FAKE_LOG.status" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_LOG.status"
    [ "$n" -lt "\${FAKE_SEALED:-0}" ] && { echo '{"sealed": true}'; exit 2; }
    echo '{"sealed": false, "is_self": true}' ;;
  "bao write") echo "login $(cat)" >> "$FAKE_LOG"; echo token ;;
  "bao operator") exit "\${FAKE_SAVE_EXIT:-0}" ;;
  "cat /tmp/raft.snap") cat "$FAKE_SNAP" ;;
esac`,
  );
  fake(
    "borg",
    `echo "borg $* | $BORG_REPO | $BORG_PASSCOMMAND | $BORG_RSH" >> "$FAKE_LOG"
[ "$1" = "\${FAKE_BORG_FAIL:-}" ] && exit 2
exit 0`,
  );
  fake("sleep", `echo "sleep $*" >> "$FAKE_LOG"`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(stamps, { recursive: true, force: true });
  rmSync(log, { force: true });
  rmSync(`${log}.status`, { force: true });
});

interface Run {
  status: number | null;
  stderr: string;
  calls: string[];
  borg: string[];
}
async function snapshot(
  env: Record<string, string> = {},
  args: string[] = [],
  started: (pid: number) => void = () => {},
): Promise<Run> {
  const child = spawn("bash", [SCRIPT, ...args], {
    env: {
      PATH: `${fakes}:${process.env["PATH"]}`,
      X402_CREDS_DIR: creds,
      X402_STAMPS: stamps,
      X402_OPENBAO_DIR: join(dir, "openbao"),
      X402_LOCK: lock,
      BORG_REPO: "ssh://sub2@box:23/./data/openbao",
      FAKE_LOG: log,
      FAKE_SNAP: snapshots.whole,
      ...env,
    },
  });
  started(child.pid!);
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const status = await new Promise<number | null>((ok) => child.on("close", ok));
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { status, stderr, calls, borg: calls.filter((c) => c.startsWith("borg ")) };
}
const verbs = (r: Run) => r.borg.map((c) => c.split(" ")[1]);

describe("x402-openbao-snapshot", () => {
  test("archives a whole snapshot, keeps 14 daily archives, compacts, then touches the stamp", async () => {
    const r = await snapshot();
    expect(r.status, r.stderr).toBe(0);
    expect(verbs(r)).toEqual(["create", "prune", "compact"]);
    expect(r.borg[1]).toContain("prune --glob-archives openbao-* --keep-daily 14");
    expect(r.borg[0]).toContain(
      "create --stats ::openbao-{utcnow:%Y-%m-%dT%H:%M:%SZ} openbao.snap",
    );
    expect(existsSync(stamp)).toBe(true);
  });

  test("logs in with both IDs over stdin, never on the command line, and revokes the token", async () => {
    const r = await snapshot();
    expect(r.calls).toContain(
      'login {"role_id":"11111111-1111-1111-1111-111111111111","secret_id":"22222222-2222-2222-2222-222222222222"}',
    );
    expect(r.calls.filter((c) => c.startsWith("docker ")).join("\n")).not.toMatch(/1111|2222/);
    expect(r.calls.some((c) => c.includes("bao token revoke -self"))).toBe(true);
  });

  test("passes Borg the repository, the passphrase file and the pinned host key", async () => {
    const r = await snapshot();
    for (const c of r.borg) {
      expect(c).toContain(" | ssh://sub2@box:23/./data/openbao | ");
      expect(c).toContain(`cat ${creds}/borg-passphrase`);
      expect(c).toContain(`-i ${creds}/storage-box-ssh-key`);
      expect(c).toContain("-o StrictHostKeyChecking=yes");
    }
  });

  test.each([
    ["empty", snapshots.empty, "the snapshot is empty"],
    ["partial", snapshots.partial, "isn't a whole gzip file"],
  ])("refuses an %s snapshot: no archive, no stamp", async (_, file, message) => {
    const r = await snapshot({ FAKE_SNAP: file });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(message);
    expect(r.borg).toEqual([]);
    expect(existsSync(stamp)).toBe(false);
  });

  test("a failed save archives nothing and leaves no stamp", async () => {
    const r = await snapshot({ FAKE_SAVE_EXIT: "1" });
    expect(r.status).not.toBe(0);
    expect(r.borg).toEqual([]);
    expect(existsSync(stamp)).toBe(false);
  });

  test.each(["create", "prune", "compact"])(
    "a failed borg %s stops the run before the stamp",
    async (verb) => {
      const r = await snapshot({ FAKE_BORG_FAIL: verb });
      expect(r.status).not.toBe(0);
      expect(verbs(r).at(-1)).toBe(verb);
      expect(existsSync(stamp)).toBe(false);
    },
  );

  test.each<Record<string, string>>([{}, { FAKE_BORG_FAIL: "create" }])(
    "removes its copy of the snapshot and the container's, whatever the outcome (%o)",
    async (env) => {
      const r = await snapshot(env);
      expect(existsSync(join(creds, "openbao.snap"))).toBe(false);
      expect(r.calls.some((c) => c.endsWith("openbao rm -f /tmp/raft.snap"))).toBe(true);
    },
  );

  test("waits for OpenBao to unseal and lead before it logs in", async () => {
    const r = await snapshot({ FAKE_SEALED: "3" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.filter((c) => c === "sleep 5")).toHaveLength(3);
    const login = r.calls.findIndex((c) => c.startsWith("login "));
    const lastSleep = r.calls.lastIndexOf("sleep 5");
    expect(login).toBeGreaterThan(lastSleep);
  });

  test("gives up after 5 minutes of a sealed OpenBao, without logging in", async () => {
    const r = await snapshot({ FAKE_SEALED: "1000" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("isn't unsealed and active after 5 minutes");
    expect(r.calls.filter((c) => c === "sleep 5")).toHaveLength(59);
    expect(r.calls.some((c) => c.startsWith("login "))).toBe(false);
    expect(existsSync(stamp)).toBe(false);
  });

  test("borg mode runs one Borg command, with no login and no stamp", async () => {
    const r = await snapshot({}, ["borg", "list", "--short"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.borg).toHaveLength(1);
    expect(r.borg[0]).toMatch(/^borg list --short \| ssh:\/\/sub2@box:23\/\.\/data\/openbao \| /);
    expect(r.calls.some((c) => c.includes("bao status") || c.startsWith("login "))).toBe(false);
    expect(existsSync(stamp)).toBe(false);
  });

  /** Another run holding the lock: resolves once it has it, however slow the machine is. */
  async function holdLock() {
    const holder = spawn("flock", [lock, "-c", "read _"], { stdio: ["pipe", "ignore", "ignore"] });
    const closed = new Promise((ok) => holder.on("close", ok));
    // flock -n exits 1 when the lock is held; any other end (no flock at all) isn't "held".
    const taken = () => spawnSync("flock", ["-n", lock, "true"]).status === 1;
    for (let waited = 0; !taken() && waited < 5000; waited += 25)
      await new Promise((ok) => setTimeout(ok, 25));
    const release = async () => {
      holder.stdin.end();
      await closed;
    };
    if (!taken()) {
      await release();
      throw new Error("the holder never took the lock");
    }
    return { release };
  }

  test("gives up at once when another run holds the lock", async () => {
    const holder = await holdLock();
    try {
      const r = await snapshot({ X402_LOCK_WAIT: "0" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("another snapshot run holds");
      expect(r.calls).toEqual([]);
    } finally {
      await holder.release();
    }
  });

  test("waits for another run's lock, and runs once it is freed", async () => {
    const holder = await holdLock();
    let script = 0;
    const run = snapshot({ X402_LOCK_WAIT: "30" }, [], (pid) => (script = pid));
    // The lock is freed only once the script is seen waiting for it, in its own `flock`: a
    // release on a timer would let a slow script find the lock free and pass without a wait.
    const waiting = () => spawnSync("pgrep", ["-P", String(script), "-x", "flock"]).status === 0;
    const sawItWait = await (async () => {
      try {
        for (let waited = 0; waited < 5000; waited += 25) {
          if (waiting()) return true;
          await new Promise((ok) => setTimeout(ok, 25));
        }
        return waiting();
      } finally {
        await holder.release();
      }
    })();
    const r = await run;
    expect(sawItWait).toBe(true);
    expect(r.stderr).not.toContain("another snapshot run holds");
    expect(r.status).toBe(0);
    expect(existsSync(stamp)).toBe(true);
  });
});
