# Runbook

The facilitator's `production` environment on the company Hetzner server
([ADR 0011](adr/0011-facilitator-hosting.md)): one facilitator, today serving testnet, behind
Cloudflare Tunnel at `https://x402-facilitator.sorobanscan.com`. Commands on the server run as an
admin with `sudo`; the admins are the explorer's (`soroban-block-explorer`'s
`infra-hetzner/ansible`).

## What is where

| Where                               | What                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `/srv/x402/production/compose.yaml` | the Compose project `x402-production`                              |
| `/srv/x402/production/deploy.sh`    | the deploy key's forced command                                    |
| `/srv/x402/production/digest`       | the image `x402@production` runs; `digest.good` the last ready one |
| `/srv/x402/production/digest.next`  | the digest a deploy is installing, the deploy user's only file     |
| `/srv/x402/production/creds/*.cred` | the credentials, encrypted with the host key                       |
| `/run/x402/production/`             | the credentials decrypted for the containers (tmpfs)               |
| `/usr/local/libexec/x402/`          | the units' scripts (`deploy/libexec`)                              |
| `/etc/systemd/system/x402*`         | the units (`deploy/systemd`)                                       |

| Unit                             | Runs                                            |
| -------------------------------- | ----------------------------------------------- |
| `x402@production`                | the facilitator                                 |
| `x402-db-testnet@production`     | testnet's PostgreSQL                            |
| `x402-tunnel@production`         | `cloudflared`                                   |
| `x402-deploy@production`         | a deploy (a oneshot, started by `deploy.sh`)    |
| `x402-watchdog@production.timer` | every 30 s, restarts an `unhealthy` facilitator |

Status at a glance:

```sh
systemctl list-units 'x402*'
sudo /usr/local/libexec/x402/x402-compose production exec -T facilitator \
  node -e "fetch('http://127.0.0.1:4021/health').then((r) => r.text()).then(console.log)"
curl -s https://x402-facilitator.sorobanscan.com/supported
```

## The playbook

It puts x402's parts on the server and touches nothing else (`deploy/ansible/playbook.yaml`). Run
it from a reviewed commit on `develop`, never from a working branch, since whoever runs it, and
from which commit, is the boundary around production:

```sh
git fetch origin && git switch --detach origin/develop
cd deploy/ansible   # inventory.ini from inventory.ini.example, git-ignored
ansible-playbook -i inventory.ini playbook.yaml --check --diff
ansible-playbook -i inventory.ini playbook.yaml
```

It enables the units and starts only the watchdog's timer. A changed unit or compose file takes
effect at that unit's next restart; a restart of `x402@production` drains it, so plan it like a
deploy.

## Credentials

Encrypted systemd credentials in `/srv/x402/production/creds/`, one per file, each decrypted by
the unit whose container reads it ([ADR 0011](adr/0011-facilitator-hosting.md)):

| Credential                  | Read by                        | Decrypted by        |
| --------------------------- | ------------------------------ | ------------------- |
| `database-url.testnet`      | facilitator, `migrate-testnet` | `x402@`, the deploy |
| `rpc-urls.testnet`          | facilitator                    | `x402@`             |
| `postgres-password.testnet` | `postgres-testnet`             | `x402-db-testnet@`  |
| `tunnel-token`              | `cloudflared`                  | `x402-tunnel@`      |

Write one without the value reaching the disk, the shell history or the screen:

```sh
read -rs value   # paste, Enter
printf %s "$value" | sudo systemd-creds encrypt --with-key=host --name=NAME - /srv/x402/production/creds/NAME.cred
unset value
```

- **The database password**, once, before `x402-db-testnet@production` first starts: Postgres
  takes it only when it creates the database.

  ```sh
  pw=$(openssl rand -hex 24)
  printf %s "$pw" | sudo systemd-creds encrypt --with-key=host --name=postgres-password.testnet - \
    /srv/x402/production/creds/postgres-password.testnet.cred
  printf 'postgres://postgres:%s@postgres-testnet:5432/x402' "$pw" |
    sudo systemd-creds encrypt --with-key=host --name=database-url.testnet - \
      /srv/x402/production/creds/database-url.testnet.cred
  unset pw
  ```

- **The RPC URLs** keep every version, so a log line's `RPC_URLS[i]#<fingerprint>` maps back to
  its URL: a new file per change, never an edit, and the symlink names the active one.

  ```sh
  d=$(date +%F)
  read -rs value   # the comma-separated URLs
  printf %s "$value" | sudo systemd-creds encrypt --with-key=host --name=rpc-urls.testnet - \
    "/srv/x402/production/creds/rpc-urls.testnet.$d.cred"
  unset value
  sudo ln -sfn "rpc-urls.testnet.$d.cred" /srv/x402/production/creds/rpc-urls.testnet.cred
  sudo systemctl restart x402@production   # a drain
  ```

