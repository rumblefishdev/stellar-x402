import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { SellerFetchError, guardedFetch, type SellerLimits } from "@stellar-x402/seller-fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import type { PaymentRequired } from "@x402/core/types";

/** Why a seller gave no usable answer; `detail` is for logs and the attempt's row only. */
export type SellerAnswer =
  | { ok: true; paymentRequired: PaymentRequired }
  | {
      ok: false;
      reason: SellerFetchError["code"] | "not_402" | "unreadable_402" | "no_tool" | "mcp_error";
      detail?: string;
    };

/**
 * Asks the seller for its listing with one unpaid request (0063) and reads its 402 terms as the
 * buyer's MCP server does (`packages/mcp` preview). The request goes through the seller-fetch
 * guard: public addresses only, no redirects, a deadline and a body cap.
 */
export async function askSeller(
  request: { url: string; method: string; body?: string },
  limits: SellerLimits,
): Promise<SellerAnswer> {
  let response: Response;
  try {
    response = await guardedFetch(limits, AbortSignal.timeout(limits.timeoutMs))(request.url, {
      method: request.method,
      headers: request.body === undefined ? undefined : { "content-type": "application/json" },
      body: request.body,
    });
  } catch (error) {
    if (error instanceof SellerFetchError) {
      return { ok: false, reason: error.code, detail: error.detail ?? error.message };
    }
    throw error;
  }
  if (response.status !== 402) {
    return { ok: false, reason: "not_402", detail: `status ${response.status}` };
  }
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? "");
  } catch (error) {
    return { ok: false, reason: "unreadable_402", detail: String(error) };
  }
  // Decoding checks the encoding only; the upstream schema checks the shape.
  const detail = shapeError(paymentRequired);
  if (detail) return { ok: false, reason: "unreadable_402", detail };
  return { ok: true, paymentRequired };
}

/**
 * Asks an MCP seller for its listing (0063 rows 5, 18): `initialize`, `tools/list`, then the tool
 * called without payment, its terms checked as an HTTP seller's are. A tool the server doesn't
 * list is told apart from a server that doesn't answer. Every request goes through the
 * seller-fetch guard, one deadline for them all.
 */
export async function askMcpSeller(
  url: string,
  call: { name: string; arguments: Record<string, unknown> },
  limits: SellerLimits,
): Promise<SellerAnswer> {
  const mcp = new Client({ name: "stellar-x402-facilitator", version: "0.0.0" });
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const fetch = guardedFetch(limits, deadline);
  // The SDK waits for an answer up to its own 60 s after the request is sent; the deadline ends
  // that wait too, for a server that accepts a call and never sends its result.
  const options = { signal: deadline };
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch });
  try {
    await mcp.connect(transport, options);
    let listed = false;
    let cursor: string | undefined;
    do {
      // A plain `tools/list`, not the SDK's `listTools()`: that one keeps each tool's output
      // schema and checks a 402 error result against it, though the 402 terms never match it
      // (SDK 1.30.1 `client/index.js:493`, 29 of 126 MCP listings measured on 2026-10-28).
      const page = await mcp.request(
        { method: "tools/list", params: { cursor } },
        ListToolsResultSchema,
        options,
      );
      listed = page.tools.some((tool) => tool.name === call.name);
      cursor = page.nextCursor;
    } while (!listed && cursor);
    if (!listed) return { ok: false, reason: "no_tool", detail: call.name };
    // The terms as upstream's payment wrapper sends them (`@x402/mcp` 2.28.0
    // `createPaymentRequiredResult`): an error result carrying them in `structuredContent`, or as
    // JSON in its first text (9 of 20 live sellers). Read here, not with upstream's MCP client,
    // whose schema reads terms with too many tags as no 402 at all.
    const result = await mcp.request(
      { method: "tools/call", params: call },
      CallToolResultSchema,
      options,
    );
    const [first] = result.content;
    let terms: unknown = result.structuredContent;
    if (terms === undefined && first?.type === "text") {
      try {
        terms = JSON.parse(first.text);
      } catch {
        // Plain text, such as the SDK's own "Input validation error": no terms in it.
        terms = undefined;
      }
    }
    if (!result.isError || typeof terms !== "object" || terms === null) {
      const text = first?.type === "text" ? first.text.slice(0, 200) : "";
      return { ok: false, reason: "not_402", detail: `the tool answered without terms: ${text}` };
    }
    const paymentRequired = terms as PaymentRequired;
    const detail = shapeError(paymentRequired);
    if (detail) return { ok: false, reason: "unreadable_402", detail };
    return { ok: true, paymentRequired };
  } catch (error) {
    if (error instanceof SellerFetchError) {
      return { ok: false, reason: error.code, detail: error.detail ?? error.message };
    }
    if (deadline.aborted) {
      const detail = `no answer within ${limits.timeoutMs} ms`;
      return { ok: false, reason: "upstream_error", detail };
    }
    // Not an MCP server, or one that answered the call with a protocol error.
    return { ok: false, reason: "mcp_error", detail: String(error) };
  } finally {
    // `close()` only aborts the client's requests; a stateful server's session ends with the
    // DELETE this sends (none without a session id). A failed one leaves the session to the
    // server's own cleanup, so it is logged and the answer stands.
    await transport.terminateSession().catch((error: unknown) => {
      console.warn("mcp_session_end_failed", url, String(error));
    });
    await mcp.close();
  }
}

/**
 * Why 402 terms don't have upstream's shape, or `undefined` when they do. `serviceName`, `tags` and
 * `iconUrl` are left to the listing's validator, which drops a malformed one as the Bazaar spec
 * says (`bazaar.md:380-391`) and as it does for a payment's copy; upstream's schema refuses the
 * whole 402 for one, as 47 of 400 live sellers would be (2026-10-28).
 */
function shapeError(paymentRequired: PaymentRequired): string | undefined {
  const resource = { ...paymentRequired.resource } as Record<string, unknown>;
  delete resource.serviceName;
  delete resource.tags;
  delete resource.iconUrl;
  const parsed = PaymentRequiredV2Schema.safeParse({ ...paymentRequired, resource });
  return parsed.success ? undefined : parsed.error.message;
}
