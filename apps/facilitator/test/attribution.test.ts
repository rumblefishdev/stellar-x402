import { describe, expect, it } from "vitest";
import type { FailureCause } from "@stellar-x402/signer-pool";
import { attribute, type Fault } from "../src/spend/attribution.js";
import type { AssetKind, AssetTier } from "../src/spend/asset-kinds.js";

const payer = "GPAYER";
const wallet = "CWALLET";
const payTo = "GPAYTO";
const asset = "CASSET";
const other = "COTHER";

describe("attribute", () => {
  it.each<
    [string, AssetKind, FailureCause | undefined, Fault[], { tier?: AssetTier; payer?: string }?]
  >([
    [
      "auth error is the payer's",
      "wasm",
      { error: { type: "sceAuth", code: "scecInvalidAction" } },
      ["payer"],
    ],
    [
      "auth error of a C-account payer, outside its frame",
      "sac",
      { error: { type: "sceAuth", code: "scecInvalidAction" }, contract: asset },
      ["payer"],
      { payer: wallet },
    ],
    // A seller who submitted the buyer's payload first: our transaction finds the nonce used.
    [
      "reused nonce (front-running), SAC",
      "sac",
      { error: { type: "sceAuth", code: "scecExistingValue" }, contract: asset },
      [],
    ],
    [
      "reused nonce (front-running), wasm",
      "wasm",
      { error: { type: "sceAuth", code: "scecExistingValue" } },
      [],
    ],
    // Not a front-run: that names the token (testnet, `front-run-testnet.json`). Here the
    // wallet's own nested auth reused an entry.
    [
      "reused nonce raised in a C-account payer's own frame",
      "sac",
      { error: { type: "sceAuth", code: "scecExistingValue" }, contract: wallet },
      ["payer"],
      { payer: wallet },
    ],
    [
      "error from the payer's own contract",
      "sac",
      { contract: payer, opCode: "invokeHostFunctionTrapped" },
      ["payer"],
    ],
    [
      "SAC error 5",
      "sac",
      { error: { type: "sceContract", code: "5" }, contract: asset },
      ["payer"],
    ],
    [
      "SAC error 9",
      "sac",
      { error: { type: "sceContract", code: "9" }, contract: asset },
      ["payer"],
    ],
    [
      "SAC error 10",
      "sac",
      { error: { type: "sceContract", code: "10" }, contract: asset },
      ["payer"],
    ],
    [
      "SAC error 11 naming payTo",
      "sac",
      { error: { type: "sceContract", code: "11" }, contract: asset, data: [payTo] },
      ["payTo"],
    ],
    [
      "SAC error 13 naming payTo alone",
      "sac",
      { error: { type: "sceContract", code: "13" }, contract: asset, data: [payTo] },
      ["payTo"],
    ],
    // Anyone can wrap their own classic asset: on another token, the payTo error may be staged.
    [
      "SAC error 11 naming payTo, other tier",
      "sac",
      { error: { type: "sceContract", code: "11" }, contract: asset, data: [payTo] },
      ["payer"],
      { tier: "other" },
    ],
    [
      "SAC error 13 naming payTo alone, other tier",
      "sac",
      { error: { type: "sceContract", code: "13" }, contract: asset, data: [payTo] },
      ["payer"],
      { tier: "other" },
    ],
    [
      "SAC error 13 naming payer and payTo",
      "sac",
      { error: { type: "sceContract", code: "13" }, contract: asset, data: [payer, payTo] },
      ["payer"],
    ],
    [
      "SAC other contract error naming payTo",
      "sac",
      { error: { type: "sceContract", code: "1" }, contract: asset, data: [payTo] },
      ["payer"],
    ],
    [
      "SAC error 11 from a third contract",
      "sac",
      { error: { type: "sceContract", code: "11" }, contract: other, data: [payTo] },
      ["payer"],
    ],
    [
      "SAC error 11 not naming payTo",
      "sac",
      { error: { type: "sceContract", code: "11" }, contract: asset, data: [payer] },
      ["payer"],
    ],
    [
      "SAC error 13 without data",
      "sac",
      { error: { type: "sceContract", code: "13" }, contract: asset },
      ["payer"],
    ],
    [
      "wasm token's own error",
      "wasm",
      { error: { type: "sceContract", code: "3" }, contract: asset },
      ["asset", "payer"],
    ],
    [
      "wasm resource limit",
      "wasm",
      { opCode: "invokeHostFunctionResourceLimitExceeded" },
      ["asset", "payer"],
    ],
    [
      "wasm insufficient refundable fee",
      "wasm",
      { opCode: "invokeHostFunctionInsufficientRefundableFee" },
      ["asset", "payer"],
    ],
    ["SAC resource limit", "sac", { opCode: "invokeHostFunctionResourceLimitExceeded" }, ["ours"]],
    [
      "SAC insufficient refundable fee",
      "sac",
      { opCode: "invokeHostFunctionInsufficientRefundableFee" },
      ["ours"],
    ],
    ["SAC entry archived", "sac", { opCode: "invokeHostFunctionEntryArchived" }, ["ours"]],
    // A C-account's `__check_auth` ran in the transaction and may have used the resources.
    [
      "SAC resource limit, C-account payer",
      "sac",
      { opCode: "invokeHostFunctionResourceLimitExceeded" },
      ["payer"],
      { payer: wallet },
    ],
    [
      "SAC insufficient refundable fee, C-account payer",
      "sac",
      { opCode: "invokeHostFunctionInsufficientRefundableFee" },
      ["payer"],
      { payer: wallet },
    ],
    [
      "SAC entry archived, C-account payer",
      "sac",
      { opCode: "invokeHostFunctionEntryArchived" },
      ["ours"],
      { payer: wallet },
    ],
    [
      "SAC unknown trap",
      "sac",
      { opCode: "invokeHostFunctionTrapped", contract: other },
      ["payer"],
    ],
    [
      "wasm unknown trap",
      "wasm",
      { opCode: "invokeHostFunctionTrapped", contract: other },
      ["payer", "asset"],
    ],
    ["no diagnostics, SAC", "sac", undefined, ["payer"]],
    ["no diagnostics, wasm", "wasm", undefined, ["payer", "asset"]],
    ["empty cause, wasm", "wasm", {}, ["payer", "asset"]],
  ])("%s", (_name, kind, failure, expected, opts = {}) => {
    const { tier = "known", payer: from = payer } = opts;
    const got = attribute(failure, { kind, tier, payer: from, payTo, asset });
    expect(new Set(got)).toEqual(new Set(expected));
    expect(got).toHaveLength(expected.length);
  });
});
