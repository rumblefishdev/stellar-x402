# ADR 0009: Run the Tranche 1 gate from our repo against a clean x402 checkout

- Status: accepted
- Date: 2026-10-07

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
  - `test.config.json` declares `type: facilitator`, `language: typescript`,
    `protocolFamilies: [stellar]`, `schemes: [exact]` and `x402Versions: [2]`.
  - Its `environment.required` names our facilitator-URL env var.
  - `run.sh` listens on `PORT`, prints `Facilitator listening`, and answers `/health` and `/close`
    itself.
  - It forwards `/verify`, `/settle` and `/supported` to our hosted facilitator.
- **A `conformance/` script runs the gate.** It:
  1. clones `x402-foundation/x402` read-only at a pinned commit;
  2. copies in only the proxy folder;
  3. runs `pnpm test --testnet --families=stellar --facilitators=<ours> --min --output-json=<file>`.
- **The evidence is committed.** Results, including the pinned upstream commit and the settled
  transaction hashes, go into `conformance/results/`.
- **Nothing is pushed** to `x402-foundation/x402` or to our fork of it during M1.

## Rationale

- **"Unmodified" is easy to show.** It's a clean upstream commit plus one folder, the one the
  suite's own README describes. Nothing in the client, server or harness changes.
- **Runs are reproducible.** The pinned commit fixes the suite version, and bumping it is a
  deliberate change.
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
- The routes' `paymentFlow: "upfront"` variant must be understood before the first run.
- Updating the pinned upstream commit means re-running the gate and committing new results.

## References

- [M1 architecture spine](../architecture/m1-spine.md): AD-13, AD-15
- [x402 e2e README](https://github.com/x402-foundation/x402/blob/main/e2e/README.md),
  [external-proxies README](https://github.com/x402-foundation/x402/blob/main/e2e/facilitators/external-proxies/README.md),
  [mechanisms_stellar.json](https://github.com/x402-foundation/x402/blob/main/e2e/config/mechanisms_stellar.json)
  (checked at commit 10b2d06)
