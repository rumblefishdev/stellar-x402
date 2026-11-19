// The portal backend's deploy path (task 0106 decision 5): its compose file, units, scripts,
// playbook entries and workflow against each other, and the real x402-portal-deploy and
// deploy-portal.sh run under sh with fakes first on PATH (docker, systemctl, sudo, sleep). What
// the path promises: the portal's key and deploy never reach the facilitator, a start that
// doesn't answer /health ends on the last good image, and a first deploy that fails leaves
// nothing a reboot would start.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ENV } from "./files.js";

const DEPLOY = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(DEPLOY, "..");
const read = (path: string) => readFileSync(join(DEPLOY, path), "utf8");
const settings = (text: string, key: string) =>
  [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!.trim());

const COMPOSE = read(`${ENV}/portal.compose.yaml`);
const UNIT = read("systemd/x402-portal@.service");
const DEPLOY_UNIT = read("systemd/x402-portal-deploy@.service");
const SCRIPT = read("libexec/x402-portal-deploy");
const WRAPPER = read("libexec/x402-portal-compose");
const PLAYBOOK = read("ansible/playbook.yaml");
const WORKFLOW = readFileSync(join(REPO, ".github/workflows/deploy-portal-production.yml"), "utf8");
const IMAGE = "ghcr.io/rumblefishdev/x402-portal";

describe("the portal's compose project", () => {
  const facilitators = read(`${ENV}/compose.yaml`);
  const name = (text: string) => text.match(/^name: (.*)$/m)?.[1];

  test("is its own project, on the facilitator project's two networks", () => {
    expect(name(COMPOSE)).toBe(`x402-portal-${ENV}`);
    expect(name(COMPOSE)).not.toBe(name(facilitators));
    for (const network of ["edge", "db"]) {
      const made = facilitators.match(new RegExp(`^  ${network}:\\n    name: (.*)$`, "m"))?.[1];
      expect(made, network).toBeDefined();
      expect(COMPOSE).toContain(`  ${network}:\n    external: true\n    name: ${made}\n`);
    }
  });

  test("drops what the facilitator's services drop, and publishes no port", () => {
    for (const line of [
      "read_only: true",
      "cap_drop: [ALL]",
      "security_opt: [no-new-privileges:true]",
    ])
      expect(COMPOSE).toContain(`    ${line}\n`);
    expect(COMPOSE).not.toMatch(/^\s+(ports|restart|privileged|user):/m);
  });

  test("gets every secret as a file the unit decrypts for the image's user", () => {
    const listed = COMPOSE.match(/^ {4}secrets:\n((?: {6}- .*\n)+)/m)![1]!
      .trim()
      .split("\n")
      .map((l) => l.trim().replace(/^- /, ""));
    const creds = settings(UNIT, "ExecStartPre")
      .find((e) => e.includes("x402-creds"))!
      .split(" ")
      .slice(2);
    // 1000 is `node` in the image; Compose's file secrets keep the host's owner and mode.
    expect(creds.sort()).toEqual(listed.map((s) => `${s}:1000`).sort());
    expect(read("../apps/portal/Dockerfile")).toMatch(/^USER node$/m);
    for (const secret of listed) {
      expect(COMPOSE).toContain(
        `  ${secret}:\n    file: \${SECRETS_DIR:-/run/x402/${ENV}}/${secret}\n`,
      );
      expect(COMPOSE, secret).toMatch(new RegExp(`_FILE: /run/secrets/${secret}\\n`));
    }
    // A secret's value never sits in the container's environment.
    expect(COMPOSE).not.toMatch(/^\s+(DATABASE_URL|\w*SECRET|\w*KEY):/m);
  });

  test("listens where the healthcheck, the deploy and the tunnel look", () => {
    expect(COMPOSE).toContain('PORT: "4022"');
    const probe = "fetch('http://127.0.0.1:4022/health',";
    expect(COMPOSE).toContain(probe);
    expect(SCRIPT).toContain(probe);
    expect(COMPOSE).toContain("CLIENT_IP: cloudflare");
  });
});

