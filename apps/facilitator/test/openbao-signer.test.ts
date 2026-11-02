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
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBaoSigner, SignerError } from "../src/adapters/openbao-signer.js";
import { memoryMetrics } from "../src/metrics.js";
import { fakeOpenBao, type FakeOpenBao } from "./fake-openbao.js";

const KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const OTHER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const HOUR_S = 3_600;

const fakes: FakeOpenBao[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.close();
});
async function started(): Promise<FakeOpenBao> {
  const fake = await fakeOpenBao(KEY);
  fakes.push(fake);
  return fake;
}

function setup(fake: FakeOpenBao, clock = { now: 0 }, checkRetryMs?: number) {
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
    ...(checkRetryMs !== undefined && { checkRetryMs }),
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
    const fake = await started();
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
    const fake = await started();
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
    const fake = await started();
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

  it("fails a signature when a new login fails, although the old token still lasts (decision 11)", async () => {
    const fake = await started();
    const { signer, clock, metrics } = setup(fake);
    await sign(signer);
    clock.now = (HOUR_S - 60) * 1000;
    fake.loginStatus = 400;

    expect(await failure(sign(signer))).toMatchObject({ reason: "refused" });
    expect(fake.signs).toHaveLength(1);
    expect(signer.state()).toBe("failed");
    expect(metrics.value("signer_failures_total", { reason: "refused", step: "sign" })).toBe(1);
  });

  it("shares one login between signatures that need it at once", async () => {
    const fake = await started();
    const { signer } = setup(fake);
    await Promise.all([sign(signer), sign(signer), sign(signer)]);
    expect(fake.logins).toBe(1);
  });

  it("fails a signature when the login is refused, and the next one logs in again (decision 11)", async () => {
    const fake = await started();
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
    const fake = await started();
    const { signer } = setup(fake);
    fake.status = status;
    expect(await failure(sign(signer))).toMatchObject({ reason });
  });

  it("gives up on an OpenBao that doesn't answer within 1 s (decision 13)", async () => {
    const fake = await started();
    const { signer } = setup(fake);
    fake.hang = true;
    expect(await failure(sign(signer))).toMatchObject({ reason: "timeout" });
  });

  it("names a missing socket as unreachable", async () => {
    const fake = await started();
    const { signer } = setup({ ...fake, socketPath: join(tmpdir(), "no-such-openbao.sock") });
    expect(await failure(sign(signer))).toMatchObject({ reason: "unreachable" });
  });

  it("checks the key by signing a fixed value, and reports it in state() (decision 4)", async () => {
    const fake = await started();
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

  it("checks again while the check fails, and stops once it passes (decision 4)", async () => {
    const fake = await started();
    const { signer } = setup(fake, undefined, 5);
    fake.status = 503;
    await signer.check();
    expect(signer.state()).toBe("failed");

    fake.status = undefined;
    await vi.waitFor(() => expect(signer.state()).toBe("ok"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.signs).toHaveLength(1);
  });

  it.each([
    ["a refused login", (fake: FakeOpenBao) => (fake.loginStatus = 400), "refused"],
    ["a denied signature", (fake: FakeOpenBao) => (fake.status = 403), "denied"],
    ["another key's signature", (fake: FakeOpenBao) => (fake.key = OTHER), "address_mismatch"],
  ])("doesn't check again after %s, which time won't fix", async (_name, broken, reason) => {
    const fake = await started();
    const { signer, metrics } = setup(fake, undefined, 5);
    broken(fake);
    await signer.check();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signer.state()).toBe("failed");
    expect(metrics.value("signer_failures_total", { reason, step: "check" })).toBe(1);
  });

  it("stops checking again on close", async () => {
    const fake = await started();
    const { signer, metrics } = setup(fake, undefined, 5);
    fake.status = 503;
    await signer.check();
    signer.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(metrics.value("signer_failures_total", { reason: "sealed", step: "check" })).toBe(1);
  });
});