- **The tunnel token**: below.

## Before the first deploy

- The deploy key: `ssh-keygen -t ed25519 -N '' -C x402-deploy-production -f deploy-production`;
  the public half into `deploy/ansible/files/deploy-production.pub` by pull request, the private
  half into the `production` environment's secret
  (`gh secret set DEPLOY_SSH_KEY --env production < deploy-production`), then
  `shred -u deploy-production`.
- The host key: the server's `/etc/ssh/ssh_host_ed25519_key.pub`, read on the server, into
  `HOST_KEY` in `.github/workflows/deploy-production.yml` by pull request.
- The `production` environment: deployment branches limited to `deploy/production`, the
  variables `DEPLOY_HOST` and `DEPLOY_PORT`. `deploy/production` is protected: a pull request
  with an approving review, no bypass.
- The repo's Actions settings: default workflow permissions read-only, and "Allow GitHub Actions
  to create and approve pull requests" off, so no workflow can approve its own way onto
  `deploy/production` (both were the other way on 2026-10-29).
- The playbook, then the credentials, then
  `sudo systemctl start x402-db-testnet@production x402-tunnel@production`.
- Outbound 7844 over UDP and TCP allowed on the server (`cloudflared`).
- Cloudflare: Browser Integrity Check off for the hostname, Bot Fight Mode off (0026).
- The signer and funded channels (0036).
- After the first image is pushed: the GHCR package `x402-facilitator` made public, so the server
  pulls without a login.

The first deploy has no `digest.good`: if it fails, there is nothing to go back to and the
facilitator stays down.

## Deploy

A pull request from `develop` to `deploy/production`, approved and merged; the workflow
**Deploy production** builds the commit's image and sends the digest its build reports. By hand:
**Run workflow** on `deploy/production`. On the server, through the same lock:

```sh
sudo -u x402-deploy env SSH_ORIGINAL_COMMAND=sha256:… /srv/x402/production/deploy.sh
```

The deploy unit decrypts the database URL, pulls the image, runs `migrate-testnet` while the old
facilitator serves, then restarts `x402@production` on the new image and waits up to 120 s for
`ready` and `listed`. A failed migration changes nothing. Follow it with
`journalctl -fu x402-deploy@production`.

## Rollback

- **Automatic:** a new image that isn't `ready` and `listed` in 120 s is replaced by
  `digest.good`, and the deploy fails.
- **By hand:** deploy an earlier digest. Each deployment's status carries it; a tag doesn't, since
  any workflow that may write packages can overwrite one:

  ```sh
  gh api 'repos/rumblefishdev/stellar-x402/deployments?environment=production&per_page=10' \
    --jq '.[] | "\(.id) \(.sha[:7]) \(.created_at)"'
  gh api repos/rumblefishdev/stellar-x402/deployments/ID/statuses --jq '.[].description' | grep sha256
  gh workflow run deploy-production.yml --ref deploy/production -f digest=sha256:…
  ```

  The older image's migrations are already applied, and every migration is expand/contract, so
  it runs on the newer schema.

## Long migrations

An online migration (a backfill, an index build) runs in the deploy, under the deploy unit's
60-minute cap, which covers the restart after it too. A deploy stopped by the cap or by hand
stops its migration container and ends with the facilitator on `digest.good`; the next deploy
continues from the steps the migration finished (ADR 0012), and nothing in the schema needs
undoing.

- **Disk first.** A backfill writes about 1.2 GiB of WAL per 2 million rows, and the table grows
  about a third. Until pgBackRest is here, the WAL stays in `pg_wal` until checkpoints recycle
  it; with it, each segment leaves as it closes. Compare the database volume's free space with
  the table's size (`pg_total_relation_size`, in the query below):

  ```sh
  df -h "$(sudo docker volume inspect -f '{{.Mountpoint}}' x402-production-postgres-testnet)"
  ```

- **Testnet first,** outside mainnet's busy hours and away from 00:00 UTC, when the production
  ClickHouse on the same disks writes the most. Once mainnet joins, one deploy migrates every
  network, so "testnet first" means running it by hand on testnet (below) before the deploy.
