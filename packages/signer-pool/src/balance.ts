import type { xdr } from "@stellar/stellar-sdk";
import type { SorobanRpc } from "./types.js";

const BASE_RESERVE = 5_000_000n; // 0.5 XLM in stroops

export interface BalanceReport {
  address: string;
  balanceStroops: bigint;
  /** The account's minimum balance from its reserves; it cannot be spent on fees. */
  reserveStroops: bigint;
  /** Balance minus reserve and selling liabilities: what fees can draw on. */
  spendableStroops: bigint;
  /** How many more settlements the spendable balance pays for at `feePerSettlementStroops`. */
  settlementsLeft: number;
  /** True when `spendableStroops` is below `minSpendableStroops`. */
  low: boolean;
}

export interface BalanceCheckOptions {
  /** Alert threshold. Default 100 XLM, about 24,000 settlements at 0006's ~41,000 stroops. */
  minSpendableStroops?: bigint;
  /** Fee assumed per settlement for `settlementsLeft`. Default 45,000 stroops. */
  feePerSettlementStroops?: bigint;
}

/**
 * Reads the facilitator account, which pays every fee bump, and reports how much it can still
 * spend. Run it on a timer and alert when `low` is true.
 */
export async function checkFacilitatorBalance(
  rpc: Pick<SorobanRpc, "getAccountEntry">,
  address: string,
  opts: BalanceCheckOptions = {},
): Promise<BalanceReport> {
  const minSpendable = opts.minSpendableStroops ?? 1_000_000_000n;
  const perSettlement = opts.feePerSettlementStroops ?? 45_000n;
  const entry = await rpc.getAccountEntry(address);
  const balance = entry.balance().toBigInt();
  const { sponsoring, sponsored, selling } = extensions(entry);
  const reserve = (2n + BigInt(entry.numSubEntries()) + sponsoring - sponsored) * BASE_RESERVE;
  const spendable = balance - reserve - selling;
  const clamped = spendable > 0n ? spendable : 0n;
  return {
    address,
    balanceStroops: balance,
    reserveStroops: reserve,
    spendableStroops: clamped,
    settlementsLeft: Number(clamped / perSettlement),
    low: clamped < minSpendable,
  };
}

/** Selling liabilities (ext v1) and sponsorship counts (ext v1 → v2), when present. */
function extensions(entry: xdr.AccountEntry) {
  const out = { sponsoring: 0n, sponsored: 0n, selling: 0n };
  const ext = entry.ext();
  if (ext.switch() !== 1) return out;
  const v1 = ext.v1();
  out.selling = v1.liabilities().selling().toBigInt();
  const ext2 = v1.ext();
  if (ext2.switch() !== 2) return out;
  out.sponsoring = BigInt(ext2.v2().numSponsoring());
  out.sponsored = BigInt(ext2.v2().numSponsored());
  return out;
}
