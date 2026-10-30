import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openBaoSigner } from "../src/adapters/openbao-signer.js";
import { memoryMetrics } from "../src/metrics.js";

// The signer against a real OpenBao (0036): a dev server, as CI's service container runs it,
// set up here with its root token. The signer reaches it through a unix socket, as in a deploy;
// the socket relays to the dev server's TCP port, since a container's socket can't reach a macOS
// host. Runs when TEST_OPENBAO_ADDR and TEST_OPENBAO_TOKEN are set (CI sets both).
const ADDR = process.env.TEST_OPENBAO_ADDR;
const ROOT = process.env.TEST_OPENBAO_TOKEN;
const KEY = `stellar-test-${Date.now()}`;
const ROLE = `signer-${Date.now()}`;

async function admin(method: string, path: string, body?: unknown) {
  const res = await fetch(`${ADDR}${path}`, {
    method,
    headers: { "X-Vault-Token": ROOT!, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? (JSON.parse(text) as { data: Record<string, unknown> }) : undefined;
}

describe.skipIf(!ADDR || !ROOT)("openBaoSigner against OpenBao", () => {
  const dir = mkdtempSync(join(tmpdir(), "bao-relay-"));
  const socketPath = join(dir, "bao.sock");
  let relay: Server;
  let address: string;
  let roleId: string;
  let secretId: string;

  beforeAll(async () => {
    const { hostname, port } = new URL(ADDR!);
    relay = createServer((client) => {
      const upstream = connect(Number(port), hostname);
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    await new Promise<void>((resolve) => relay.listen(socketPath, resolve));

    const mounts = (await admin("GET", "/v1/sys/mounts"))!.data;
    if (!("transit/" in mounts)) await admin("POST", "/v1/sys/mounts/transit", { type: "transit" });
    await admin("POST", `/v1/transit/keys/${KEY}`, { type: "ed25519", exportable: false });
    const key = (await admin("GET", `/v1/transit/keys/${KEY}`))!.data as {
      keys: Record<string, { public_key: string }>;
    };
    address = StrKey.encodeEd25519PublicKey(Buffer.from(key.keys["1"]!.public_key, "base64"));

    await admin("PUT", `/v1/sys/policies/acl/${ROLE}`, {
      policy: `path "transit/sign/${KEY}" { capabilities = ["update"] }`,
    });
    const auths = (await admin("GET", "/v1/sys/auth"))!.data;
    if (!("approle/" in auths)) await admin("POST", "/v1/sys/auth/approle", { type: "approle" });
    // As ADR 0013 sets it: an hour, not renewable past it. Under the 5-minute margin a 1-minute
    // token makes every signature log in again.
    await admin("POST", `/v1/auth/approle/role/${ROLE}`, {
      token_policies: [ROLE],
      token_ttl: "1m",
      token_max_ttl: "1m",
    });
    roleId = (await admin("GET", `/v1/auth/approle/role/${ROLE}/role-id`))!.data.role_id as string;
    secretId = (await admin("POST", `/v1/auth/approle/role/${ROLE}/secret-id`))!.data
      .secret_id as string;
  });

  afterAll(() => {
    relay?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const signer = (overrides: { address?: string; secretId?: string } = {}) => {
    const metrics = memoryMetrics();
    return {
      metrics,
      signer: openBaoSigner({
        address: overrides.address ?? address,
        socketPath,
        key: KEY,
        keyVersion: 1,
        roleId,
        secretId: overrides.secretId ?? secretId,
        network: "stellar:testnet",
        logger: { info: () => {}, warn: () => {} },
        metrics,
      }),
    };
  };

  const transaction = (): Transaction =>
    new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
      .setTimeout(60)
      .build();

  it("signs a transaction with the Transit key, logging in for each short-lived token", async () => {
    const { signer: s } = signer();
    for (let i = 0; i < 3; i++) {
      const tx = transaction();
      const { signedTxXdr } = await s.signTransaction(tx.toXDR(), {
        networkPassphrase: Networks.TESTNET,
      });
      const signed = TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET);
      expect(
        Keypair.fromPublicKey(address).verify(tx.hash(), signed.signatures[0]!.signature()),
      ).toBe(true);
    }
    await s.check();
    expect(s.state()).toBe("ok");
  });

  it("refuses the signature when the configured address isn't the Transit key's", async () => {
    const { signer: s } = signer({ address: Keypair.random().publicKey() });
    await expect(
      s.signTransaction(transaction().toXDR(), { networkPassphrase: Networks.TESTNET }),
    ).rejects.toMatchObject({ reason: "address_mismatch" });
  });

  it("names a wrong secret ID as refused", async () => {
    const { signer: s } = signer({ secretId: "00000000-0000-0000-0000-000000000000" });
    await expect(
      s.signTransaction(transaction().toXDR(), { networkPassphrase: Networks.TESTNET }),
    ).rejects.toMatchObject({ reason: "refused" });
  });
});
