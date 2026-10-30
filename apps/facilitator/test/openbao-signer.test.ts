import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { openBaoSigner, SignerError } from "../src/adapters/openbao-signer.js";
import { memoryMetrics } from "../src/metrics.js";

// A fake OpenBao on a unix socket, answering the two calls the signer makes (0036): an AppRole
// login, and a Transit signature of the input with `key`, as OpenBao's ed25519 keys sign.

const KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const OTHER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const HOUR_S = 3_600;

interface Fake {
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
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text) as Record<string, unknown>;
}

async function fakeOpenBao(): Promise<Fake> {
  const dir = mkdtempSync(join(tmpdir(), "bao-"));
  dirs.push(dir);
  const fake: Fake = {
    socketPath: join(dir, "bao.sock"),
    logins: 0,
    signs: [],
    key: KEY,
    leaseSeconds: HOUR_S,
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
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(fake.socketPath, resolve));
  return fake;
}

function setup(fake: Fake, clock = { now: 0 }) {
  const metrics = memoryMetrics();
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const log = (event: string, fields?: Record<string, unknown>) => logs.push({ event, fields });
  const signer = openBaoSigner({
    address: KEY.publicKey(),
    socketPath: fake.socketPath,
    key: "stellar-testnet",
    keyVersion: 1,
    roleId: "role",
    secretId: "secret",
    network: "stellar:testnet",
    logger: { info: log, warn: log },
    metrics,
    now: () => clock.now,
  });
  return { signer, metrics, logs, clock };
}

function transaction(): Transaction {
  return new TransactionBuilder(new Account(OTHER.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(60)
    .build();
}

async function sign(signer: ReturnType<typeof setup>["signer"], tx = transaction()) {
  const { signedTxXdr } = await signer.signTransaction(tx.toXDR(), {
    networkPassphrase: Networks.TESTNET,
  });
  return TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET) as Transaction;
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("openBaoSigner", () => {
  it("signs the transaction's hash with the pinned key version and adds the signature", async () => {
    const fake = await fakeOpenBao();
    const { signer } = setup(fake);
    const tx = transaction();
    const signed = await sign(signer, tx);

    expect(fake.signs).toEqual([{ token: "s.token-1", input: tx.hash(), keyVersion: 1 }]);
    expect(signed.signatures).toHaveLength(1);
    expect(KEY.verify(tx.hash(), signed.signatures[0]!.signature())).toBe(true);
    expect(signer.address).toBe(KEY.publicKey());
    expect(signer.state()).toBe("ok");
  });

  it("refuses a signature by another key, on every signature (decision 12)", async () => {
    const fake = await fakeOpenBao();
    const { signer, metrics } = setup(fake);
    await sign(signer);
    fake.key = OTHER;

    const error = await failure(sign(signer));
    expect(error).toBeInstanceOf(SignerError);
    expect(error).toMatchObject({ reason: "address_mismatch" });
    expect(signer.state()).toBe("failed");
    expect(
      metrics.value("signer_failures_total", { reason: "address_mismatch", step: "sign" }),
    ).toBe(1);
  });

  it("keeps a token until less than 5 minutes are left, then logs in first (decision 10)", async () => {
    const fake = await fakeOpenBao();
    const { signer, clock } = setup(fake);
    await sign(signer);
    clock.now = (HOUR_S - 5 * 60) * 1000 - 1;
    await sign(signer);
    expect(fake.logins).toBe(1);

    clock.now = (HOUR_S - 5 * 60) * 1000;
    await sign(signer);
    expect(fake.logins).toBe(2);
    expect(fake.signs.map((s) => s.token)).toEqual(["s.token-1", "s.token-1", "s.token-2"]);
  });

  it("signs with the old token while it lasts when a new login fails (decision 10)", async () => {
    const fake = await fakeOpenBao();
    const { signer, clock, logs } = setup(fake);
    await sign(signer);
    clock.now = (HOUR_S - 60) * 1000;
    fake.loginStatus = 400;

    await sign(signer);
    expect(fake.signs.at(-1)!.token).toBe("s.token-1");
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "signer_failed",
        fields: expect.objectContaining({ step: "login", reason: "refused" }),
      }),
    );

    clock.now = HOUR_S * 1000;
    expect(await failure(sign(signer))).toMatchObject({ reason: "refused" });
  });

  it("shares one login between signatures that need it at once", async () => {
    const fake = await fakeOpenBao();
    const { signer } = setup(fake);
    await Promise.all([sign(signer), sign(signer), sign(signer)]);
    expect(fake.logins).toBe(1);
  });

  it("fails a signature when the login is refused, and the next one logs in again (decision 11)", async () => {
    const fake = await fakeOpenBao();
    const { signer, metrics } = setup(fake);
    fake.loginStatus = 400;
    expect(await failure(sign(signer))).toMatchObject({ reason: "refused" });
    expect(signer.state()).toBe("failed");
    expect(metrics.value("signer_failures_total", { reason: "refused", step: "sign" })).toBe(1);

    fake.loginStatus = undefined;
    await sign(signer);
    expect(fake.logins).toBe(1);
    expect(signer.state()).toBe("ok");
  });

  it.each([
    [503, "sealed"],
    [403, "denied"],
    [500, "error"],
  ])("names an answer %i as %s", async (status, reason) => {
    const fake = await fakeOpenBao();
    const { signer } = setup(fake);
    fake.status = status;
    expect(await failure(sign(signer))).toMatchObject({ reason });
  });

  it("gives up on an OpenBao that doesn't answer within 1 s (decision 13)", async () => {
    const fake = await fakeOpenBao();
    const { signer } = setup(fake);
    fake.hang = true;
    expect(await failure(sign(signer))).toMatchObject({ reason: "timeout" });
  });

  it("names a missing socket as unreachable", async () => {
    const fake = await fakeOpenBao();
    const { signer } = setup({ ...fake, socketPath: join(tmpdir(), "no-such-openbao.sock") });
    expect(await failure(sign(signer))).toMatchObject({ reason: "unreachable" });
  });

  it("checks the key by signing a fixed value, and reports it in state() (decision 4)", async () => {
    const fake = await fakeOpenBao();
    const { signer, logs } = setup(fake);
    expect(signer.state()).toBe("unchecked");
    await signer.check();
    expect(signer.state()).toBe("ok");
    expect(fake.signs).toHaveLength(1);

    fake.key = OTHER;
    await signer.check();
    expect(signer.state()).toBe("failed");
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "signer_failed",
        fields: expect.objectContaining({ step: "check", reason: "address_mismatch" }),
      }),
    );
  });
});
