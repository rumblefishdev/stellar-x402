// The metrics agent's key crosses three files: the unit decrypts it for a uid, Compose mounts it as
// a secret, and prometheus.yml reads that secret. A rename in one, or another uid, leaves the agent
// without its key, and nothing but the admin step or the VM's silence rule would show it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const DEPLOY = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${DEPLOY}/${path}`, "utf8");
const UNIT = read("systemd/x402-metrics.service");
const COMPOSE = read("metrics/compose.yaml");
const CONFIG = read("metrics/prometheus.yml");

describe("the metrics agent's key", () => {
  test("is the one secret the unit decrypts, Compose mounts and prometheus.yml reads", () => {
    const creds = UNIT.match(/^ExecStartPre=\S*x402-creds metrics (.+)$/m)![1]!.split(" ");
    const secrets = COMPOSE.match(/^ {4}secrets:\n((?: {6}- .*\n)+)/m)![1]!
      .trim()
      .split("\n")
      .map((l) => l.trim().replace(/^- /, ""));
    // 65534 is `nobody`, the user prom/prometheus runs as; Compose's file secrets keep the
    // host's owner and mode, so another uid couldn't read the key.
    expect(creds).toEqual(secrets.map((s) => `${s}:65534`));
    expect(COMPOSE).not.toMatch(/^\s+user:/m);
    for (const secret of secrets) {
      expect(COMPOSE).toContain(
        `  ${secret}:\n    file: \${SECRETS_DIR:-/run/x402/metrics}/${secret}\n`,
      );
      expect(CONFIG).toContain(`key_file: /run/secrets/${secret}\n`);
    }
  });
});
