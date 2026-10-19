import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The run's testnet accounts, from `.env.e2e-testnet` at the repo root (git-ignored) or the file
 * named by `E2E_ENV_FILE`: a buyer holding testnet USDC and a seller with a USDC trustline.
 */
export interface Keys {
  buyerPublic: string;
  buyerSecret: string;
  sellerPublic: string;
}

export function readKeys(): Keys {
  const file =
    process.env.E2E_ENV_FILE ??
    fileURLToPath(new URL("../../../../.env.e2e-testnet", import.meta.url));
  const values = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!);
  }
  const need = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is missing from ${file}`);
    return value;
  };
  return {
    buyerPublic: need("E2E_BUYER_PUBLIC"),
    buyerSecret: need("E2E_BUYER_SECRET"),
    sellerPublic: need("E2E_SELLER_PUBLIC"),
  };
}
