import { rpc } from "@stellar/stellar-sdk";
import { rpcEndpointName } from "../logger.js";

/**
 * The startup check that every `RPC_URLS` entry serves the configured network. An RPC of another
 * network answers every channel read with no entry, so once calls fail over to it the pool would
 * retire live channels as missing. An entry that doesn't answer fails the check too. Throws an
 * error that names each failing entry by its index, never its URL (ADR 0011).
 */
export async function checkRpcNetworks(urls: readonly string[], passphrase: string): Promise<void> {
  const results = await Promise.allSettled(
    urls.map((url) => new rpc.Server(url, { allowHttp: url.startsWith("http:") }).getNetwork()),
  );
  const failures = results.flatMap((result, i) => {
    const name = rpcEndpointName(urls[i]!, i);
    if (result.status === "rejected") {
      // `rpc.Server` throws a JSON-RPC error answer as the plain `{ code, message }` object.
      const reason =
        result.reason instanceof Error ? result.reason.message : JSON.stringify(result.reason);
      return [`${name}: ${reason}`];
    }
    return result.value.passphrase === passphrase
      ? []
      : [`${name}: serves "${result.value.passphrase}"`];
  });
  if (failures.length > 0) {
    throw new Error(
      `RPC_URLS failed the network check, expected "${passphrase}": ${failures.join("; ")}`,
    );
  }
}
