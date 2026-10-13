import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
/** Closed set of error codes; an agent branches on `error.code`, never on the message. */
export type ErrorCode =
  | "upstream_error"
  | "invalid_input"
  | "resource_not_found"
  | "unsafe_url"
  | "unsupported_payment"
  | "response_too_large"
  | "asset_not_allowed"
  | "over_price_limit"
  | "over_budget"
  | "insufficient_funds"
  | "payment_failed"
  | "payment_rejected"
  | "payment_unknown";

/**
 * A failure with its code. `message` is safe to show the agent; `detail` (a library or seller error)
 * goes only to the server log.
 */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export function toolError(code: ErrorCode, message: string): CallToolResult {
  const error = { code, message };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    structuredContent: { error },
  };
}

export function toolResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
