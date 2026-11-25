#!/bin/sh
# Builds the facilitator's image for the server's platform and runs the search model in it as
# deploy/production/compose.yaml does (ADR 0014): read-only, no capabilities, 768 MB, one CPU. So a
# change that keeps the model from loading or answering in the amd64 image fails CI instead of the
# server: onnxruntime's native build, the files the build fetched, the memory limit. It waits for
# /health, asks /embed for one query's vector and checks it has 384 numbers, that a request
# without `kind` is refused, and that a long text is read further as a listing than as a query.
# Not covered: the facilitator's own container, the compose file itself and the server's network.
#
# Usage: deploy/scripts/check-search-model-image.sh   (Docker and jq; no root needed)
set -eu
cd "$(dirname "$0")/../.."
image=x402-facilitator:ci
name=x402-search-model-ci

docker build --platform linux/amd64 -f apps/facilitator/Dockerfile -t "$image" .

cleanup() {
  docker logs "$name" 2>&1 | tail -n 30
  docker rm --force "$name" > /dev/null 2>&1 || true
}
trap cleanup EXIT

# The search-model service's settings in deploy/production/compose.yaml. Its port is published to
# this host only for the check.
docker run --detach --name "$name" --platform linux/amd64 \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 768m --cpus 1 -e PORT=8080 -p 127.0.0.1:8080:8080 \
  "$image" node /search-model/dist/main.js > /dev/null

# 200 only once the model is loaded. 120 s: the compose file allows 30 s plus three 10 s retries,
# and a CI runner is slower than the server.
if ! timeout 120 sh -c 'until curl --silent --fail http://127.0.0.1:8080/health > /dev/null; do sleep 2; done'; then
  echo "the search model did not answer /health within 120 s" >&2
  exit 1
fi
echo "health: $(curl --silent --fail http://127.0.0.1:8080/health)"

length=$(curl --silent --fail --header 'content-type: application/json' \
  --data '{"text":"weather","kind":"query"}' http://127.0.0.1:8080/embed \
  | jq '.vector | if type == "array" and all(type == "number") then length else -1 end')
if [ "$length" != 384 ]; then
  echo "/embed answered a vector of $length numbers, not 384" >&2
  exit 1
fi
echo "/embed answered 384 numbers"

# `kind` is required: a query sent without it would be read as far as a listing.
status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'content-type: application/json' --data '{"text":"weather"}' \
  http://127.0.0.1:8080/embed)
if [ "$status" != 400 ]; then
  echo "/embed without kind answered $status, not 400" >&2
  exit 1
fi
echo "/embed without kind answered 400"

# 1,968 characters: more than 256 tokens, fewer than the 2,000 characters the model reads. A query
# is cut at 256 tokens and a listing at 512 (ADR 0014), so the two vectors differ.
long=$(printf 'weather forecast for every city and hour %.0s' $(seq 48))
vector_as() {
  jq --null-input --arg text "$long" --arg kind "$1" '{text: $text, kind: $kind}' \
    | curl --silent --fail --header 'content-type: application/json' --data @- \
      http://127.0.0.1:8080/embed \
    | jq --compact-output '.vector'
}
query=$(vector_as query)
listing=$(vector_as listing)
if [ -z "$query" ] || [ -z "$listing" ]; then
  echo "/embed answered no vector for a long text" >&2
  exit 1
fi
if [ "$query" = "$listing" ]; then
  echo "/embed answered a long text the same vector as a query and as a listing" >&2
  exit 1
fi
echo "/embed reads a long text further as a listing than as a query"
