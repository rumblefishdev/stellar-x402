---
title: "Running OpenBao on Hetzner: where, at what cost, and how the facilitator reaches it"
type: research
status: developing
spawned_from: notes/R-key-custody-options.md
spawns: []
tags: [keys, custody, hetzner, openbao, deployment, network]
links:
  - R-key-custody-options.md
history:
  - date: "2026-10-16"
    status: developing
    who: okarcz
    note: "Deployment sketch: own machine, cost, vSwitch link to the dedicated server, what crosses it."
  - date: "2026-10-19"
    status: developing
    who: okarcz
    note: "Not chosen for now: OpenBao runs in a container on the facilitator's server (ADR 0013). Kept as the upgrade path."
---

# Running OpenBao on Hetzner

> **Not chosen for now** (2026-10-19): [ADR 0013](../../../../../docs/adr/0013-facilitator-key-custody.md)
> runs OpenBao in a container on the facilitator's server, reached over a unix socket, with
> snapshots on the existing Storage Box. This note stays as the upgrade path: a separate machine
> once the float or `upto` raises the stakes.

## Question

[R-key-custody-options](R-key-custody-options.md) recommends OpenBao Transit on its own server.
The facilitator will run on our existing Hetzner Robot dedicated server in Falkenstein, which also
runs other services. Can OpenBao share that server? If not, what does a separate machine cost, can
it reach the dedicated server privately, and is that link safe for signing?

## OpenBao can't share the facilitator's server

> 2026-10-19: true for isolation, but not worth a machine at our stakes. okarcz prefers OpenBao on
> the facilitator's server with auto-unseal ([R-key-leak-impact](R-key-leak-impact.md)).

- OpenBao holds the key in software. Root on OpenBao's host can get it.
- On the facilitator's host, root on that host would have the key, as with `FACILITATOR_SECRET`
  in the environment today. Keeping the raw key away from the facilitator's host is the point of
  option C.
- A container doesn't change that: containers on one host share its kernel and its root. The
  boundary is a separate machine.
- Every other service on the dedicated server adds a way in:
  ```
  a bug in another service ==> container escape to root ==> the facilitator key
  ```
  A restart of that server also stops signing.
- Splitting the dedicated server into VMs isn't an option: it runs a bare-metal OS with
  production workloads, so adding a hypervisor means reinstalling it.

## Cost of a separate Hetzner Cloud machine

EU prices (Falkenstein, Nuremberg, Helsinki), excluding VAT, including a primary IPv4, read from
Hetzner's price API on 2026-10-07 (third-party summary; Hetzner's pages render prices only with
JavaScript):

| Plan  | Resources                    | Per month | Orderable                |
| ----- | ---------------------------- | --------- | ------------------------ |
| CPX02 | 1 vCPU, 1 GB RAM, 20 GB NVMe | €6.49     | yes                      |
| CPX12 | 1 vCPU, 2 GB RAM, 40 GB NVMe | €11.99    | yes                      |
| CPX22 | 2 vCPU, 4 GB RAM, 80 GB NVMe | €19.99    | yes                      |
| CX23  | 2 vCPU, 4 GB RAM             | €5.99     | no, currently unavailable |

- VAT comes on top (23% in Poland), unless invoiced under reverse charge to an EU VAT ID.
- Hetzner raised Cloud prices twice in 2026 (April and June). Check the console before ordering.
- One node: CPX02 is enough for OpenBao with a few keys; CPX12 leaves headroom. Three nodes for
  mainnet (Raft): about €19.50–36 a month.

## Linking it to the dedicated server: vSwitch coupling

Hetzner can couple a Cloud Network to a Robot vSwitch:

```
dedicated server (Robot) ==> vSwitch ==> vSwitch subnet in a Cloud Network ==> Cloud machine with OpenBao
```

- **Zone:** only with subnets in the `eu-central` network zone (Falkenstein, Nuremberg,
  Helsinki). Our dedicated server is in Falkenstein, so it qualifies.
- **Setup:** cloud servers are configured automatically. The dedicated server needs a VLAN
  interface with MTU 1400, an address from the vSwitch subnet, and a route to the Cloud Network
  through the subnet's first IP.
- **Limits:** one vSwitch per Network; a dedicated server can't route for the private network.
- **Cost:** "The Networks feature is free", and private-network traffic is free. Whether the
  Robot vSwitch itself costs anything isn't checked.
