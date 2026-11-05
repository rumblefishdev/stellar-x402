# The snapshot job's policy (ADR 0013): it can save a Raft snapshot and nothing else. Its AppRole
# x402-snapshot is made by the runbook's admin step (OpenBao snapshots).
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
