import { Address, Transaction, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "@stellar-x402/signer-pool";
import type { Logger } from "../logger.js";
import { withTimeout } from "./verify.js";

/** The payer holds no trustline to the payment's classic asset. */
export const PAYER_TRUSTLINE_REASON = "invalid_exact_stellar_payer_trustline_missing";
/** The seller's `payTo` holds no trustline to the payment's classic asset, or doesn't exist. */
export const PAYTO_TRUSTLINE_REASON = "invalid_exact_stellar_payto_trustline_missing";

/** The refusals whose `invalidMessage` is logged: only it names the account and the asset. */
export const TRUSTLINE_REASONS: ReadonlySet<string | undefined> = new Set([
  PAYER_TRUSTLINE_REASON,
  PAYTO_TRUSTLINE_REASON,
]);

/** The Stellar Asset Contract's `TrustlineMissingError`. */
const TRUSTLINE_MISSING_CODE = 13;
/** How long the whole lookup may take. It only names the cause of a refusal already decided. */
const LOOKUP_TIMEOUT_MS = 3_000;

export interface PaymentToExplain {
  /** The payload's transaction, as upstream simulated it. */
  transaction: Transaction;
  /** `requirements.asset`, the contract the transaction calls. */
  asset: string;
  payer: string;
  payTo: string;
}

export interface MissingTrustline {
  invalidReason: string;
  invalidMessage: string;
}

/** Names the missing trustline behind a failed simulation; `undefined` for any other cause. */
export type FindMissingTrustline = (
  payment: PaymentToExplain,
) => Promise<MissingTrustline | undefined>;

/**
 * Upstream drops the RPC's error, so after its `simulation_failed` we simulate again and read the
 * SAC's error event, which names the account. A SAC stops at its first failure, the payer's side
 * first, so the payer's answer can't speak for `payTo`. A failed lookup is `undefined` too: the
 * payment is refused either way, and upstream's answer is still true.
 */
export function createTrustlineLookup(
  deps: Pick<SorobanRpc, "simulateTransaction" | "getLedgerEntries">,
  network: string,
  logger: Pick<Logger, "warn">,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): FindMissingTrustline {
  return async (payment) => {
    try {
      return await withTimeout(lookup(deps, payment), timeoutMs, "trustline lookup");
    } catch (error) {
      logger.warn("trustline_lookup_failed", { network, error });
      return undefined;
    }
  };
}

async function lookup(
  deps: Pick<SorobanRpc, "simulateTransaction" | "getLedgerEntries">,
  { transaction, asset, payer, payTo }: PaymentToExplain,
): Promise<MissingTrustline | undefined> {
  const simulation = await deps.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationError(simulation)) return undefined;
  const account = accountWithoutTrustline(simulation.events, asset);
  if (account !== payer && account !== payTo) return undefined;
  // Any contract can emit this error and text; only a SAC's means a trustline.
  const assetName = await stellarAssetName(deps, asset);
  if (assetName === undefined) return undefined;
  // A lagging RPC can answer this too, so the message says which ledger it is true of.
  const ledger = simulation.latestLedger;
  const missing = `${account} has no ${assetName} trustline as of ledger ${ledger}: the account must exist and hold one`;
  return account === payer
    ? { invalidReason: PAYER_TRUSTLINE_REASON, invalidMessage: `${missing}; payTo wasn't checked` }
    : { invalidReason: PAYTO_TRUSTLINE_REASON, invalidMessage: missing };
}

/** The account in `asset`'s missing-trustline error event, if it emitted one. */
function accountWithoutTrustline(
  events: rpc.Api.SimulateTransactionErrorResponse["events"],
  asset: string,
): string | undefined {
  for (const diagnostic of events) {
    const event = diagnostic.event();
    const contractId = event.contractId();
    if (!contractId) continue;
    const contract = Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId));
    if (contract.toString() !== asset) continue;
    const body = event.body().v0();
    const code = body.topics()[1];
    if (code?.switch().name !== "scvError") continue;
    const error = code.error();
    if (error.switch().name !== "sceContract" || error.contractCode() !== TRUSTLINE_MISSING_CODE) {
      continue;
    }
    const data = body.data();
    const account = data.switch().name === "scvVec" ? data.vec()?.[1] : undefined;
    if (account?.switch().name === "scvAddress") return Address.fromScVal(account).toString();
  }
  return undefined;
}

/** The asset's `CODE:ISSUER` name when `asset` is a Stellar Asset Contract, or `undefined`. */
async function stellarAssetName(
  deps: Pick<SorobanRpc, "getLedgerEntries">,
  asset: string,
): Promise<string | undefined> {
  const { entries } = await deps.getLedgerEntries(
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
  return typeof name === "string" ? name : asset;
}
