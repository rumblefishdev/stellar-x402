import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SellerFetchError } from "@stellar-x402/seller-fetch";
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

/**
 * The tool error a failure stands for: a seller-fetch refusal keeps its code, message and detail.
 * Anything else is a bug, so it is not one.
 */
export function asToolError(error: unknown): ToolError | undefined {
  if (error instanceof ToolError) return error;
  if (error instanceof SellerFetchError)
    return new ToolError(error.code, error.message, error.detail);
  return undefined;
}

/**
 * An error is text only: MCP clients check `structuredContent` against the tool's output schema even
 * on an error, so the code travels as JSON in the text, `{"error":{"code":…,"message":…}}`.
 */
export function toolError(code: ErrorCode, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
  };
}

export function toolResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
