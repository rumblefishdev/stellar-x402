# OpenBao on the facilitator's server (ADR 0013): Transit signing for every network, a unix socket
# per network, and admin only from inside its own container. On the server this is
# /srv/x402/openbao/config.hcl.

ui = false
# The admin listener's; one node never dials them.
api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"

storage "raft" {
  path    = "/openbao/file"
  node_id = "x402-openbao"
}

# Every request, on its own volume. A request that can't be logged fails, so a full disk stops
# signing (fail closed, ADR 0013; the alarm at 80% is 0027's).
audit "file" "file" {
  options {
    file_path = "/openbao/logs/audit.log"
  }
}

# Unseals itself after a restart with the key `x402-openbao.service` decrypts (ADR 0013). A key
# rotation is a commit: the new ID here, the old pair as previous_key_id and previous_key.
seal "static" {
  current_key_id = "x402-openbao-1"
  current_key    = "file:///run/secrets/seal-key"
}

# Testnet's facilitator, the socket's only user: its own volume, mounted into it alone (0077). The
# facilitator runs as uid and gid 1000, which is this image's openbao group too. OpenBao applies
# none of the three socket settings unless all three are set.
listener "unix" {
  address      = "/run/openbao/testnet/bao.sock"
  socket_mode  = "0660"
  socket_user  = "100"
  socket_group = "1000"
}

# Admin, and Raft's cluster address, which OpenBao takes only from a TCP listener: loopback in a
# container with no network, so only `docker compose exec openbao bao …`, root on the host,
# reaches it. A root token is regenerated from the recovery key through the legacy
# /sys/generate-root API, which takes no token (ADR 0013).
listener "tcp" {
  address                                  = "127.0.0.1:8200"
  cluster_address                          = "127.0.0.1:8201"
  tls_disable                              = true
  disable_unauthed_generate_root_endpoints = false
}
