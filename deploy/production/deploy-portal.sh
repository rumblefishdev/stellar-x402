#!/bin/sh
# The portal's deploy key's forced command (task 0106 decision 5), as deploy.sh is the
# facilitator's:
#   command="/srv/x402/production/deploy-portal.sh",restrict ssh-ed25519 …
# Takes only an image digest from SSH_ORIGINAL_COMMAND, writes it to portal.digest.next and starts
# x402-portal-deploy@<environment>, holding a lock on portal.digest.next until the deploy ends.
# The key can do nothing else, so it can't deploy the facilitator. A deploy by hand runs it too:
#   sudo -u x402-deploy env SSH_ORIGINAL_COMMAND=sha256:… /srv/x402/production/deploy-portal.sh
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
exec 9>> portal.digest.next
flock 9
printf '%s\n' "$digest" > portal.digest.next
# Waits for the unit, so the job gets its result. Not `exec`: sudo closes fd 9, and the lock must
# outlive the deploy.
sudo systemctl start "x402-portal-deploy@$env"
