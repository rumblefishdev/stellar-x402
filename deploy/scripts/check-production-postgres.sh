#!/bin/sh
# Starts production's Postgres from deploy/production/compose.yaml as x402-db-testnet@ would (task
# 0091), so a change that breaks its start fails CI instead of the server. It takes the password
# secret's owner from the unit's x402-creds line and writes it 0400, as x402-creds does, and waits
# with the unit's own readiness command. So it fails when the compose file's `user:` and the unit's
# owner disagree, when Postgres starts as root without the capabilities its entrypoint needs, or
# when an image needs more than the compose file gives. It starts on a new volume, restarts, and is
# recreated on the used volume, as a new image would be. Not covered: the facilitator, the units
# themselves, the server's own volume and a reboot.
#
# Usage: deploy/scripts/check-production-postgres.sh   (Docker and jq; no root needed)
set -eu
cd "$(dirname "$0")/.."
unit=systemd/x402-db-testnet@.service
cd production
volume=x402-production-postgres-testnet
secrets=$(mktemp -d)
export SECRETS_DIR="$secrets"
# The unit's own Environment= line: Compose reads the whole file, and these are the facilitator's.
export $(sed -n 's/^Environment=//p' "../$unit")

if docker volume inspect "$volume" > /dev/null 2>&1; then
  echo "$volume exists; this check makes and removes its own" >&2
  exit 1
fi

owner=$(sed -n 's/^ExecStartPre=.*x402-creds .*postgres-password\.testnet:\([0-9]*\).*/\1/p' "../$unit")
if [ -z "$owner" ]; then
  echo "no postgres-password.testnet owner in $unit" >&2
  exit 1
fi
config=$(docker compose config --format json)
image=$(echo "$config" | jq -r '.services["postgres-testnet"].image')
user=$(echo "$config" | jq -r '.services["postgres-testnet"].user // "the image'"'"'s (root)"')
echo "postgres-testnet: $image, as $user; secret owned by $owner ($unit)"

cleanup() {
  docker compose logs --no-color postgres-testnet 2> /dev/null | tail -n 30
  docker compose down --timeout 30 > /dev/null 2>&1 || true
  docker volume rm "$volume" > /dev/null 2>&1 || true
  # The secret belongs to $owner now; root in a container removes it.
  docker run --rm -v "$secrets:/s" --entrypoint rm "$image" -f /s/postgres-password.testnet || true
  rmdir "$secrets" || true
}
trap cleanup EXIT

printf 'ci-only' > "$secrets/postgres-password.testnet"
docker run --rm -v "$secrets:/s" --entrypoint sh "$image" \
  -c "chown $owner:$owner /s/postgres-password.testnet && chmod 0400 /s/postgres-password.testnet"
docker volume create "$volume" > /dev/null

# The unit's ExecStartPost, with its 50 s.
ready() {
  if ! timeout 50 sh -c \
    'until docker compose exec -T postgres-testnet pg_isready --quiet; do sleep 1; done'; then
    echo "not ready after $1" >&2
    exit 1
  fi
  echo "ready after $1"
}

docker compose up --detach --no-deps --quiet-pull postgres-testnet
ready "a start on a new volume"
docker compose restart postgres-testnet
ready "a restart"
docker compose up --detach --no-deps --force-recreate postgres-testnet
ready "a new container on the used volume"
# Over the `db` network, as the facilitator's DATABASE_URL connects: initdb trusts 127.0.0.1, so a
# login there passes with any password. A wrong one must fail, or this proves nothing.
login() {
  docker compose exec -T -e PGPASSWORD="$1" postgres-testnet psql --host postgres-testnet \
    --username postgres --dbname x402 --tuples-only --command 'select 1' > /dev/null 2>&1
}
if login wrong; then
  echo "a wrong password logs in over the db network" >&2
  exit 1
fi
login ci-only
echo "password login over the db network works"
