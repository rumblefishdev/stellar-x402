#!/usr/bin/env bash
# Walks the built backend against a real PostgreSQL, by hand (it is not part of `pnpm test`).
#
#   pnpm --filter @stellar-x402/portal build
#   apps/portal/test/live/hand-run.sh
#
# It makes a scratch schema, runs the facilitator's migrations into it, starts the backend on it
# with throwaway secrets, calls the four routes in the order a seller meets them, stops it with
# SIGTERM and drops the schema. DATABASE_URL defaults to the repo's docker compose PostgreSQL;
# PORT (default 14022) is where the backend listens. It prints each step's status, never a key,
# a token or a secret.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/../.." && pwd)" # apps/portal
cd "$PKG_DIR"
DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:15432/postgres}"
PORT="${PORT:-14022}"
SCHEMA="x402_portal_hand_run_$$"
BASE="http://127.0.0.1:$PORT"
DISCORD_ID="80351110224678912" # a 2015 account: past any age gate
FAILED=0
SERVER_PID=""
SCHEMA_MADE=0
BODY=""
STATUS=""
# The backend's log lives in a directory of the package (git-ignored), never in the system temp
# dir, which is RAM. No answer's body is written to a file: the key `reveal` returns stays in
# this shell's memory.
WORK="$(mktemp -d "$PKG_DIR/.hand-run.XXXXXX")"
LOG="$WORK/server.log"

# The database URL with the scratch schema as the only search path, as the backend and the
# migrations both see it. Passed to node through the environment, so no secret is on a command line.
SCRATCH_URL="$(DATABASE_URL="$DATABASE_URL" SCHEMA="$SCHEMA" node -e '
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.set("options", "-c search_path=" + process.env.SCHEMA);
  process.stdout.write(u.toString());
')"

sql() { # run one statement against the real database, not the scratch schema
  DATABASE_URL="$DATABASE_URL" node --input-type=module -e '
    import pg from "pg";
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try { await c.query(process.argv[1]); } finally { await c.end(); }
  ' "$1"
}

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then kill -9 "$SERVER_PID" || true; fi
  if [ "$SCHEMA_MADE" = 1 ]; then
    sql "DROP SCHEMA IF EXISTS $SCHEMA CASCADE" || echo "could not drop schema $SCHEMA: drop it by hand"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

show_log() { echo "--- the backend's log (it holds no secrets), last lines:"; tail -n 20 "$LOG" || true; }

step() { # step <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok    $1 ($3)"; else echo "FAIL  $1: expected $2, got $3"; FAILED=1; fi
}

B64() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'; }
HUB_CURRENT="$(B64)"
KEY_ENCRYPTION_KEY="$(B64)"
export HUB_CURRENT

mint() { # mint <act>: a token as the hub signs one, valid for 60 seconds
  ACT="$1" DISCORD_ID="$DISCORD_ID" node --input-type=module -e '
    import { signHubToken } from "./dist/hub-token.js";
    const iat = Math.floor(Date.now() / 1000);
    process.stdout.write(signHubToken(Buffer.from(process.env.HUB_CURRENT, "base64"), {
      iss: "https://sorobanscan.com/api/hub", aud: "x402", sub: "discord:" + process.env.DISCORD_ID,
      act: process.env.ACT, jti: "hand-run-" + process.env.ACT + "-" + iat, iat, exp: iat + 60,
    }));
  '
}

