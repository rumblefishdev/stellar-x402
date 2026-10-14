/** Testnet balances and transactions, read from Horizon. */

const HORIZON = "https://horizon-testnet.stellar.org";
/** Circle's testnet USDC issuer, the asset of `USDC_TESTNET_ADDRESS`. */
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

async function get(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${HORIZON}${path}`);
  if (!response.ok) throw new Error(`Horizon ${path} answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/** The account's testnet USDC in atomic units (7 decimals); an error when it has no USDC trustline. */
export async function usdcBalance(account: string): Promise<bigint> {
  const { balances } = (await get(`/accounts/${account}`)) as {
    balances: { asset_code?: string; asset_issuer?: string; balance: string }[];
  };
  const usdc = balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
  if (!usdc) throw new Error(`${account} has no testnet USDC trustline`);
  const [whole, fraction = ""] = usdc.balance.split(".");
  return BigInt(whole!) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

/** The account's XLM in stroops; the facilitator pays the fees, so a payment leaves it unchanged. */
export async function xlmBalance(account: string): Promise<bigint> {
  const { balances } = (await get(`/accounts/${account}`)) as {
    balances: { asset_type: string; balance: string }[];
  };
  const [whole, fraction = ""] = balances
    .find((b) => b.asset_type === "native")!
    .balance.split(".");
  return BigInt(whole!) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

/**
 * The USDC moved by the transaction, from its effects: which account was debited and which
 * credited, and how much. It ties the hash to this payment, not to any change on a shared account.
 */
export async function usdcTransfer(
  hash: string,
): Promise<{ from?: string; to?: string; amount?: string }> {
  const { _embedded } = (await get(`/transactions/${hash}/effects`)) as {
    _embedded: {
      records: { type: string; account: string; amount?: string; asset_code?: string }[];
    };
  };
  const usdc = _embedded.records.filter((e) => e.asset_code === "USDC");
  const debit = usdc.find((e) => e.type === "account_debited");
  const credit = usdc.find((e) => e.type === "account_credited");
  return { from: debit?.account, to: credit?.account, amount: debit?.amount };
}

/** Whether the transaction is on the ledger and succeeded. */
export async function succeeded(hash: string): Promise<boolean> {
  const { successful } = (await get(`/transactions/${hash}`)) as { successful: boolean };
  return successful;
}

/** Creates and funds a new testnet account with friendbot: XLM only, no USDC trustline. */
export async function friendbot(account: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${account}`);
  if (!response.ok) throw new Error(`friendbot answered ${response.status}`);
}
