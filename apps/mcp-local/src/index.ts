#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@stellar-x402/mcp";
import { type CliConfig, loadConfig } from "./config.js";

// stdout carries the MCP protocol, so everything else goes to stderr.
const log = (message: string) => console.error(`stellar-x402-mcp: ${message}`);

let config: CliConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
await createServer({ ...config, log }).connect(new StdioServerTransport());
log(
  config.payment
    ? `paying from ${config.payment.payer} on stellar:testnet; catalog ${config.discoveryUrl}`
    : `browsing only (no STELLAR_X402_SECRET_KEY); catalog ${config.discoveryUrl}`,
);
