import {
  Asset,
  BASE_FEE,
  Horizon,
  type Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

/** Testnet balances and transactions, read from Horizon. */

const HORIZON = "https://horizon-testnet.stellar.org";
/** Circle's testnet USDC issuer, the asset of `USDC_TESTNET_ADDRESS`. */
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const server = new Horizon.Server(HORIZON);

/** A Horizon balance, "19.9980000", in atomic units (7 decimals). */
function atomic(balance: string): bigint {
  const [whole, fraction = ""] = balance.split(".");
  return BigInt(whole!) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

/** The account's testnet USDC in atomic units; an error when it has no USDC trustline. */
export async function usdcBalance(account: string): Promise<bigint> {
  const { balances } = await server.loadAccount(account);
  const usdc = balances.find(
    (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER,
  );
  if (!usdc) throw new Error(`${account} has no testnet USDC trustline`);
  return atomic(usdc.balance);
}

/** The account's XLM in stroops; the facilitator pays the fees, so a payment leaves it unchanged. */
export async function xlmBalance(account: string): Promise<bigint> {
  const { balances } = await server.loadAccount(account);
  return atomic(balances.find((b) => b.asset_type === "native")!.balance);
}

/**
 * The USDC moved by the transaction, from its effects: which account was debited and which
 * credited, and how much. It ties the hash to this payment, not to any change on a shared account.
 */
export async function usdcTransfer(
  hash: string,
): Promise<{ from?: string; to?: string; amount?: string }> {
  const { records } = await server.effects().forTransaction(hash).call();
  const usdc = records.filter((e) => "asset_code" in e && e.asset_code === "USDC") as {
    type: string;
    account: string;
    amount?: string;
  }[];
  const debit = usdc.find((e) => e.type === "account_debited");
  const credit = usdc.find((e) => e.type === "account_credited");
  return { from: debit?.account, to: credit?.account, amount: debit?.amount };
}

/** Whether the transaction is on the ledger and succeeded. */
export async function succeeded(hash: string): Promise<boolean> {
  return (await server.transactions().transaction(hash).call()).successful;
}

/** The sequence of the latest closed ledger. */
export async function latestLedger(): Promise<number> {
  const { records } = await server.ledgers().order("desc").limit(1).call();
  return records[0]!.sequence;
}

/** Opens a testnet USDC trustline on a friendbot account, so it can hold USDC but holds none. */
export async function openUsdcTrustline(account: Keypair): Promise<void> {
  const source = await server.loadAccount(account.publicKey());
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
    .setTimeout(60)
    .build();
  tx.sign(account);
  await server.submitTransaction(tx);
}

/** Creates and funds a new testnet account with friendbot: XLM only, no USDC trustline. */
export async function friendbot(account: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${account}`);
  if (!response.ok) throw new Error(`friendbot answered ${response.status}`);
}
