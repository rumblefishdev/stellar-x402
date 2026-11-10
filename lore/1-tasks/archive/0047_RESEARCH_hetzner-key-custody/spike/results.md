# Spike results (2026-10-15)

Dev servers in Docker (`hashicorp/vault:latest` = 2.1.2, `openbao/openbao:latest` = 2.7.1), run
on a laptop. Signing latency is local, without TLS or network; a real deployment adds its round
trip.

Run: start a dev server, then `node transit-spike.mjs <name> http://127.0.0.1:<port>` and
`node transit-onchain.mjs` (OpenBao on port 18300, root token `root`).

| Check                                                                    | Vault 2.1.2 | OpenBao 2.7.1 |
| ------------------------------------------------------------------------ | ----------- | ------------- |
| `ed25519` key created in Transit, public key = raw 32 bytes → G-address | yes         | yes           |
| Signature over the 32-byte transaction hash: 64 bytes, `vault:v1:<b64>` | yes         | yes           |
| `Keypair.verify` (stellar-sdk) accepts it                                | yes         | yes           |
| `tx.addSignature` accepts it (it verifies too)                           | yes         | yes           |
| Existing `S…` secret imported (BYOK: RSA-OAEP + AES-KWP, PKCS#8)         | same G      | same G        |
| Export of a non-exportable key                                           | refused     | refused       |
| Sign latency, 200 sequential calls (p50 / p99)                           | 5.8 / 9.6 ms | 5.4 / 9.3 ms |

**On testnet:** a `createAccount` transaction signed only by an OpenBao Transit key landed:
`26a93987a74e2ff73a786e76ac1a361f6aca6d653b07f651a5b4ced43d959c86`, ledger 5210493, source
`GDVUHGPY5EKLZEXT7G2RPQNFCRZMBZZEQ62CEMSFQLJXCAQNXAA4LKJS`.
