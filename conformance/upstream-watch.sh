#!/usr/bin/env bash
# Names each upstream file the suite rests on that upstream main has changed since the pinned commit
# (task 0029): the x402 spec, the Stellar `exact` scheme and the suite's list of Stellar routes. One
# line per changed file; nothing when none changed. Needs `gh`, logged in or with GH_TOKEN.
set -euo pipefail
cd "$(dirname "$0")"

repo=x402-foundation/x402
pin=$(grep -oE '[0-9a-f]{40}' src/upstream.ts)

for path in \
  specs/x402-specification-v2.md \
  specs/schemes/exact/scheme_exact_stellar.md \
  e2e/config/mechanisms_stellar.json; do
  at_pin=$(gh api "repos/$repo/contents/$path?ref=$pin" --jq .sha)
  on_main=$(gh api "repos/$repo/contents/$path?ref=main" --jq .sha)
  if [ "$at_pin" != "$on_main" ]; then echo "$path"; fi
done
