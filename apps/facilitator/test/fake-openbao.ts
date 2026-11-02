import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Keypair } from "@stellar/stellar-sdk";

/**
 * OpenBao as the signer sees it, on a unix socket: an AppRole login and a Transit signature with
 * `key`, as OpenBao's ed25519 keys sign. Tests and local runs sign through it, so they take the
 * same path as production; `openbao-signer.openbao.test.ts` holds the signer to a real server.
 */
export interface FakeOpenBao {
  socketPath: string;
  logins: number;
  signs: { token: string | undefined; input: Buffer; keyVersion: unknown }[];
  /** What signs: the configured key, or another one. */
  key: Keypair;
  /** Seconds a token lives, as `lease_duration`. */
  leaseSeconds: number;
  /** A status for every request, e.g. 503 when sealed. */
  status?: number;
  /** A status for logins only. */
  loginStatus?: number;
  /** Never answers. */
  hang?: boolean;
  close(): void;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text) as Record<string, unknown>;
}

export async function fakeOpenBao(key: Keypair): Promise<FakeOpenBao> {
  const dir = mkdtempSync(join(tmpdir(), "bao-"));
  const fake: FakeOpenBao = {
    socketPath: join(dir, "bao.sock"),
    logins: 0,
    signs: [],
    key,
    leaseSeconds: 3_600,
    close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  const server = createServer(async (req, res) => {
    if (fake.hang) return;
    const json = await body(req);
    const answer = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (fake.status) return answer(fake.status, { errors: ["Vault is sealed"] });
    if (req.url === "/v1/auth/approle/login") {
      if (fake.loginStatus)
        return answer(fake.loginStatus, { errors: ["invalid role or secret ID"] });
      fake.logins++;
      return answer(200, {
        auth: { client_token: `s.token-${fake.logins}`, lease_duration: fake.leaseSeconds },
      });
    }
    if (req.url === "/v1/transit/sign/stellar-testnet") {
      const input = Buffer.from(json.input as string, "base64");
      fake.signs.push({
        token: req.headers["x-vault-token"] as string | undefined,
        input,
        keyVersion: json.key_version,
      });
      const signature = fake.key.sign(input).toString("base64");
      return answer(200, { data: { key_version: 1, signature: `vault:v1:${signature}` } });
    }
    answer(404, { errors: ["no handler"] });
  });
  // A leftover server never holds a test run or a script open.
  server.unref();
  await new Promise<void>((resolve) => server.listen(fake.socketPath, resolve));
  return fake;
}

/** The facilitator's signer settings for `address`; without a server, no signature can succeed. */
export function signerEnv(address: string, socketPath = "/nonexistent/openbao.sock") {
  return {
    FACILITATOR_ADDRESS: address,
    OPENBAO_SOCKET: socketPath,
    OPENBAO_KEY: "stellar-testnet",
    OPENBAO_KEY_VERSION: "1",
    OPENBAO_ROLE_ID: "role",
    OPENBAO_SECRET_ID: "secret-id",
  };
}
