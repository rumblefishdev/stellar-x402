# ADR 0009: Run the Tranche 1 gate from our repo against a clean x402 checkout

- Status: accepted
- Date: 2026-10-07, amended 2026-10-15 (task 0028: the full Stellar matrix, the result checks)

## Context

The Tranche 1 sign-off gate is:

- an unmodified canonical client from the `x402-foundation/x402` end-to-end suite completes
  `exact` verify → settle against our testnet facilitator, at the wire level;
- a real settled transaction hash is produced and recorded.

The suite can't simply be pointed at a facilitator URL. For the facilitator role it starts a
local process. Its documented hook for external facilitators is
`e2e/facilitators/external-proxies/`:

- each subfolder holds a `test.config.json` and a `run.sh`;
- the harness starts `run.sh` with `PORT` set and waits for the stdout line
  `Facilitator listening`;
- it then calls `POST /verify`, `POST /settle`, `GET /supported`, `GET /health` and `POST /close`
  on localhost.

Upstream git-ignores everything in that folder except its README, so a proxy can't be merged
upstream. The suite already covers Stellar `exact` in its TypeScript client, server and
facilitator roles, so we don't contribute new fixtures.

## Decision

- **The proxy lives in our repo**, in `conformance/external-proxy/`.
  - `test.config.json` declares `name: stellar-x402`, `type: facilitator`,
    `language: typescript`, `protocolFamilies: [stellar]`, `schemes: [exact]`,
    `x402Versions: [2]` and `extensions: [bazaar]`.
  - Its `environment.required` names our facilitator-URL env var.
  - `run.sh` listens on `PORT`, prints `Facilitator listening`, and answers `/health` and `/close`
    itself.
  - It forwards `/verify`, `/settle` and `/supported` to our hosted facilitator.
- **A `conformance/` script runs the gate.** It:
  1. clones `x402-foundation/x402` read-only at a pinned commit, afresh on every run, so no build
     from an earlier run is reused;
  2. copies in only the proxy folder;
  3. installs and builds it the way upstream's CI does, without the Go and Python components;
  4. runs every Stellar `exact` scenario:
     `pnpm test --testnet --families=stellar --schemes=exact --facilitators=stellar-x402 --output-json=<file>`;
  5. fails unless every scenario passed with its own transaction hash, and Stellar RPC shows each
     hash as a successful `transfer` of the route's price from the buyer to the seller, its fee
     paid by a signer the facilitator lists in `/supported`, made after the run started. The suite
     itself exits 0 when no scenario matched, its axios client can pass without a hash, and it
     never reads the chain, so a replayed hash would pass it. The signer check trusts the
     facilitator's own `/supported`: a facilitator that relays to another and lists that one's
     fee payer as its signer still passes.
- **The evidence is committed.** Each run is a folder in `conformance/results/`: the suite's own
  JSON unchanged (`suite.json`), and the gate's verdict on it (`gate.json`) with the pinned upstream
  commit, the settled transaction hashes as the chain shows them, and `suite.json`'s SHA-256.
- **Nothing is pushed** to `x402-foundation/x402` or to our fork of it during M1.

## Rationale

- **"Unmodified" is easy to show.** It's a clean upstream commit plus one folder, the one the
  suite's own README describes. Nothing in the client, server or harness changes.
- **Runs are reproducible.** The pinned commit fixes the suite version, and bumping it is a
  deliberate change.
- **Every canonical client and server is covered.** `--min` keeps a random subset that touches
  each component once; the full Stellar matrix is about 18 payments of 0.001 testnet USDC, so
  "every canonical client completes" needs no sampling.
- **The proof lives next to the code.** The committed JSON is the evidence for sign-off and the
  start of the RFP's conformance report.
- **We don't depend on a fork branch** that drifts as upstream moves.

## Alternatives considered

- **Keep the proxy on a branch of our x402 fork.** Ties the gate to a fork branch that must be
  kept rebased, and makes "unmodified" harder to show. Rejected.
- **Contribute the proxy or Stellar fixtures upstream.** The proxy folder is git-ignored
  upstream, and Stellar `exact` is already covered. Not needed.

## Consequences

- The hosted testnet facilitator needs a public HTTPS URL (task 0014).
- The facilitator must answer the canonical resource server's single immediate `/settle` retry
  with a final outcome ([ADR 0006](0006-settlement-record.md)).
- The routes' `paymentFlow: "upfront"` variant calls `/settle` without a `/verify` first, before the
  resource is served. The facilitator must check the payment inside `/settle` (task 0028).
- The suite's Bazaar check (`--extensions=bazaar`) also calls `/discovery/search`, which comes after
  T1, so the gate runs without it until then.
- Updating the pinned upstream commit means re-running the gate and committing new results.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-13, AD-15
- [x402 e2e README](https://github.com/x402-foundation/x402/blob/main/e2e/README.md),
  [external-proxies README](https://github.com/x402-foundation/x402/blob/main/e2e/facilitators/external-proxies/README.md),
  [mechanisms_stellar.json](https://github.com/x402-foundation/x402/blob/main/e2e/config/mechanisms_stellar.json)
  (checked at commit 10b2d06)
