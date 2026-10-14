# Comparison with existing x402 MCP servers

Read on 2026-10-14 from each repository's default branch (`gh api repos/<owner>/<repo>/contents/<path>`),
the installed `@x402/mcp@2.28.0` in `node_modules/.pnpm`, and ours at `origin/develop` plus open
PR #32 (`lore-0037-daily-budget`). File:line references are to those snapshots.

**Candidates.** Searched GitHub for "x402 mcp" / "x402 mcp server" (sorted by stars): no buyer-side
x402 MCP server has more than ~25 stars. Compared:

| # | Project | What it is | License · last push · stars (`gh api repos/…`) |
|---|---|---|---|
| A | `nirholas/x402-bridge` | MCP stdio server: pays any x402 URL, turns Bazaar entries into tools | Apache-2.0 · 2026-10-10 · 7 |
| B | `jamesbachini/x402-mcp-stellar` | MCP stdio server: pays any x402 URL in Stellar USDC | MIT · 2026-04-21 · 2 |
| C | `@x402/mcp` (x402-foundation/x402) | **Library, not a server**: pays for *MCP tools* (client wrapper) and charges for them (server wrapper) | Apache-2.0 · 2026-10-14 · 6,716 (whole monorepo) |
| C′ | upstream guide "MCP server with x402" (`docs/guides/mcp-server-with-x402.mdx`) | Example MCP server with one tool for one fixed paid endpoint | same repo |
| D | `ethanniser/x402-mcp` (the "Vercel x402-mcp") | **Library** for the Vercel AI SDK: paid MCP tools, x402 v1 (`x402@^0.6.6`) | MIT · 2025-12-06 · 22 |
| E | `up2itnow0822/agentpay-mcp` | MCP server: smart-contract wallet on Base, `x402_pay` plus ~25 wallet/DeFi tools | MIT · 2026-10-11 · 8 |
| — | **ours**: `packages/mcp` + `apps/mcp-local` | MCP stdio server: list, preview and pay Bazaar HTTP resources on Stellar | repo licence · open PR #32 |

C and D are libraries an MCP *client* or *seller* builds on; they are not a server an agent can be
pointed at, so several rows below are "n/a (library)".

### Networks

| | Networks · mainnet/testnet | Source |
|---|---|---|
| A | EVM (`eip155:*`, exact + batch-settlement) and Solana (`solana:*`); **no Stellar**; mainnet and testnet alike (wildcards); default catalog is Coinbase CDP (mainnet) | `src/x402-axios-client.js:153-165`; `src/bazaar-discover.js:27` |
| B | **Stellar only** (`stellar:*`, exact); testnet default, **pubnet allowed** by `STELLAR_NETWORK=stellar:pubnet` | `src/index.ts:37-45,126-136` |
| C | Any scheme registered in the `x402Client` (EVM, SVM, Stellar via `@x402/stellar`) | `dist/esm/index.mjs:171-190` |
| C′ | EVM Base Sepolia, Solana Devnet | guide lines 59-61, 115-125 |
| D | EVM and Solana (v1 network names) | `packages/x402-mcp/src/client.ts:86-94,104-130` |
| E | **Base only** (8453 mainnet, 84532 Sepolia) | `src/utils/x402-networks.ts:10-13` |
| ours | **Stellar testnet only**: only a testnet scheme is registered; the CLI refuses any other network | `apps/mcp-local/src/config.ts:33-39`; `packages/mcp/src/pay.ts:9` |

### Tools, and how catalog entries reach the model

| | Tools · catalog → model · seller text in tool descriptions? | Source |
|---|---|---|
| A | `call_paid_endpoint`, `list_bazaar_tools`, `refresh_bazaar`, plus **one dynamic tool per Bazaar entry** (default 20). The entry's description, its input JSON Schema (unbounded) and output example (cut at 1,500 chars) go **into the tool description** | `src/index.js:4-13,219-234`; `src/bazaar-discover.js:145-156` |
| B | `x402_wallet_info`, `x402_facilitator_supported`, `fetch_paid_resource`; **no catalog** | `src/index.ts:146-256` |
| C | n/a (library): wraps an MCP client's `callTool` with auto-payment | `dist/esm/index.mjs:426-510` |
| C′ | one tool, `get-data-from-resource-server`, for one URL from env; no catalog | guide lines 82, 121-122, 166-193 |
| D | n/a (library): adds AI-SDK tools for balance and *payment authorization the model calls itself* | `client.ts:135-245` |
| E | `x402_pay`, session tools, ~20 wallet/swap/bridge/escrow tools; no catalog listing | `src/index.ts:68-181` |
| ours | `list_resources` (paged list), `get_resource` (live 402 preview, unpaid), `call_paid_http`. Catalog text is returned as **tool output data**, cut to the `packages/bazaar` limits, never placed in tool descriptions | `packages/mcp/src/server.ts:33-39,80-88,123`; `catalog.ts:59-60` |

