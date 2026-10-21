import { checkChannel, type SorobanRpc } from "@stellar-x402/signer-pool";

/**
 * The startup check (AD-12): every channel has its master key at weight 0 and the facilitator
 * key as its only signer, so no other key can move it. Throws an error that names each failing
 * channel with its problem, or with the error its read failed with.
 */
export async function checkChannels(
  rpc: Pick<SorobanRpc, "getAccountEntry">,
  channels: readonly string[],
  facilitator: string,
): Promise<void> {
  const results = await Promise.allSettled(
    channels.map((channel) => checkChannel(rpc, channel, facilitator)),
  );
  const failures = results.flatMap((result, i) => {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return [`${channels[i]}: ${reason}`];
    }
    return result.value === undefined ? [] : [`${channels[i]}: ${result.value}`];
  });
  if (failures.length > 0) {
    throw new Error(`channels failed the startup check: ${failures.join("; ")}`);
  }
}
