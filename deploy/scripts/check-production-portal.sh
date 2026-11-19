#!/bin/sh
# Builds the portal backend's image and starts it from deploy/production/portal.compose.yaml as
# x402-portal@ would (task 0106), so a change that breaks the image or its start shows here, not
# on the server. Run by hand before a promotion that touches either: CI doesn't run it. On the
# way it builds the facilitator's image too, the only build of either Dockerfile outside a
# deploy, and migrates production's Postgres with it, as a deploy does.
#
# The secrets get the owners the units' x402-creds lines name, mode 0400. The database role gets
# the runbook's own GRANT lines. Then: the deploy's probe answers within its 60 s, Docker's
# healthcheck turns healthy, the container runs as the compose file limits it, a call to the
# hub's contract with no bearer is refused with 401 invalid_token, the role issues, shows and
# revokes a key from inside the container and reads no other table, and a stop ends the process
# with 0.
# Docker installed from a snap can't start a container with no-new-privileges (its AppArmor
# profile refuses the exec: "operation not permitted"), so there the check takes that one option
# off every service it starts and says so. CI's and the server's Docker keep it.
# Not covered: the hub and its tokens, the tunnel, the units and the deploy script on a real systemd
# (deploy/test/portal.test.ts runs that script with fakes), the server's own volume.
#
# Usage: deploy/scripts/check-production-portal.sh
# (Docker, jq and openssl; root only if Docker needs it)
set -eu
# No terminal on stdin, as in CI: from one, `docker compose run` and `exec` go interactive and
# can be stopped by it. The one command that reads stdin, psql, gets a here-document.
exec < /dev/null
cd "$(dirname "$0")/.."
repo=$(cd .. && pwd)
unit=systemd/x402-portal@.service
runbook=$repo/docs/runbook.md
volume=x402-production-postgres-testnet
facilitator=x402-facilitator:check
portal=x402-portal:check
# Under the repo, not /tmp: Docker installed from a snap has a /tmp of its own, and would mount
# an empty directory there. `secrets/` is in .gitignore and .dockerignore.
mkdir -p "$repo/deploy/secrets"
secrets=$(mktemp -d "$repo/deploy/secrets/check-portal.XXXXXX")
export SECRETS_DIR="$secrets"
# The database unit's own Environment= line: Compose reads the whole file, and these are the
# facilitator's. Then the image the migration runs from.
export $(sed -n 's/^Environment=//p' systemd/x402-db-testnet@.service)
export FACILITATOR_IMAGE=$facilitator PORTAL_IMAGE=$portal
cd production

fail() {
  echo "$*" >&2
  exit 1
}

if docker volume inspect "$volume" > /dev/null 2>&1; then
  fail "$volume exists; this check makes and removes its own"
fi

# name:uid pairs, as the units and the deploy hand them to x402-creds.
portal_creds=$(sed -n 's/^ExecStartPre=.*x402-creds %i \(.*\)$/\1/p' "../$unit")
[ -n "$portal_creds" ] || fail "no x402-creds line in $unit"
migrate_owner=$(sed -n 's/^.*x402-creds "\$env" database-url\.testnet:\([0-9]*\).*/\1/p' ../libexec/x402-deploy)
[ -n "$migrate_owner" ] || fail "no database-url.testnet owner in libexec/x402-deploy"
postgres_owner=$(sed -n 's/^ExecStartPre=.*x402-creds .*postgres-password\.testnet:\([0-9]*\).*/\1/p' ../systemd/x402-db-testnet@.service)
# The runbook's grants, so the role here is the one an admin makes.
grants=$(sed -n 's/^ *\(GRANT .* TO x402_portal;\)$/\1/p' "$runbook")
[ "$(printf '%s\n' "$grants" | grep -c .)" -ge 3 ] || fail "no GRANT lines for x402_portal in docs/runbook.md"
probe=$(sed -n 's/^probe="\(.*\)"$/\1/p' ../libexec/x402-portal-deploy)
[ -n "$probe" ] || fail "no probe in libexec/x402-portal-deploy"

config=$(docker compose config --format json)
postgres_image=$(echo "$config" | jq -r '.services["postgres-testnet"].image')
edge=$(echo "$config" | jq -r '.networks.edge.name')
edge_subnet=$(echo "$config" | jq -r '.networks.edge.ipam.config[0].subnet')

