import {
  Address,
  Asset,
  Keypair,
  MuxedAccount,
  StrKey,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { DEFAULT_TESTNET_RPC_URL } from "@x402/stellar";

/**
 * Whether an account can hold an asset today, read without signing anything.
 *
 * - `ok`: it can: it holds an authorized trustline, it is the asset's issuer, or the asset is XLM
 *   and the account exists.
 * - `missing`: it can't until its owner acts: no trustline, one the issuer hasn't authorized, or
 *   no account at all. `reason` says which.
 * - `unknown`: the check can't tell: the account is a contract (it holds the asset in the asset
 *   contract, without a trustline), the asset contract is not a Stellar Asset Contract, or the RPC
 *   didn't answer. `reason` says which.
 */
export interface TrustlineCheck {
  status: "ok" | "missing" | "unknown";
  /** The asset as `changeTrust` takes it (`CODE:ISSUER`, or `native`), once the contract was read. */
  classicAsset?: string;
  /** Why the status is `missing` or `unknown`. */
  reason?: string;
}

export interface TrustlineCheckOptions {
  /** The account: a `G…` address, or a muxed `M…` one, whose underlying `G…` is checked. */
  account: string;
  /** The asset contract (`C…`), as an offer's `asset` names it. */
  asset: string;
  /** `stellar:testnet` or `stellar:pubnet`. */
  network: string;
  /** A Stellar RPC for that network. Testnet has a default; pubnet has none, so it is required. */
  rpcUrl?: string;
  /** Each RPC request's time limit, in milliseconds. */
  timeoutMs?: number;
}

/** The ledger reads the check makes; a stand-in for `rpc.Server`'s in tests. */
export type GetLedgerEntries = (
  ...keys: xdr.LedgerKey[]
) => Promise<{ entries: { key: xdr.LedgerKey; val: xdr.LedgerEntryData }[] }>;

/** Trustline flag `AUTHORIZED_FLAG`: the account may hold and receive the asset. */
const AUTHORIZED = 1;

/**
 * Checks whether `account` can receive `asset`: a seller's `payTo` at start, or a buyer's account
 * before its first payment. It never throws: a failure to read is `unknown`, and the caller
 * decides whether to stop.
 */
export async function checkTrustline(options: TrustlineCheckOptions): Promise<TrustlineCheck> {
  const { network, timeoutMs = 10_000 } = options;
  const url =
    options.rpcUrl ?? (network === "stellar:testnet" ? DEFAULT_TESTNET_RPC_URL : undefined);
  if (!url) return { status: "unknown", reason: `no RPC URL given for ${network}` };
  let server: rpc.Server;
  try {
    server = new rpc.Server(url, { allowHttp: url.startsWith("http:"), timeout: timeoutMs });
  } catch (error) {
    return { status: "unknown", reason: `the RPC URL can't be used: ${String(error)}` };
  }
  return lookUpTrustline((...keys) => server.getLedgerEntries(...keys), options);
}

/** The check over any ledger reader; `checkTrustline` gives it the RPC's. */
export async function lookUpTrustline(
  getLedgerEntries: GetLedgerEntries,
  { account, asset }: Pick<TrustlineCheckOptions, "account" | "asset">,
): Promise<TrustlineCheck> {
  const holder = baseAccount(account);
  if (holder === "contract") {
    return {
      status: "unknown",
      reason: "the account is a contract, which holds the asset without a trustline",
    };
  }
  if (holder === undefined) return { status: "unknown", reason: "not an account address" };
  if (!StrKey.isValidContract(asset))
    return { status: "unknown", reason: "not a contract address" };

  let classicAsset: string | undefined;
  let entries: { key: xdr.LedgerKey; val: xdr.LedgerEntryData }[];
  try {
    classicAsset = await stellarAssetName(getLedgerEntries, asset);
    if (classicAsset === undefined) {
      return { status: "unknown", reason: "the asset contract is not a Stellar Asset Contract" };
    }
    const classic = parseClassic(classicAsset);
    if (classic === undefined) {
      return { status: "unknown", classicAsset, reason: "the asset's name can't be read" };
    }
    if (!classic.isNative() && classic.getIssuer() === holder)
      return { status: "ok", classicAsset };
    const accountKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(holder).xdrAccountId() }),
    );
    const keys = [accountKey];
    if (!classic.isNative()) {
      keys.push(
        xdr.LedgerKey.trustline(
          new xdr.LedgerKeyTrustLine({
            accountId: Keypair.fromPublicKey(holder).xdrAccountId(),
            asset: classic.toTrustLineXDRObject(),
          }),
        ),
      );
    }
    ({ entries } = await getLedgerEntries(...keys));
  } catch (error) {
    return { status: "unknown", classicAsset, reason: `the RPC didn't answer: ${String(error)}` };
  }

  const found = (type: string) => entries.find((entry) => entry.val.switch().name === type);
  if (!found("account"))
    return { status: "missing", classicAsset, reason: "the account does not exist" };
  if (classicAsset === "native") return { status: "ok", classicAsset };
  const trustline = found("trustline");
  if (!trustline) return { status: "missing", classicAsset, reason: "no trustline" };
  if ((trustline.val.trustLine().flags() & AUTHORIZED) === 0) {
    return {
      status: "missing",
      classicAsset,
      reason: "the issuer has not authorized the trustline",
    };
  }
  return { status: "ok", classicAsset };
}

/** The `G…` account behind an address; `contract` for a `C…` one, `undefined` for anything else. */
function baseAccount(address: string): string | "contract" | undefined {
  if (StrKey.isValidEd25519PublicKey(address)) return address;
  if (StrKey.isValidContract(address)) return "contract";
  if (StrKey.isValidMed25519PublicKey(address)) {
    return MuxedAccount.fromAddress(address, "0").baseAccount().accountId();
  }
  return undefined;
}

/** `CODE:ISSUER` or `native` as an `Asset`; `undefined` for any other text. */
function parseClassic(name: string): Asset | undefined {
  if (name === "native") return Asset.native();
  const [code, issuer, ...rest] = name.split(":");
  if (rest.length > 0 || !code || !issuer) return undefined;
  try {
    return new Asset(code, issuer);
  } catch {
    return undefined;
  }
}

/**
 * The asset's name (`CODE:ISSUER`, or `native`) when `asset` is a Stellar Asset Contract, read from
 * its instance; `undefined` for any other contract. As the facilitator's own lookup.
 */
async function stellarAssetName(
  getLedgerEntries: GetLedgerEntries,
  asset: string,
): Promise<string | undefined> {
  const { entries } = await getLedgerEntries(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(asset).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ),
  );
  const instance = entries[0]?.val.contractData().val().instance();
  if (instance?.executable().switch().name !== "contractExecutableStellarAsset") return undefined;
  const metadata = (instance.storage() ?? []).find(
    (entry) =>
      entry.key().switch().name === "scvSymbol" && entry.key().sym().toString() === "METADATA",
  );
  const name = metadata ? (scValToNative(metadata.val()) as { name?: unknown }).name : undefined;
  return typeof name === "string" ? name : undefined;
}
