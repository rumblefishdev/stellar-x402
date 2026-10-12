import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Closed set of error codes; an agent branches on `error.code`, never on the message. */
export const ERROR_CODES = ["resource_not_found", "upstream_error"] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

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