call() { # call <method> <path> [<act>]: the status to $STATUS, the body to $BODY (not run in a $(...), which would lose both)
  local auth=() out
  if [ $# -ge 3 ]; then auth=(-H "Authorization: Bearer $(mint "$3")"); fi
  # ${auth[@]+...}: an empty array is "unbound" under set -u on bash before 4.4.
  out="$(curl -s -w '\n%{http_code}' -X "$1" ${auth[@]+"${auth[@]}"} "$BASE$2")"
  BODY="${out%$'\n'*}"
  STATUS="${out##*$'\n'}"
}
# field <dotted.path>: that field of $BODY, which goes to node on a pipe, never to a file.
field() {
  printf '%s' "$BODY" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    process.stdout.write(String(process.argv[1].split(".").reduce((o, k) => o?.[k], j)));
  ' "$1"
}

echo "scratch schema $SCHEMA on the database in DATABASE_URL"
if ! sql "CREATE SCHEMA $SCHEMA" 2>/dev/null; then
  echo "FAIL  the database in DATABASE_URL could not be reached (or refused CREATE SCHEMA); nothing was changed"
  exit 1
fi
SCHEMA_MADE=1
(cd ../facilitator && DATABASE_URL="$SCRATCH_URL" corepack pnpm exec tsx src/migrate.ts >/dev/null)
echo "ok    facilitator migrations ran into the scratch schema"

DATABASE_URL="$SCRATCH_URL" KEY_ENCRYPTION_KEY="$KEY_ENCRYPTION_KEY" PORT="$PORT" \
  HUB_TOKEN_SECRET="{\"current\":\"$HUB_CURRENT\"}" node dist/server.js >"$LOG" 2>&1 &
SERVER_PID=$!
UP=0
for _ in $(seq 1 50); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health" || true)" = 200 ]; then UP=1; break; fi
  sleep 0.2
done
if [ "$UP" = 0 ]; then
  echo "FAIL  /health never answered 200 in 10 s"
  show_log
  exit 1
fi

call GET /health; step "GET /health" 200 "$STATUS"
call GET /api/hub/v1/account; step "account, no bearer" 401 "$STATUS"
step "  code" invalid_token "$(field code)"
BAD=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer v1.probe.probe" "$BASE/api/hub/v1/account")
step "account, Bearer v1.probe.probe" 401 "$BAD"

call GET /api/hub/v1/account read; step "account (none)" 200 "$STATUS"
step "  state" none "$(field key.state)"
call POST /api/hub/v1/key/issue issue; step "issue" 200 "$STATUS"
step "  outcome" issued "$(field outcome)"
call GET /api/hub/v1/account read; step "account (active)" 200 "$STATUS"
step "  state" active "$(field key.state)"
step "  showable" true "$(field details.showable)"
call POST /api/hub/v1/key/reveal reveal; step "reveal" 200 "$STATUS"
# The key is kept in memory only, to look for it in the log below.
ISSUED_KEY="$(field value || true)"
step "  a key was returned" 1 "$([ -n "$ISSUED_KEY" ] && [ "$ISSUED_KEY" != undefined ] && echo 1 || echo 0)"
call POST /api/hub/v1/key/revoke revoke; step "revoke" 200 "$STATUS"
step "  revoked" true "$(field revoked)"
call POST /api/hub/v1/key/issue issue; step "issue again (capped)" 200 "$STATUS"
step "  outcome" capped "$(field outcome)"

kill -TERM "$SERVER_PID"
set +e; wait "$SERVER_PID"; EXIT=$?; set -e
SERVER_PID=""
step "SIGTERM exit code" 0 "$EXIT"

# Nothing secret in the log: the two secrets, the database password and the key the account was
# issued. Read in one node process; the key arrives on stdin, the rest in the environment.
LEAKED="$(printf '%s' "$ISSUED_KEY" | LOG="$LOG" HUB_CURRENT="$HUB_CURRENT" \
  KEY_ENCRYPTION_KEY="$KEY_ENCRYPTION_KEY" DATABASE_URL="$DATABASE_URL" node -e '
  const fs = require("fs");
  const log = fs.readFileSync(process.env.LOG, "utf8");
  const key = fs.readFileSync(0, "utf8");
  const password = decodeURIComponent(new URL(process.env.DATABASE_URL).password);
  const secrets = [process.env.HUB_CURRENT, process.env.KEY_ENCRYPTION_KEY, process.env.DATABASE_URL, key];
  // ":password@" rather than the bare password, which may be a word ("postgres") the log holds.
  if (password) secrets.push(":" + password + "@");
  process.stdout.write(secrets.some((s) => s && log.includes(s)) ? "yes" : "no");
')"
step "no secret, password or key in the backend's log" no "$LEAKED"

if [ "$FAILED" = 0 ]; then
  echo "all steps passed"
else
  show_log
  echo "some steps failed"
  exit 1
fi
