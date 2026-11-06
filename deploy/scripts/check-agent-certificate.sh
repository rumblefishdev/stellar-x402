#!/bin/sh
# Checks the CloudWatch agent's Roles Anywhere certificate before the playbook installs it (lore
# 0027, the server-side spine's AD-13): the CN the logging role's trust policy accepts (decision
# 25), an end-entity certificate for client authentication, and time left. The playbook runs it
# on the admin's machine, and deploy/test on the committed file. Says what's wrong and exits 1.
#   check-agent-certificate.sh <certificate> <cn> [seconds it must still be valid, default 0]
# Needs OpenSSL 1.1.1 or later (`-ext`).
set -eu
cert=$1
cn=$2
left=${3:-0}
fail() {
  echo "$cert: $*" >&2
  exit 1
}

subject=$(openssl x509 -in "$cert" -noout -subject -nameopt RFC2253 2> /dev/null) ||
  fail "not a PEM certificate"
case ${subject#subject=} in
  "CN=$cn" | "CN=$cn,"* | *",CN=$cn" | *",CN=$cn,"*) ;;
  *) fail "its subject is ${subject#subject=}, not CN=$cn" ;;
esac
openssl x509 -in "$cert" -noout -checkend "$left" > /dev/null ||
  fail "it expires within $left s, or has expired"
ext=$(openssl x509 -in "$cert" -noout -ext basicConstraints,keyUsage,extendedKeyUsage 2> /dev/null) ||
  fail "it lacks the extensions Roles Anywhere needs"
for want in "CA:FALSE" "Digital Signature" "TLS Web Client Authentication"; do
  printf '%s\n' "$ext" | grep -q "$want" || fail "it lacks $want"
done
echo "$cert: CN=$cn, a client certificate, valid for $left s more at least"
