import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SellerFetchError, type SellerFetchCode } from "@stellar-x402/seller-fetch";
/** Closed set of error codes; an agent branches on `error.code`, never on the message. */
export type ErrorCode =
  | "upstream_error"
  | "invalid_input"
  | "invalid_cursor"
  | "resource_not_found"
  | "unsafe_url"
  | "unsupported_payment"
  | "response_too_large"
  | "asset_not_allowed"
  | "over_price_limit"
  | "over_budget"
  | "insufficient_funds"
  | "payer_trustline_missing"
  | "payto_trustline_missing"
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
 * The tool code for each seller-fetch cause. An agent acts on fewer distinctions than the guard
 * makes: a URL it must not retry, a response too large, or a seller it may try again.
 */
const SELLER_FETCH_CODES: Record<SellerFetchCode, ErrorCode> = {
  not_a_url: "unsafe_url",
  not_https: "unsafe_url",
  not_public: "unsafe_url",
  redirect: "unsafe_url",
  response_too_large: "response_too_large",
  timeout: "upstream_error",
  network: "upstream_error",
};

/**
 * The tool error a failure stands for: a seller-fetch refusal takes its tool code and keeps its
 * message; its own code leads the detail, so the log still names the exact cause (`redirect`,
 * `timeout`, …). Any other error gives `undefined`: the caller decides what it means.
 */
export function asToolError(error: unknown): ToolError | undefined {
  if (error instanceof ToolError) return error;
  if (error instanceof SellerFetchError) {
    const detail = error.detail ? `${error.code}: ${error.detail}` : error.code;
    return new ToolError(SELLER_FETCH_CODES[error.code], error.message, detail);
  }
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