describe("the portal's units", () => {
  test("x402-portal@ runs the image portal.digest names, skipped until a deploy wrote it", () => {
    expect(settings(UNIT, "ConditionPathExists")).toEqual(["/srv/x402/%i/portal.digest"]);
    expect(WRAPPER).toContain(`PORTAL_IMAGE="${IMAGE}@$(cat portal.digest)"`);
    expect(WRAPPER).toContain("docker compose -f portal.compose.yaml");
    expect(settings(UNIT, "ExecStart")).toEqual([
      "/usr/local/libexec/x402/x402-portal-compose %i up --no-log-prefix --no-color --no-deps --pull never --exit-code-from portal portal",
    ]);
    expect(settings(UNIT, "ExecStartPre")).toContain(
      "/bin/sh -c '[ -e /run/x402/%i/portal.deploying ] || cp portal.digest.good portal.digest'",
    );
    expect(settings(UNIT, "SuccessExitStatus")).toEqual(["130"]);
  });

  test("neither unit starts, stops or waits for the facilitator, or touches its digests", () => {
    for (const text of [UNIT, DEPLOY_UNIT, SCRIPT, WRAPPER, read(`${ENV}/deploy-portal.sh`)]) {
      const code = text.replace(/^\s*#.*$/gm, "");
      expect(code).not.toMatch(/x402@|x402-deploy@|x402-compose\b/);
      // The facilitator's are `digest`, `digest.good` and `digest.next`, without the prefix.
      expect(code).not.toMatch(/(^|[^.\w$])digest(\.(good|next|tmp))?(?=[\s"'])/m);
    }
  });

  test("the deploy unit runs the script, and again after any end", () => {
    expect(settings(DEPLOY_UNIT, "Type")).toEqual(["oneshot"]);
    expect(settings(DEPLOY_UNIT, "ExecStart")).toEqual([
      "/usr/local/libexec/x402/x402-portal-deploy %i",
    ]);
    expect(settings(DEPLOY_UNIT, "ExecStopPost")).toEqual([
      "/usr/local/libexec/x402/x402-portal-deploy %i stopped",
    ]);
    expect(settings(DEPLOY_UNIT, "TimeoutStartSec")).toHaveLength(1);
  });
});

describe("the playbook, for the portal", () => {
  const playbook = PLAYBOOK.replaceAll("{{ x402_environment }}", ENV);

  test("lets the deploy user start the portal's deploy unit, and write only its digest", () => {
    expect(playbook).toContain(
      `x402-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl start x402-portal-deploy@${ENV}\n`,
    );
    expect(read(`${ENV}/deploy-portal.sh`)).toContain(
      'sudo systemctl start "x402-portal-deploy@$env"',
    );
    expect(playbook).toMatch(/loop:\n\s+- digest\.next\n\s+- portal\.digest\.next\n/);
  });

  test("holds the portal's key to deploy-portal.sh, once the key is committed", () => {
    expect(playbook).toContain(
      `command="/srv/x402/${ENV}/deploy-portal.sh",restrict {{ lookup('ansible.builtin.file', portal_deploy_key_file) }}`,
    );
    expect(playbook).toContain("{% if portal_deploy_key_file is file %}");
    expect(playbook).toContain(
      `portal_deploy_key_file: "{{ playbook_dir }}/files/deploy-portal-${ENV}.pub"`,
    );
    expect(WORKFLOW).toContain(`deploy/ansible/files/deploy-portal-${ENV}.pub`);
  });

  test("copies the compose file and the forced command, and enables the unit", () => {
    expect(playbook).toContain('- { name: portal.compose.yaml, mode: "0644" }');
    expect(playbook).toContain('- { name: deploy-portal.sh, mode: "0755" }');
    expect(playbook).toContain(`name: "x402-portal@${ENV}.service"\n        enabled: true`);
  });
});

describe("the workflows", () => {
  const facilitators = readFileSync(join(REPO, ".github/workflows/deploy-production.yml"), "utf8");

  test("build the image the server pulls, from the portal's Dockerfile", () => {
    expect(WORKFLOW).toContain(`IMAGE: ${IMAGE}`);
    expect(SCRIPT).toContain(`repo=${IMAGE}\n`);
    expect(WORKFLOW).toContain("file: apps/portal/Dockerfile");
  });

  test("a push that changes only the portal deploys the portal and not the facilitator", () => {
    for (const path of ["apps/portal/**"]) {
      expect(WORKFLOW).toMatch(
        new RegExp(`paths:\\n(?:.*\\n)*?\\s+- ${path.replace(/\*/g, "\\*")}\\n`),
      );
      expect(facilitators).toMatch(
        new RegExp(`paths-ignore:\\n(?:.*\\n)*?\\s+- ${path.replace(/\*/g, "\\*")}\\n`),
      );
    }
    // The registry's package is in both images.
    expect(WORKFLOW).toContain("- packages/api-keys/**\n");
    expect(facilitators).not.toContain("packages/api-keys");
  });

  test("the portal's has an environment, a key and a queue of its own", () => {
    expect(WORKFLOW).toContain("name: production-portal\n");
    expect(facilitators).toContain("name: production\n");
    expect(WORKFLOW).toContain("group: deploy-portal-production\n");
    expect(facilitators).toContain("group: deploy-production\n");
    const hostKey = (text: string) => text.match(/HOST_KEY: "(.*)"/)?.[1];
    expect(hostKey(WORKFLOW)).toBe(hostKey(facilitators));
  });

  test("both images start from the same pinned base", () => {
    const base = (path: string) =>
      read(path).match(/^ARG NODE_IMAGE=(.*@sha256:[0-9a-f]{64})$/m)?.[1];
    expect(base("../apps/portal/Dockerfile")).toBeDefined();
    expect(base("../apps/portal/Dockerfile")).toBe(base("../apps/facilitator/Dockerfile"));
  });
});

// The scripts themselves, on a directory standing in for /srv/x402 and /run/x402.
describe("x402-portal-deploy", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-portal-deploy-"));
  const fakes = join(dir, "bin");
  const srv = join(dir, "srv", ENV);
  const run = join(dir, "run", ENV);
  const log = join(dir, "calls.log");
  const A = `sha256:${"a".repeat(64)}`;
  const B = `sha256:${"b".repeat(64)}`;
  const OLD = `sha256:${"0".repeat(64)}`;

  const fake = (name: string, body: string) => {
    writeFileSync(join(fakes, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(fakes, name), 0o755);
  };

  beforeAll(() => {
    mkdirSync(fakes);
    // `exec … portal node -e PROBE` answers for the image x402-portal-compose named: healthy
    // when FAKE_HEALTHY lists its digest.
    fake(
      "docker",
      `if [ "$1" = compose ]; then echo "docker compose exec image=$PORTAL_IMAGE"; else echo "docker $*"; fi >> "$FAKE_LOG"
case "$1" in
  pull) exit "\${FAKE_PULL_EXIT:-0}" ;;
  image) [ "$2" = ls ] && printf '%s\\n' $FAKE_IMAGES; exit 0 ;;
  compose) case " $FAKE_HEALTHY " in *" \${PORTAL_IMAGE#*@} "*) exit 0 ;; *) exit 1 ;; esac ;;
esac`,
    );
    fake(
      "systemctl",
      `echo "systemctl $*" >> "$FAKE_LOG"; [ "$1" != restart ] || exit "\${FAKE_RESTART_EXIT:-0}"`,
    );
    fake("sudo", `echo "sudo $*" >> "$FAKE_LOG"`);
    fake("sleep", ":");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    rmSync(join(dir, "srv"), { recursive: true, force: true });
    rmSync(join(dir, "run"), { recursive: true, force: true });
    rmSync(log, { force: true });
    mkdirSync(srv, { recursive: true });
  });

  const state = (file: string) =>
    existsSync(join(srv, file)) ? readFileSync(join(srv, file), "utf8").trim() : undefined;
  const put = (file: string, digest: string) => writeFileSync(join(srv, file), `${digest}\n`);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const deploy = (env: Record<string, string> = {}, args: string[] = []) =>
    spawnSync("sh", [join(DEPLOY, "libexec/x402-portal-deploy"), ENV, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${fakes}:${process.env["PATH"]}`,
        X402_SRV: join(dir, "srv"),
        X402_RUN: join(dir, "run"),
        X402_LIBEXEC: join(DEPLOY, "libexec"),
        X402_PORTAL_WAIT: "0",
        FAKE_LOG: log,
        FAKE_HEALTHY: "",
        FAKE_IMAGES: "",
        ...env,
      },
    });

  test("a healthy image becomes the good one, and older images go", () => {
    put("portal.digest.next", B);
    put("portal.digest", A);
    put("portal.digest.good", A);
    const r = deploy({ FAKE_HEALTHY: B, FAKE_IMAGES: `${OLD} ${A} ${B}` });
    expect([r.status, r.stdout.trim()]).toEqual([0, `deployed ${B}`]);
    expect([state("portal.digest"), state("portal.digest.good")]).toEqual([B, B]);
    expect(calls()).toEqual([
      `docker pull --quiet ${IMAGE}@${B}`,
      `systemctl reset-failed x402-portal@${ENV}`,
      `systemctl restart x402-portal@${ENV}`,
      `docker compose exec image=${IMAGE}@${B}`,
      `docker image ls --digests --format {{.Digest}} ${IMAGE}`,
      // This image and the previous good one stay.
      `docker image rm ${IMAGE}@${OLD}`,
    ]);
    // The marker is the unit's ExecStopPost's to remove.
    expect(existsSync(join(run, "portal.deploying"))).toBe(true);
  });

  test("an image that doesn't answer /health is replaced by the good one", () => {
    put("portal.digest.next", B);
    put("portal.digest", A);
    put("portal.digest.good", A);
    const r = deploy({ FAKE_HEALTHY: A });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${B} didn't answer /health within 0 s; back to ${A}`);
    expect([state("portal.digest"), state("portal.digest.good")]).toEqual([A, A]);
    expect(calls().filter((c) => c.startsWith("systemctl restart"))).toHaveLength(2);
  });

  test("a unit that doesn't start is a failed deploy too", () => {
    put("portal.digest.next", B);
    put("portal.digest", A);
    put("portal.digest.good", A);
    const r = deploy({ FAKE_HEALTHY: B, FAKE_RESTART_EXIT: "1" });
    expect(r.status).toBe(1);
    expect(state("portal.digest")).toBe(A);
    expect(r.stderr).toContain(`x402-portal@${ENV} didn't start on ${A}`);
  });

  test("a first deploy that fails leaves no digest for a reboot to start", () => {
    put("portal.digest.next", B);
    const r = deploy();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("back to nothing, the first deploy");
    expect([state("portal.digest"), state("portal.digest.good")]).toEqual([undefined, undefined]);
    expect(calls().at(-1)).toBe(`systemctl stop x402-portal@${ENV}`);
  });

  test("a first deploy that works needs no good image before it", () => {
    put("portal.digest.next", B);
    const r = deploy({ FAKE_HEALTHY: B, FAKE_IMAGES: B });
    expect(r.status).toBe(0);
    expect([state("portal.digest"), state("portal.digest.good")]).toEqual([B, B]);
    expect(calls().some((c) => c.startsWith("docker image rm"))).toBe(false);
  });

  test("a failed pull changes nothing and restarts nothing", () => {
    put("portal.digest.next", B);
    put("portal.digest", A);
    put("portal.digest.good", A);
    const r = deploy({ FAKE_PULL_EXIT: "1" });
    expect(r.status).not.toBe(0);
    expect([state("portal.digest"), state("portal.digest.good")]).toEqual([A, A]);
    expect(calls()).toEqual([`docker pull --quiet ${IMAGE}@${B}`]);
  });

  describe("after the unit ends", () => {
    const stopped = (result: string) => deploy({ SERVICE_RESULT: result }, ["stopped"]);
    beforeEach(() => {
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, "portal.deploying"), "");
    });

    test("a success removes the marker and nothing else", () => {
      put("portal.digest", B);
      put("portal.digest.good", B);
      expect(stopped("success").status).toBe(0);
      expect(existsSync(join(run, "portal.deploying"))).toBe(false);
      expect(calls()).toEqual([]);
    });

    test("a deploy cut after the digest moved goes back to the good image", () => {
      put("portal.digest", B);
      put("portal.digest.good", A);
      const r = stopped("timeout");
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("the deploy ended with timeout; back to portal.digest.good");
      expect(state("portal.digest")).toBe(A);
      expect(calls().at(-1)).toBe(`systemctl restart --no-block x402-portal@${ENV}`);
      expect(existsSync(join(run, "portal.deploying"))).toBe(false);
    });

    test("a failure the script already rolled back restarts nothing again", () => {
      put("portal.digest", A);
      put("portal.digest.good", A);
      expect(stopped("exit-code").status).toBe(0);
      expect(calls()).toEqual([]);
    });
  });

  describe("deploy-portal.sh", () => {
    const forced = (command: string | undefined) => {
      copyFileSync(join(DEPLOY, ENV, "deploy-portal.sh"), join(srv, "deploy-portal.sh"));
      return spawnSync("sh", [join(srv, "deploy-portal.sh")], {
        encoding: "utf8",
        env: {
          PATH: `${fakes}:${process.env["PATH"]}`,
          FAKE_LOG: log,
          ...(command !== undefined && { SSH_ORIGINAL_COMMAND: command }),
        },
      });
    };

    test("writes the digest and starts the portal's deploy unit, its environment from its path", () => {
      const r = forced(B);
      expect([r.status, r.stderr]).toEqual([0, ""]);
      expect(state("portal.digest.next")).toBe(B);
      expect(state("digest.next")).toBeUndefined();
      expect(calls()).toEqual([`sudo systemctl start x402-portal-deploy@${ENV}`]);
    });

    test.each([
      ["nothing", undefined],
      ["a tag", "latest"],
      ["a short digest", "sha256:abc"],
      ["an upper-case digest", `sha256:${"A".repeat(64)}`],
      ["a command after the digest", `${B}; systemctl start x402-deploy@${ENV}`],
      ["a command", `systemctl start x402-deploy@${ENV}`],
    ])("refuses %s", (_, command) => {
      const r = forced(command);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("expected an image digest");
      expect(state("portal.digest.next")).toBeUndefined();
      expect(calls()).toEqual([]);
    });
  });
});