- **Progress:** each step logs as it ends and every 50 backfill batches. An index build, a
  `VALIDATE` or a wait for another run's lock is quiet until task 0080, so read what it does
  before stopping it:

  ```sh
  cd /srv/x402/production
  sudo FACILITATOR_IMAGE=unused docker compose exec postgres-testnet psql -U postgres -d x402 -c \
    "select pid, application_name, state, wait_event_type, wait_event,
            now() - query_start as running, left(query, 80)
       from pg_stat_activity where datname = 'x402' and pid <> pg_backend_pid()"
  ```

  The runner's sessions are named `x402-migrate`. An index build's progress is in
  `pg_stat_progress_create_index`; a run waiting for another's lock is an idle session polling
  `pg_try_advisory_lock`, with no wait event.

- **Stopping a run:** `sudo systemctl stop x402-deploy@production`. The lock on `digest.next` is
  released with it.
- **Longer than the cap:** run it ahead of the deploy, from the new image, in a unit of its own
  so a dropped SSH session doesn't stop it; the deploy then finds it applied.

  ```sh
  sudo /usr/local/libexec/x402/x402-creds production database-url.testnet:1000
  sudo systemd-run --unit=x402-migrate --collect --working-directory=/srv/x402/production \
    --setenv=FACILITATOR_IMAGE=ghcr.io/rumblefishdev/x402-facilitator@sha256:… \
    docker compose run --rm --name x402-production-migrate-testnet migrate-testnet
  journalctl -fu x402-migrate
  ```

  Deploy once `systemctl is-active x402-migrate` says `inactive`; a deploy meanwhile fails on the
  container's name before anything stops. To stop it, `sudo systemctl stop x402-migrate`, then
  `sudo docker stop x402-production-migrate-testnet` in case the container outlived the unit.

## Reboots and Docker upgrades

Nothing to do beforehand. The facilitator stops first and drains (up to 180 s) while Postgres
and the tunnel are still up, then those two stop (Postgres's grace is 120 s). At boot Postgres
and the tunnel start first, each unit decrypting its credentials again, then `x402@` with
`digest.good`. A
`docker-ce` upgrade stops and starts them the same way through `PartOf=docker.service`.
Afterwards: `systemctl list-units 'x402*'` and the `/supported` check above.

## The watchdog

Every 30 s, while `x402@production` is active, it stops an `unhealthy` facilitator with a 10 s
timeout and restarts the unit; it leaves a deploy, a reboot or a drain alone. Its restarts are in
`journalctl -u x402-watchdog@production`. Five starts in 300 s, a crash loop's, leave
`x402@production` `failed`; the deploy and the watchdog reset that count before their own
restarts. After fixing the cause: `sudo systemctl reset-failed x402@production` and start it.

## The tunnel token

The tunnel `x402` and its routing are Terraform in `soroban-infrastructure`'s `cloudflare/`. Its
token lives only in Cloudflare; fetch it with the API token from AWS Secrets Manager
(`soroban/cloudflare/infrastructure-api-token`, `AWS_PROFILE=soroban-admin`) and pipe it to the
server, so it never lands on a disk:

```sh
export CF_API_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id soroban/cloudflare/infrastructure-api-token --query SecretString --output text)
api=https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/cfd_tunnel
tunnel=$(curl -s -H "Authorization: Bearer $CF_API_TOKEN" "$api?name=x402&is_deleted=false" |
  jq -r '.result[0].id')
curl -s -H "Authorization: Bearer $CF_API_TOKEN" "$api/$tunnel/token" | jq -j .result |
  ssh SERVER 'sudo systemd-creds encrypt --with-key=host --name=tunnel-token - /srv/x402/production/creds/tunnel-token.cred'
ssh SERVER sudo systemctl restart x402-tunnel@production
```

Anyone with the token can run a second connector and receive part of the traffic. Check that
ours is the only one, from the server's IP:

```sh
curl -s -H "Authorization: Bearer $CF_API_TOKEN" "$api/$tunnel/connections" |
  jq '.result[] | {id, client_id, conns: [.conns[].origin_ip]}'
```

To rotate it: give the tunnel a new secret, 32 random bytes in base64 (a `PATCH` of
`$api/$tunnel` with `tunnel_secret`; not yet tried, so check Cloudflare's API reference the first
time), fetch the new token into the credential as above, restart the unit, then clean up the old
connections (`DELETE $api/$tunnel/connections`): ours reconnects with the new token, a connector
with the old one can't. Check the connections again.

## Not here yet

- The OpenBao signer: its container, unseal, snapshots and restore drill, key rotation as an
  on-chain signer change, fee float top-ups (0036, 0047).
- pgBackRest backups, the database's restore drill and upgrade policy.
- The CloudWatch agent and renewing its Roles Anywhere certificate (0027).
- Restoring the service on another machine, RPC failover, testnet reset recovery, the incident
  process; mainnet (0038).
