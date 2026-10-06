/** Whether an RPC error says the account or entry does not exist (`rpc.Server` throws these). */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}
