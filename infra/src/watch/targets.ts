// What the Watch stack hands its Lambda, and how the Lambda reads it back: one JSON environment
// variable, built from the infra config at synth and checked again at the Lambda's start.
import { isStellarNetwork } from "@stellar-x402/config";
import { StrKey } from "@stellar/stellar-sdk";
import { isHttpsUrl } from "../lib/https-url.js";
import type { WatchTarget } from "./balance.js";
import type { ProtocolTarget } from "./protocol.js";

export const TARGETS_ENV = "WATCH_TARGETS";

/** Parses `WATCH_TARGETS`, refusing anything the stack wouldn't have written. */
export function parseTargets(raw: string | undefined): WatchTarget[] {
  if (!raw) throw new Error(`${TARGETS_ENV} is not set`);
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${TARGETS_ENV} must be a non-empty list`);
  return value.map((t: unknown, i) => {
    const { network, feeAccount, rpcUrl } = (t ?? {}) as Record<string, unknown>;
    if (typeof network !== "string" || !isStellarNetwork(network))
      throw new Error(`${TARGETS_ENV}[${i}].network is not known`);
    if (typeof feeAccount !== "string" || !StrKey.isValidEd25519PublicKey(feeAccount))
      throw new Error(`${TARGETS_ENV}[${i}].feeAccount is not a G... address`);
    if (!isHttpsUrl(rpcUrl)) throw new Error(`${TARGETS_ENV}[${i}].rpcUrl must be an https:// URL`);
    return { network, feeAccount, rpcUrl };
  });
}

export const PROTOCOL_ENV = "WATCH_PROTOCOL";

/** Parses `WATCH_PROTOCOL`: the networks whose protocol the check reads, possibly none. */
export function parseProtocolTargets(raw: string | undefined): ProtocolTarget[] {
  if (raw === undefined || raw === "") return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error(`${PROTOCOL_ENV} must be a list`);
  return value.map((t: unknown, i) => {
    const { network, horizonUrl } = (t ?? {}) as Record<string, unknown>;
    if (typeof network !== "string" || !isStellarNetwork(network))
      throw new Error(`${PROTOCOL_ENV}[${i}].network is not known`);
    if (!isHttpsUrl(horizonUrl))
      throw new Error(`${PROTOCOL_ENV}[${i}].horizonUrl must be an https:// URL`);
    return { network, horizonUrl };
  });
}
