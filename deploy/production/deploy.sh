#!/bin/sh
# The deploy key's forced command (ADR 0011):
#   command="/srv/x402/production/deploy.sh",restrict ssh-ed25519 …
# Takes only an image digest from SSH_ORIGINAL_COMMAND, writes it to digest.next and starts
# x402-deploy@<environment>, holding a lock on digest.next until the deploy ends, so a second
# deploy waits instead of changing the digest under the first. A deploy by hand runs it too:
#   sudo -u deploy SSH_ORIGINAL_COMMAND=sha256:… /srv/x402/production/deploy.sh
set -eu
digest=${SSH_ORIGINAL_COMMAND:-}
case $digest in
  sha256:*) hex=${digest#sha256:} ;;
  *) hex= ;;
esac
if [ "${#hex}" -ne 64 ] || [ -n "$(printf '%s' "$hex" | tr -d '0-9a-f')" ]; then
  echo "expected an image digest, sha256: and 64 hex digits" >&2
  exit 2
fi

cd "$(dirname "$0")"
env=$(basename "$PWD")
exec 9>> digest.next
flock 9
printf '%s\n' "$digest" > digest.next
# Waits for the unit, so the job gets its result; a dropped session doesn't stop it. Not `exec`:
# sudo closes fd 9, and the lock must outlive the deploy.
sudo systemctl start "x402-deploy@$env"