# no-new-privileges, unless this Docker is a snap (above): then an override file takes it off.
nnp="[no-new-privileges:true]"
portal_override=
case $(docker info --format '{{.DockerRootDir}}') in
  /var/snap/*)
    nnp="[]"
    printf 'services:\n  postgres-testnet:\n    security_opt: !reset []\n  migrate-testnet:\n    security_opt: !reset []\n' \
      > "$secrets/facilitator.override.yaml"
    printf 'services:\n  portal:\n    security_opt: !reset []\n' > "$secrets/portal.override.yaml"
    # Every plain `docker compose` below reads both files; the first one names the project.
    export COMPOSE_FILE="compose.yaml:$secrets/facilitator.override.yaml"
    portal_override=$secrets/portal.override.yaml
    echo "Docker is a snap: starting every service WITHOUT no-new-privileges, which it can't apply"
    ;;
esac
pc() { docker compose -f portal.compose.yaml ${portal_override:+-f "$portal_override"} "$@"; }

made_edge=
cleanup() {
  status=$?
  # What each container said, when the check failed: the reason is usually its last lines.
  if [ "$status" -ne 0 ]; then
    for at in "compose postgres-testnet" "compose -f portal.compose.yaml portal"; do
      echo "-- ${at##* }: state and last lines" >&2
      docker ${at% *} ps --all --format '{{.Name}}: {{.Status}}' "${at##* }" >&2 || true
      docker ${at% *} logs --no-color --tail 30 "${at##* }" >&2 || true
    done
  fi
  pc down --timeout 30 > /dev/null 2>&1 || true
  docker compose --profile migrate down --timeout 30 > /dev/null 2>&1 || true
  [ -z "$made_edge" ] || docker network rm "$edge" > /dev/null 2>&1 || true
  docker volume rm "$volume" > /dev/null 2>&1 || true
  # The secrets belong to the containers' users now; root in a container removes them.
  docker run --rm -v "$secrets:/s" --entrypoint sh "$postgres_image" -c 'rm -f /s/*' || true
  rmdir "$secrets" "$repo/deploy/secrets" 2> /dev/null || true
}
trap cleanup EXIT
# So an interrupted run cleans up too: not every sh runs the EXIT trap on a signal.
trap 'exit 130' INT TERM

echo "== the images"
docker build --quiet -f "$repo/apps/facilitator/Dockerfile" -t "$facilitator" "$repo" > /dev/null
docker build --quiet -f "$repo/apps/portal/Dockerfile" -t "$portal" "$repo" > /dev/null
# Every module each program imports resolves in its image, without starting it.
for image in "$facilitator" "$portal"; do
  docker run --rm --entrypoint node "$image" -e "import('./dist/main.js').then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1)})"
  echo "$image: built, and its main module loads"
done

# One secret file, owned and moded as x402-creds leaves it.
secret() {
  printf %s "$2" > "$secrets/$1"
  docker run --rm -v "$secrets:/s" --entrypoint sh "$postgres_image" \
    -c "chown $3:$3 '/s/$1' && chmod 0400 '/s/$1'" ||
    fail "Docker doesn't see $secrets: the daemon must be able to mount it"
}

echo "== production's Postgres, migrated by the facilitator's image"
secret postgres-password.testnet ci-only "$postgres_owner"
secret database-url.testnet postgres://postgres:ci-only@postgres-testnet:5432/x402 "$migrate_owner"
docker volume create "$volume" > /dev/null
docker compose up --detach --no-deps --quiet-pull postgres-testnet
# No terminal on stdin: `timeout` runs its command in a background process group, and from a
# terminal `docker compose exec` would be stopped there for reading it, and never time out.
if ! timeout 50 sh -c \
  'until docker compose exec -T postgres-testnet pg_isready --quiet > /dev/null 2>&1; do sleep 1; done' \
  < /dev/null; then
  # Once more, aloud: an exec that Docker itself refuses looks the same as a database not up.
  docker compose exec -T postgres-testnet pg_isready >&2 || true
  fail "Postgres isn't ready after 50 s"
fi
# Not through a pipe: a failed migration must fail the check.
migrated=$(docker compose --profile migrate run --rm -T --pull never migrate-testnet)
printf '%s\n' "$migrated" | tail -n 1 | cut -c1-200

echo "== the role, with the runbook's grants"
docker compose exec -T postgres-testnet psql -U postgres -d x402 -v ON_ERROR_STOP=1 --quiet << SQL
CREATE ROLE x402_portal LOGIN PASSWORD 'ci-portal';
$grants
SQL
printf '%s\n' "$grants"

echo "== the backend, from portal.compose.yaml"
for cred in $portal_creds; do
  name=${cred%:*}
  case $name in
    portal-database-url) value=postgres://x402_portal:ci-portal@postgres-testnet:5432/x402 ;;
    # 32 bytes in base64 each, and the two secrets differ.
    portal-hub-token-secret) value="{\"current\": \"$(openssl rand -base64 32)\"}" ;;
    portal-key-encryption-key) value=$(openssl rand -base64 32) ;;
    *) fail "$unit decrypts $name, which this check doesn't know" ;;
  esac
  secret "$name" "$value" "${cred##*:}"
done
# In production the facilitator's project makes it, with the tunnel; here nothing starts that.
if ! docker network inspect "$edge" > /dev/null 2>&1; then
  docker network create --subnet "$edge_subnet" "$edge" > /dev/null
  made_edge=1
fi
pc up --detach --no-deps --pull never portal
id=$(pc ps --quiet portal)

# The deploy's own wait: its probe, for up to its 60 s.
deadline=$(($(date +%s) + 60))
until pc exec -T portal node -e "$probe" 2> /dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    pc exec -T portal node -e "$probe" >&2 || true
    fail "/health didn't answer within 60 s"
  fi
  sleep 2
done
echo "the deploy's probe answers"
timeout 60 sh -c "until [ \"\$(docker inspect --format '{{.State.Health.Status}}' $id)\" = healthy ]; do sleep 2; done" < /dev/null ||
  fail "Docker's healthcheck isn't healthy after 60 s"
echo "Docker's healthcheck: healthy"

limits=$(docker inspect --format \
  'user={{.Config.User}} drop={{.HostConfig.CapDrop}} add={{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}} read_only={{.HostConfig.ReadonlyRootfs}}' "$id")
echo "$limits"
[ "$limits" = "user=node drop=[ALL] add=[] $nnp read_only=true" ] ||
  fail "the container isn't limited as the compose file says"

# The hub's contract, with no bearer: refused, and in the contract's words.
pc exec -T portal node -e "
fetch('http://127.0.0.1:4022/api/hub/v1/account').then(async (r) => {
  const body = await r.json().catch(() => ({}));
  console.log('no bearer:', r.status, body.code);
  process.exit(r.status === 401 && body.code === 'invalid_token' ? 0 : 1);
}, () => process.exit(1))"

# The registry through the role, with the image's own store, over the db network.
pc exec -T portal node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { PostgresSealedKeyStore } from '@stellar-x402/api-keys';
const pool = new pg.Pool({ connectionString: readFileSync(process.env.DATABASE_URL_FILE, 'utf8') });
const store = new PostgresSealedKeyStore(pool);
const owner = 'discord:123456789012345678';
const hash = createHash('sha256').update('check').digest('hex');
const expect = (what, ok) => { if (!ok) { console.error('failed:', what); process.exit(1); } };
expect('issue', await store.issue({ hash, owner, sealed: Buffer.from('sealed'), now: 1 }));
expect('show', (await store.keysOf(owner)).active?.sealed?.toString() === 'sealed');
expect('revoke', await store.revoke(owner, 2));
expect('the copy goes with the key', (await store.keysOf(owner)).lastRevokedAt === 2);
const refused = async (sql) => pool.query(sql).then(() => false, (e) => e.code === '42501');
const { rows } = await pool.query(
  \"SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('api_keys', 'api_key_copies')\");
expect('other tables exist', rows.length > 0);
for (const { tablename } of rows) expect('no read of ' + tablename, await refused('SELECT 1 FROM ' + tablename));
expect('no delete of a key', await refused('DELETE FROM api_keys'));
expect('no new owner for a key', await refused(\"UPDATE api_keys SET owner = 'discord:1'\"));
expect('no change to a copy', await refused(\"UPDATE api_key_copies SET sealed = 'x'\"));
console.log('the role issues, shows and revokes, and reads none of the other', rows.length, 'tables');
await pool.end();"

pc stop portal
code=$(docker inspect --format '{{.State.ExitCode}}' "$id")
[ "$code" = 0 ] || fail "the backend ended with $code after a stop, not 0"
echo "a stop ends it with 0"
if [ -n "$portal_override" ]; then
  echo "ok, but without no-new-privileges (Docker from a snap): CI or the server checks that"
else
  echo "ok"
fi
