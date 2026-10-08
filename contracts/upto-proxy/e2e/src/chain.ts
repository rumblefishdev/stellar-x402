import {
  Account,
  Address,
  Contract,
  type Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  xdr,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

export const PASSPHRASE = Networks.TESTNET;
export const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
export const server = new rpc.Server(RPC_URL);

export const explorerLink = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

/** Read-only contract call through simulation; nothing is signed or sent. */
export async function readContract(
  contract: string,
  method: string,
  args: xdr.ScVal[],
  source: string,
): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error(`${method} on ${contract} failed: ${"error" in sim ? sim.error : "no result"}`);
  }
  return scValToNative(sim.result.retval);
}

export const tokenBalance = async (token: string, id: string, source: string) =>
  BigInt(
    (await readContract(token, "balance", [Address.fromString(id).toScVal()], source)) as bigint,
  );

export async function accountExists(address: string): Promise<boolean> {
  try {
    await server.getAccountEntry(address);
    return true;
  } catch {
    return false;
  }
}

export async function fundIfMissing(address: string): Promise<void> {
  if (!(await accountExists(address))) await server.fundAddress(address);
}

export async function xlmBalance(address: string): Promise<bigint> {
  return BigInt((await server.getAccountEntry(address)).balance().toString());
}

/** Builds, signs, sends and waits for a classic or prepared Soroban transaction. */
export async function sendAndWait(
  source: Keypair,
  operations: xdr.Operation[],
  signers: Keypair[] = [],
  { soroban = false } = {},
): Promise<string> {
  const builder = new TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: "10000",
    networkPassphrase: PASSPHRASE,
  }).setTimeout(60);
  for (const op of operations) builder.addOperation(op);
  let tx = builder.build();
  if (soroban) tx = await server.prepareTransaction(tx);
  tx.sign(source, ...signers);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(
      `send failed: ${sent.status} ${sent.errorResult?.result().switch().name ?? ""}`,
    );
  }
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} ended ${done.status}`);
  }
  return sent.hash;
}

/** What one settlement cost and who paid for it, read back from the chain. */
export interface TxReport {
  hash: string;
  link: string;
  ledger: number;
  feeChargedStroops: string;
  resourceFeeStroops: string;
  instructions: number;
  diskReadBytes: number;
  writeBytes: number;
  envelopeBytes: number;
  /** Fee-bump payer, inner transaction source and operation source. */
  feeSource: string;
  txSource: string;
  opSource: string | undefined;
  /** Decoded `upto_settled` events emitted by the proxy. */
  events: Record<string, unknown>[];
}

/** The G… address behind a (possibly muxed) account. */
function accountOf(account: xdr.MuxedAccount): string {
  return StrKey.encodeEd25519PublicKey(
    account.switch().name === "keyTypeMuxedEd25519"
      ? account.med25519().ed25519()
      : account.ed25519(),
  );
}

export async function txReport(hash: string, proxy: string): Promise<TxReport> {
  const tx = await server.getTransaction(hash);
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${hash} is ${tx.status}`);
  }
  const envelope = tx.envelopeXdr;
  if (envelope.switch().name !== "envelopeTypeTxFeeBump") {
    throw new Error(`transaction ${hash} is not a fee bump`);
  }
  const bump = envelope.feeBump().tx();
  const inner = bump.innerTx().v1().tx();
  const op = inner.operations()[0];
  const resources = inner.ext().sorobanData().resources();
  const events = (tx.events.contractEventsXdr[0] ?? [])
    .filter((e) => {
      const id = e.contractId();
      return (
        id && Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(id)).toString() === proxy
      );
    })
    .map((e) => {
      const body = e.body().v0();
      return {
        topics: body.topics().map((t) => scValToNative(t)),
        data: scValToNative(body.data()),
      };
    });
  return {
    hash,
    link: explorerLink(hash),
    ledger: tx.ledger,
    feeChargedStroops: tx.resultXdr.feeCharged().toString(),
    resourceFeeStroops: inner.ext().sorobanData().resourceFee().toString(),
    instructions: resources.instructions(),
    diskReadBytes: resources.diskReadBytes(),
    writeBytes: resources.writeBytes(),
    envelopeBytes: envelope.toXDR().length,
    feeSource: accountOf(bump.feeSource()),
    txSource: accountOf(inner.sourceAccount()),
    opSource: op?.sourceAccount() ? accountOf(op.sourceAccount()!) : undefined,
    events,
  };
}
