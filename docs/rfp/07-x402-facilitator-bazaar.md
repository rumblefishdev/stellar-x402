# RFP 7: X402 Facilitator with Bazaar (discovery) support

## Scope of Work
Build a production-ready x402 facilitator for Stellar on both testnet and
mainnet under a permissive open source license. Create a Stellar-native
Bazaar discovery layer enabling agents to find, price, and pay for
x402-protected services.

**Three success outcomes:**
1. A facilitator live on stellar:testnet and stellar:pubnet
2. A permissive OSI Approved License enabling ecosystem independence
3. A working Bazaar for Stellar as the highest-value deliverable

Build on the Apache-2.0 `@x402/stellar` package rather than reimplementing
verify and settle.

**Deliverable Categories:**
- Offchain service components (facilitator, discovery, MCP server)
- Upstream contribution: Stellar support for upto payment scheme
- Tooling/SDK support (seller and buyer helpers)
- Documentation and integration examples
- Audit readiness

## Background
X402 turns HTTP 402 into machine-native payment flows where clients request
resources, servers reply with terms, clients authorize payment, and
facilitators verify and settle onchain. Stellar's low settlement costs
(~0.0023 XLM) make per-request micropayments viable.

Stellar has working exact settlement through `@x402/stellar` and the free
public facilitator, but lacks a native Bazaar discovery layer. The Bazaar
catalogs machine-readable service metadata, enabling agents to shop
discoverable endpoints.

Discovery specifications remain evolving under the x402 Foundation, meaning
conformance and upkeep matter as heavily as initial implementation. SDF
holds a Governing Board seat, providing spec coordination support.

## Core Requirements

### Facilitator
- Implement x402 verify and settle for Stellar per v2 spec on both
  `stellar:testnet` and `stellar:pubnet`, building on `@x402/stellar`
- Expose standard surfaces: verify, settle, supported
- Validate Soroban auth entries strictly for correct signatures and
  authorization scope
- Support any SEP-41 token with USDC default
- Sponsor network fees so buyers need only payment assets
- Remain non-custodial
- Testnet must be free; mainnet pricing configurable
- Document caller authentication and rate limiting

### Bazaar Discovery Layer
Core new capability requiring submissions reference specific spec
behaviors:
- `GET /discovery/resources` with `type`, `payTo`, `network`,
  `extensions`, `limit`, `offset` filters
- `GET /discovery/search` with natural language query and cursor
  pagination
- Automatic cataloging when facilitators receive PaymentPayload with
  discovery extension
- Catalog both HTTP endpoints and MCP tools
- Enforce catalog integrity through soft drop validation and
  `routeTemplate` validation
- Report cataloging outcomes via `EXTENSION-RESPONSES` header
- Track spec evolution through grant period
- Interoperate with wider x402 discovery ecosystem
- Provide seller-side helpers for discovery metadata
- Keep index offchain by default

### Agent Facing MCP Interface
- Implement MCP discovery server enabling agents to search the Stellar
  Bazaar and make paid calls from agent runtimes
- Include structured, deterministic inputs/outputs with machine-readable
  error codes

### Settlement Schemes: Exact and Upto
- Support existing `exact` scheme for Stellar
- Implement `upto` (authorize up to cap, settle actual usage) for
  metered services, authoring `scheme_upto_stellar.md` as upstream
  contribution
- Coordinate through x402 Technical Steering Committee
- Defer `batch-settlement` and `auth-capture` as phase-two work

### Stellar Specific Considerations
- Auth entries, not pre-signed transactions
- Ledger-based expiration via `signatureExpirationLedger`
- Trustline requirements for SEP-41 assets
- Soroban resource limits compliance
- Throughput handling (channel accounts for sequence bottlenecks)
- TTL and rent strategies for optional registry

### Non-functional Requirements
- Permissive OSI Approved License with compatible dependencies (no AGPL)
- Conformance tested at wire level with unmodified canonical clients
- Security review before mainnet production
- UX enabling developers to deploy discoverable endpoints in under an
  hour
- 99%+ uptime targets for public endpoints
- Maintenance commitment beyond grant period

## Evaluation Criteria
- Technical capability understanding x402 v2 spec and Soroban auth
  models
- Discovery design with concrete cataloging, search, and interop
  strategies
- Conformance discipline with spec evolution tracking plans
- Relevant experience in payments, APIs, agents, or Soroban
- Security track record and threat modeling
- Ecosystem alignment and willingness to build on existing tooling
- Ability to deliver within timeline

## Expected Deliverables
- Open source, self-hostable x402 facilitator for Stellar (verify,
  settle, supported)
- Bazaar discovery: resources endpoint with filters, search with
  ranking, automatic cataloging
- MCP discovery server with search and paid call tools
- Upto scheme merged upstream with `scheme_upto_stellar.md`
  specification
- SDK helpers for sellers, buyers, and agents
- Conformance report with e2e results and settled transaction hashes
- Role-based developer guide for Stellar Developer Docs
- Two end-to-end example integrations
- Test suite covering verification, settlement, discovery, and MCP
- Security review report with resolved findings
- Production-ready service with runbook and monitoring