- **Change on a shared production server:** the dedicated server has no vSwitch today, so the VLAN
  interface is a network change on a server that runs other production services. Plan it as a
  maintenance change through that server's existing provisioning.

## Is the link safe for signing?

Hetzner: traffic in a Network is "private and isolated, but not automatically encrypted", and
"We recommend you use TLS or similar protocols to encrypt sensitive traffic." Nothing says the
vSwitch VLAN is encrypted, so assume it isn't.

What crosses the link per settlement:

| Data                                      | Secret?                                | If someone reads it                                   |
| ----------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| The 32-byte transaction hash              | no, it goes to the network anyway      | nothing                                               |
| The returned signature                    | no, it is in the transaction on chain  | nothing                                               |
| The facilitator's token or client cert    | **yes**                                | they can make OpenBao sign until access is revoked    |
| The Stellar private key                   | never crosses the network              | —                                                     |

- **mTLS is required:** it encrypts the credential and lets the facilitator check it talks to
  the real OpenBao. With mTLS, the link's safety doesn't depend on the VLAN being encrypted.
- **vSwitch adds a layer:** OpenBao has no port open to the internet, and its firewall admits only
  the dedicated server. A public link with mTLS and a firewall allowing only the dedicated server's
  IP is also safe, with the port visible from outside.
- **What the link can't fix:** root on the facilitator's server can make OpenBao sign while it is
  there. It can't take the key away, and each signature is in the audit log. Task 0048's
  thresholds bound what such signatures can do: the hot key can't change any channel's signers.

## Deployment sketch

1. **Machine:** a Hetzner Cloud machine only for OpenBao, one per network, nothing else on it.
   Docker (the official `openbao/openbao` image pinned by digest, config mounted, a data volume,
   read-only root filesystem) or the binary under systemd. Swap and core dumps off.
2. **Network:** vSwitch coupling to the dedicated server; no public IP if the machine needs none
   (updates through a NAT or a temporary IP); Hetzner Cloud Firewall and the host firewall admit
   port 8200 only from the dedicated server. SSH through a bastion or VPN.
3. **TLS:** our own CA, mTLS; the facilitator authenticates with the `cert` method (or AppRole).
4. **Access:** a policy that allows only `transit/sign/<key>`; short-lived tokens; the root token
   revoked after setup. The key `type=ed25519`, `exportable=false`,
   `allow_plaintext_backup=false`; the testnet key can be imported (BYOK).
5. **Storage and backups:** integrated Raft. One node on testnet; three nodes on mainnet in a
   spread placement group. Raft snapshots shipped off the machine (e.g. a Storage Box); they are
   encrypted by OpenBao's barrier, and the unseal keys are kept apart from them.
6. **Unseal:** static seal on testnet; on mainnet Shamir with an on-call person or a cloud KMS
   seal ([Mainnet unseal, checked](R-key-custody-options.md#mainnet-unseal-checked)).
7. **Audit and alerts:** a file audit device shipped off the machine; alerts when OpenBao is sealed
   (`/sys/health`), on a jump in signatures, and on requests from anywhere but the facilitator.
8. **Hetzner account:** 2FA for everyone, few people with access, no automatic snapshots of the
   OpenBao machine (Raft snapshots are its backup). The console's rescue mode and snapshots reach
   the disk (the BlackWallet lesson).

**Staging:** on testnet, OpenBao can start in a container on the dedicated server next to the
facilitator, at no cost, to prove signing through OpenBao end to end; it gives no isolation. It
moves to its own machine before mainnet.

## Open questions

- Whether the Robot vSwitch has a fee.
- The signing latency over the vSwitch (the spike measured ~6 ms locally).
- CPX02 or CPX12, and one node or three on mainnet.

## Sources

- [Hetzner: Connect Dedicated Servers (vSwitch)](https://docs.hetzner.com/cloud/networks/connect-dedi-vswitch/)
  (checked 2026-10-16)
- [Hetzner: Networks FAQ](https://docs.hetzner.com/networking/networks/faq) and
  [Cloud Networks FAQ](https://docs.hetzner.com/cloud/networks/faq/): encryption, zones, cost
- [Hetzner Cloud locations](https://docs.hetzner.com/cloud/general/locations/)
- [Hetzner Regular Performance plans](https://www.hetzner.com/cloud/regular-performance/)
- [Hetzner Cloud pricing after the 2026 adjustments](https://agentdeals.dev/hetzner-pricing-2026)
  (prices from Hetzner's price API, 2026-10-07)
- [Hetzner Cloud pricing after the April 2026 increase](https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/)
