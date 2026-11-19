# Milestone 1 — Dependency License Audit

The re-audit of the full dependency tree's licenses that our Panel Review response commits to at
each tranche boundary (§5), for the Tranche #1 boundary. It covers the facilitator, the packages and
the `upto` contracts, from the lockfiles of `develop` at `da93723a` (2026-11-09).

**Result: no AGPL, GPL, LGPL-only, SSPL or unlicensed dependency.** The repository and every
workspace package and contract are Apache-2.0.

## JavaScript and TypeScript (pnpm workspace)

```bash
pnpm install --frozen-lockfile
pnpm licenses list --json -r          # every dependency, development ones included
pnpm licenses list --json -r --prod   # what the services ship
```

| License       | Every dependency | Production only |
| ------------- | ---------------- | --------------- |
| MIT           | 230              | 127             |
| Apache-2.0    | 30               | 16              |
| ISC           | 13               | 9               |
| BSD-2-Clause  | 8                | 2               |
| BSD-3-Clause  | 6                | 4               |
| MPL-2.0       | 2                | 0               |
| BlueOak-1.0.0 | 1                | 0               |
| Unlicense     | 1                | 1               |
| **Total**     | **291**          | **159**         |

- **MPL-2.0:** `lightningcss` and its `darwin-arm64` binary, a development-only build tool. MPL-2.0
  is file-level copyleft and nothing of it ships.
- **BlueOak-1.0.0:** `minimatch`, development only; a permissive license.
- **Unlicense:** `tweetnacl`, public-domain dedication; a permissive license.

## Rust (`contracts/`, Cargo)

```bash
cd contracts && cargo metadata --format-version 1
```

239 crates outside the workspace, every one under a permissive license or a choice that includes
one:

| License expression                                  | Crates |
| --------------------------------------------------- | ------ |
| MIT OR Apache-2.0 (and its spellings)               | 174    |
| MIT                                                 | 19     |
| Apache-2.0                                          | 18     |
| Unlicense OR MIT                                    | 7      |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 5      |
| BSD-3-Clause                                        | 4      |
| Zlib OR MIT OR Apache-2.0 (and its spellings)       | 3      |
| MIT OR Apache-2.0 OR BSD-1-Clause                   | 2      |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later              | 2      |
| Apache-2.0 WITH LLVM-exception                      | 2      |
| BSD-2-Clause OR Apache-2.0 OR MIT                   | 2      |
| (MIT OR Apache-2.0) AND Unicode-3.0                 | 1      |

- **LGPL-2.1-or-later** appears only as one option of three in `r-efi` (5.3.0 and 6.0.0); it is used
  under MIT or Apache-2.0.
- The workspace's own crates (`upto-proxy`, `test-token`, `test-wallet`, `hostile-token`) are
  Apache-2.0.

## The channel-account pool

The one AGPL conflict the proposal named, OpenZeppelin's `relayer-plugin-channels` (AGPL-3.0), is
not a dependency: the pool is our own Apache-2.0 reimplementation (`packages/signer-pool`), and
neither tree above contains it.

## Services the deployment runs beside the code

Separate processes, not linked into our code: OpenBao (MPL-2.0), PostgreSQL (PostgreSQL License),
`cloudflared` (Apache-2.0) and the Amazon CloudWatch agent (MIT).
