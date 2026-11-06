# The snapshot job's policy (ADR 0013): it can save a Raft snapshot and nothing else. Its AppRole
# x402-snapshot is made by the runbook's admin step (OpenBao snapshots). Its tokens also carry
# OpenBao's `default` policy, which reaches only the token itself (lookup, renew, the job's
# `token revoke -self`) and its cubbyhole, no secret and no key.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