### Spend limits

| | Per payment | Per process | Per day | Payee / host allowlist | Source |
|---|---|---|---|---|---|
| A | yes, default 0.10 USDC (atomic) | yes, default 1.00 USDC; reserved before signing, **never released** on a signing failure | no | **payTo allowlist** and **host allowlist** (optional) | `src/x402-axios-client.js:86-129`; `src/url-guard.js:23-43,166-175,212-216` |
| B | **none** | none | none | none | `src/index.ts` (no check anywhere; the vendored client only validates the amount's format: `src/stellar/exact/client/scheme.ts:147-149`) |
| C | none built in: `autoPayment` defaults to true and `onPaymentRequested` to `() => true`; limits are the integrator's hooks | `dist/esm/index.mjs:186-187,474-505` |
| C′ | none; the guide only advises checking the selected requirement | guide lines 209-236 |
| D | yes, `maxPaymentValue`, default 0.10 USDC | no | no | no (network must match) | `client.ts:133,225-236` |
| E | yes, per call (`max_payment_eth`) and per tx in the wallet policy | — | **yes, daily limit enforced by the on-chain smart wallet** | **recipient allowlist** (on-chain policy) | `src/tools/x402.ts:284,386-419`; `src/tools/budget.ts:26-28,347-358` |
| ours | yes, per asset (atomic) | yes, per asset; counted before signing, given back only when signing fails (nothing sent) | **yes in PR #32**: optional, per key and asset, local file under a lock, UTC day | **asset allowlist only**; no payTo or host allowlist | `packages/mcp/src/pay.ts:11-12,88-131`; PR #32 `packages/mcp/src/daily.ts:6-26`, `apps/mcp-local/src/config.ts:52` |

Ours also refuses an authorization valid longer than 300 s (`pay.ts:27-30,91`); A, B and E accept
whatever `maxTimeoutSeconds` the seller sets (B's client turns it straight into the auth's ledger
expiry: `src/stellar/exact/client/scheme.ts:70-83`).

### Error reporting

| | Codes or free text | Source |
|---|---|---|
| A | **Free text**: `"<tool> failed: <err.message>"`, `isError: true`; the message can carry library and seller text | `src/index.js:116-122,196-198`; `src/content.js:18-23` |
| B | **Free text**: handler throws, the MCP SDK turns it into an error text | `src/index.ts:222-255` (no try/catch) |
| C | Plain `Error("Payment request denied")`, `"Payment aborted by hook"`; one coded error (`code: 402`, payment required) | `dist/esm/index.mjs:67-74,484-504` |
| D | Plain `Error` strings | `client.ts:225-236` |
| E | **Free text with emoji** (`❌ x402_pay failed …`); classes internally (`PostSettlementSpendError`, `DefiniteSpendFailure`) but the agent sees prose | `src/tools/x402.ts:574-624` |
| ours | **Closed list of 13 codes** in `{"error":{"code","message"}}`; causes go to the server log only | `packages/mcp/src/results.ts:2-41` |

### Address guard (SSRF)

| | https only · private ranges · DNS check · redirects | Source |
|---|---|---|
| A | https (http behind `MCP_BRIDGE_ALLOW_HTTP=1`, any host) · hand-written IPv4/IPv6 range list (no multicast, reserved, documentation, NAT64/6to4) · resolves all addresses **before** the request (a second lookup at connect can differ: DNS rebinding window) · redirects off (`maxRedirects: 0`) · catalog URL guarded too | `src/url-guard.js:51-160,189-247`; `src/x402-axios-client.js:184`; `src/bazaar-discover.js:122` |
| B | **none**: any URL, http included (the tool's own example is `http://localhost:3000`); redirects followed (fetch default) | `src/index.ts:188-191,222` |
| C | n/a (library; talks to an MCP server the integrator connected) | — |
| C′ | none; one fixed URL from env | guide lines 121-122 |
| E | no private-range check found (grep for `169.254`, `isPrivate`, `localhost` in `src/`: none); session requests refuse cross-origin redirects | `src/utils/session-fetch.ts:11-48` |
| ours | https only (`allowInsecureLocal` opens loopback only) · `ipaddr.js`, only `unicast` passes · checked **at connect** (undici lookup), IP literals checked up front · no redirects · body size capped after decompression | `packages/mcp/src/guard.ts:28-83,99-156` |

### Time limits

| | Per request or per call · signing bounded? | Source |
|---|---|---|
| A | 60 s **per request** (axios), so unpaid request + paid retry can reach 120 s, past the MCP client's 60 s default; signing not bounded; catalog 15 s | `src/x402-axios-client.js:176`; `src/bazaar-discover.js:125` |
| B | **none** (plain `fetch`, Soroban RPC calls in signing unbounded) | `src/index.ts:222` |
| C | probe 300 s, paid retry `min(maxTimeoutSeconds, 600 s)` per request | `dist/esm/index.mjs:123-159` |
| E | per request, 30 s default, 60 s max (`AbortSignal.timeout`) | `src/tools/x402.ts:221-228,315,449` |
| ours | **one deadline per call** (default 30 s) covering unpaid request, signing and paid retry; signing dropped past it, nothing sent; the configured value has no upper cap | `packages/mcp/src/pay.ts:36-51,72-75`; `guard.ts:92-99`; `apps/mcp-local/src/config.ts:41-43` |

### When the outcome of a sent payment is unknown

| | Behaviour | Source |
|---|---|---|
| A | not distinguished: the same `"… failed: <message>"` as a refusal before signing; the session counter keeps the amount | `src/index.js:116-122`; `src/x402-axios-client.js:119-126` |
| B | not distinguished; an exception becomes free text, `paymentMade` is only reported on success | `src/index.ts:226-247` |
| C | not distinguished (library throws) | `dist/esm/index.mjs:520-620` |
| E | **distinguished**: after broadcast, "failed after settlement. Do not resubmit", tx hash, amount; the spend intent is locked; optional idempotency key replays the first result; settlement persisted to history | `src/tools/x402.ts:458-500,574-597`; `idempotencyKey` schema at line 300 |
| ours | **distinguished**: `payment_unknown` once the signed payment left the process; `payment_rejected` for an explicit refusal; the amount stays spent either way; no idempotency key, no persisted history | `packages/mcp/src/pay.ts:159-170,222-251` |

### Key handling

| | Where the key comes from · can it reach logs/output? | Source |
|---|---|---|
| A | env `MCP_BRIDGE_EVM_PRIVATE_KEY` / `MCP_BRIDGE_SVM_PRIVATE_KEY` (also bare `EVM_PRIVATE_KEY`); not logged; parse errors name the variable, not the value | `src/signers.js:35-77` |
| B | env or a **`.env` file** next to the package (dotenv); logs the wallet address only; also holds a facilitator API key, attached only to requests to the facilitator's origin | `src/index.ts:19-22,74-92,122,261-268` |
| C / C′ | integrator's choice / env `EVM_PRIVATE_KEY`, `SVM_PRIVATE_KEY` (+ dotenv) | guide lines 86-91, 115-120 |
| E | env `AGENT_PRIVATE_KEY` (session key of a smart-contract wallet; the wallet's on-chain policy bounds it) | `src/utils/client.ts:48-70` |
| ours | env `STELLAR_X402_SECRET_KEY` only (no file); a malformed key is refused without repeating it; logs the buyer's public address | `apps/mcp-local/src/config.ts:47,83-86`; `apps/mcp-local/src/index.ts:18-21` |

### Conclusions

- **Only ours** combines Stellar with: a machine-readable error code list, a seller preview before
  paying (`get_resource`), catalog text kept out of tool descriptions, an address guard checked at
  connect time, one deadline per call that also bounds signing, and a cap on the authorization's lifetime.
- **Others have, ours lacks** (input to 0044): a payee (payTo) and host allowlist (A, E); an
  idempotency key with a persisted settlement history and a "do not resubmit" lock (E); a limit
  enforced on-chain by a smart wallet, which a compromised server process cannot exceed (E); an upper
  cap on the configured timeout (A and E cap per request; ours has none on the setting).
- **Could an existing server have been used?** No. The only Stellar one (B) has no spend limit, no
  address guard, no time limit, no catalog and free-text errors, and allows pubnet. A has the guards
  but no Stellar and puts seller text into tool descriptions; E is Base-only and wallet-specific.
  `@x402/mcp` is a library for paid *MCP tools*, the base for the later `call_paid_mcp_tool`, not a
  buyer server for HTTP resources.
