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
| `/srv/x402/openbao/`                | OpenBao's Compose project `x402-openbao`, its config and seal key  |
| `/run/x402/openbao/`                | the decrypted seal key; the recovery key for a moment (tmpfs)      |
| `/usr/local/libexec/x402/`          | the units' scripts (`deploy/libexec`)                              |
| `/etc/systemd/system/x402*`         | the units (`deploy/systemd`)                                       |

| Unit                             | Runs                                            |
| -------------------------------- | ----------------------------------------------- |
| `x402@production`                | the facilitator                                 |
| `x402-db-testnet@production`     | testnet's PostgreSQL                            |
| `x402-tunnel@production`         | `cloudflared`                                   |
| `x402-openbao`                   | OpenBao, the signer of every network            |
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
it from a commit on `deploy/production`, never from `develop` or a working branch: root runs what
it installs, so whoever runs it, and from which commit, is the boundary around production.
`deploy/production` takes only an approved pull request with no bypass (Before the first deploy);
`develop` takes pushes without a review.

```sh
git status --short  # must print nothing: a local edit or new file would ride along unreviewed
git fetch origin && git switch --detach origin/deploy/production
cd deploy/ansible   # inventory.ini from inventory.ini.example, git-ignored
ansible-playbook -i inventory.ini playbook.yaml --check --diff
ansible-playbook -i inventory.ini playbook.yaml
```

It enables the units and starts only the watchdog's timer. A changed unit or compose file takes
effect at that unit's next restart; a restart of `x402@production` drains it, so plan it like a
deploy.

**A change under `deploy/`** reaches the server in this order:

1. The pull request to `deploy/production` merges. Its deploy starts at once, since the workflow
   ignores only `lore/**`, `docs/**` and `**/*.md`, and runs with the files already on the
   server, so a change under `deploy/` must still work with the old ones until step 3. When it
   can't, for example a new credential the new image reads, split it into two pull requests: the
   files first, written to work with the image that runs, through steps 1 to 3; then the image
   change, as a plain deploy.
2. Once that deploy has ended (`journalctl -fu x402-deploy@production`; it can take as long as a
   migration), the playbook from that merge, as above. Run during the deploy, it would replace
   `deploy.sh` and the compose file under it.
3. A restart of each unit whose files changed. The production compose file is the facilitator's,
   the databases' and the tunnel's: stop the facilitator first, which drains, so no settlement
   loses its database or the tunnel mid-request, then restart the others and start it again.
   OpenBao's compose file and `config.hcl` are `x402-openbao`'s alone.

   ```sh
   sudo systemctl stop x402@production
   sudo systemctl restart x402-db-testnet@production x402-tunnel@production
   sudo systemctl start x402@production
   sudo systemctl restart x402-openbao   # only when its files changed: every /settle fails meanwhile
   ```

   `x402@production` starts `digest.good`, so if step 1's deploy failed, the new image isn't
   running yet: **Run workflow** on `deploy/production` again now.

Then check that each container kept what its compose file drops (task 0091):

```sh
sudo docker ps -q --filter label=com.docker.compose.project=x402-production \
  --filter label=com.docker.compose.project=x402-openbao \
  | xargs -r sudo docker inspect --format \
    '{{.Name}} drop={{.HostConfig.CapDrop}} add={{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}}'
sudo /usr/local/libexec/x402/x402-compose production --profile migrate config migrate-testnet \
  | grep -A1 -E 'cap_drop|security_opt'
```

Each running container shows `drop=[ALL]` and `[no-new-privileges:true]`; only Postgres adds
`CAP_CHOWN CAP_DAC_READ_SEARCH CAP_SETGID CAP_SETUID`. `migrate-testnet` runs only during a deploy,
so the second command reads its settings from the compose file instead: `ALL` and
`no-new-privileges:true`.

## Credentials

Encrypted systemd credentials in `/srv/x402/production/creds/` (OpenBao's in
`/srv/x402/openbao/creds/`), one per file, each decrypted by the unit whose container reads it
([ADR 0011](adr/0011-facilitator-hosting.md)):

| Credential                  | Read by                        | Decrypted by        |
| --------------------------- | ------------------------------ | ------------------- |
| `database-url.testnet`      | facilitator, `migrate-testnet` | `x402@`, the deploy |
| `rpc-urls.testnet`          | facilitator                    | `x402@`             |
| `approle-role-id.testnet`   | facilitator                    | `x402@`             |
| `approle-secret-id.testnet` | facilitator                    | `x402@`             |
| `postgres-password.testnet` | `postgres-testnet`             | `x402-db-testnet@`  |
| `tunnel-token`              | `cloudflared`                  | `x402-tunnel@`      |
| `seal-key`                  | `openbao`                      | `x402-openbao`      |

Write one without the value reaching the disk, the shell history or the screen:

```sh
read -rs value   # paste, Enter
printf %s "$value" | sudo systemd-creds encrypt --with-key=host --name=NAME - /srv/x402/production/creds/NAME.cred
unset value
```

`systemd-creds` warns that `/var/lib/systemd/credential.secret` "is not located on encrypted media,
using anyway". That is `host` mode: the key it encrypts with sits on the server's disk. A TPM is
ADR 0013's first upgrade (Not here yet).

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
- The `production` environment: deployment branches limited to `deploy/production`, required
  reviewers with "Prevent self-review" on, since a dispatched `digest` skips the pull request, and
  the secret `DEPLOY_HOST` (a variable would print the server's address in every run's public
  log) and the variable `DEPLOY_PORT`. `deploy/production` is protected: a pull request with an
  approving review, no bypass.
- The repo's Actions settings: default workflow permissions read-only, and "Allow GitHub Actions
  to create and approve pull requests" off, so no workflow can approve its own way onto
  `deploy/production` (both were the other way on 2026-10-29).
- The playbook, then the credentials, then
  `sudo systemctl start x402-db-testnet@production x402-tunnel@production`.
- OpenBao set up, with testnet's key, policy and AppRole in it (OpenBao, below).
- Outbound 7844 over UDP and TCP allowed on the server (`cloudflared`).
- Cloudflare: Browser Integrity Check off for the hostname, Bot Fight Mode off (0026).
- The signer (0036), and the key's account and channels (OpenBao, step 6).
- `/srv/x402/production/.env` with the key's address and its channels, from OpenBao's steps 4
  and 6: public values, so a plain file, owned by `x402`, mode 0644, which the playbook leaves
  alone. `compose.yaml` requires both: without them `x402@`, the deploy's `migrate-testnet` and
  the `docker compose` commands here stop at interpolation.

  ```sh
  printf 'FACILITATOR_ADDRESS_TESTNET=%s\nCHANNELS_TESTNET=%s\n' ADDRESS CHANNELS |
    ssh SERVER 'sudo install -o x402 -g x402 -m 0644 /dev/stdin /srv/x402/production/.env'
  ```

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
`ready`, `listed` and `signer` ok. A failed migration changes nothing. Follow it with
`journalctl -fu x402-deploy@production`.

## Rollback

- **Automatic:** a new image that isn't `ready`, `listed` and `signer` ok in 120 s is replaced by
  `digest.good`, and the deploy fails. OpenBao being down fails it the same way.
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

  `gh workflow run` and **Run workflow** need GitHub to know the workflow. It knows the ones on the
  default branch, `main`, which doesn't have this one; whether a run from a push to
  `deploy/production` is enough hasn't been tried. If GitHub refuses, deploy the digest on the
  server instead (Deploy, above).

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

Nothing to do beforehand. The facilitator stops first and drains (up to 180 s) while Postgres,
the tunnel and OpenBao are still up, then those stop (Postgres's grace is 120 s). At boot they
start first, each unit decrypting its credentials again and OpenBao unsealing itself, then `x402@`
with `digest.good`. A
`docker-ce` upgrade stops and starts them the same way through `PartOf=docker.service`.
Afterwards: `systemctl list-units 'x402*'`, the `/supported` check above and `bao status`, which
says `Sealed false` and exits 2 when sealed. A sealed OpenBao passes the other two: with a wrong
seal key its container runs and its socket exists, so the unit is active, while `/supported` is
static and every `/settle` fails.

```sh
cd /srv/x402/openbao && sudo docker compose exec -T openbao bao status
```

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

## The deploy key and the host key

Both are pinned in the repo, so a change to either is a pull request, and it reaches
`deploy/production` only together with everything else waiting on `develop`. Until it does,
deploy by hand on the server (Deploy, above).

- **A new host key,** after a reinstall: CI refuses the server, as it should. Read the new
  `/etc/ssh/ssh_host_ed25519_key.pub` on the server itself, through Hetzner's console or a session
  you trust, never from a scan; pin it in `HOST_KEY` by pull request, and record its fingerprint in
  task 0026's history.
- **A leaked or lost deploy key:**
  1. On a leak, cut the old key off at once; workflow deploys stop until step 3. It is
     `x402-deploy`'s file, not the one of `deploy`, the admin user, in `/home/deploy`:
     `sudo truncate -s 0 /var/lib/x402-deploy/.ssh/authorized_keys`.
  2. Make a new pair as in "Before the first deploy": the private half into `DEPLOY_SSH_KEY`, the
     public half into `deploy/ansible/files/deploy-production.pub` by pull request.
  3. Once that is on `deploy/production`, run the playbook from it (The playbook, above), then
     **Run workflow** on `deploy/production`: the merge's own deploy failed on the old key, and
     nothing else starts one. The playbook writes the new key into
     `authorized_keys`, which then holds only that one. Record its fingerprint in task 0026's
     history.

## OpenBao

The facilitator key of every network, in Transit ([ADR 0013](adr/0013-facilitator-key-custody.md)):
one container, the Compose project `x402-openbao` in `/srv/x402/openbao/`, run by `x402-openbao`.
It has no network. Testnet's facilitator reaches it over a unix socket in the volume
`x402-openbao-testnet`, mounted into nothing else, and an admin, as root or in the `docker` group,
through `docker compose exec`:

```sh
cd /srv/x402/openbao && sudo docker compose exec openbao bao status
```

It unseals itself at every start with the seal key `x402-openbao` decrypts. Its storage (Raft) and
audit log are the volumes `x402-openbao-data` and `x402-openbao-audit`, made by the playbook. A
request OpenBao can't write to the audit log fails, so a full disk stops `/settle`. The playbook's
`/etc/logrotate.d/x402-openbao` rotates that log daily and keeps a year, compressed: `logrotate`
renames the file, and SIGHUP makes OpenBao open a new one. About 5 MB a day at 1,000 settlements.
After a playbook run that changes it, check one rotation by hand:

```sh
sudo logrotate -d /etc/logrotate.d/x402-openbao   # reads it, rotates nothing
sudo logrotate -f /etc/logrotate.d/x402-openbao
cd /srv/x402/openbao && sudo docker compose exec -T openbao ls -l /openbao/logs
```

A new `audit.log` that grows beside `audit.log.1`, and `signer: "ok"` in `/health` (What is
where, above), mean OpenBao reopened it and still signs.

**Setting it up,** once, after the playbook. The seal key and init's answer travel between the
admin's machine and the server over SSH and never reach a disk, so they live only in the admin's
shell: keep it open until step 5. Lost after step 3's `create-secret`, the backup secret has what
it held (**A lost shell**, below). Lost before it, between `init=` and `create-secret`, init's
answer is gone for good, and init can't run again on the same Raft storage, so OpenBao starts over
with new volumes. A stopped container still holds its volumes, so `down` comes before `rm`:

```sh
ssh SERVER sudo systemctl stop x402-openbao
ssh SERVER 'cd /srv/x402/openbao && sudo docker compose down'
ssh SERVER sudo docker volume rm x402-openbao-data x402-openbao-audit
ssh SERVER 'sudo docker volume create x402-openbao-data && sudo docker volume create x402-openbao-audit'
```

Then step 1 again, which writes a new `seal-key.cred`.

1. The seal key: 32 random bytes in hex, with no newline, which OpenBao refuses. Its ID is
   `current_key_id` in `deploy/openbao/config.hcl`. Keep `$seal_key` for step 3.

   ```sh
   seal_key=$(openssl rand -hex 32)
   printf %s "$seal_key" |
     ssh SERVER 'sudo systemd-creds encrypt --with-key=host --name=seal-key - /srv/x402/openbao/creds/seal-key.cred'
   ssh SERVER sudo systemctl start x402-openbao
   ```

2. Init, with ADR 0013's one recovery share:

   ```sh
   init=$(ssh SERVER 'cd /srv/x402/openbao && sudo docker compose exec -T openbao \
     bao operator init -recovery-shares=1 -recovery-threshold=1 -format=json')
   ```

   `printf %s "$init" | jq -r .root_token` is the token for step 4.

3. The backup secret `x402/production/openbao-backup`, as ADR 0013 makes it, from the root of this
   repo (`AWS_PROFILE=soroban-admin`). The JSON goes over stdin, so it never reaches a disk. The
   previous seal key's pair stays empty until a rotation, and the Borg and Storage Box fields until
   the snapshots (Not here yet).

   ```sh
   backup=$(seal_key=$seal_key recovery_key=$(printf %s "$init" | jq -r '.recovery_keys_b64[0]') \
     sha=$(printf %s "$seal_key" | shasum -a 256 | cut -d' ' -f1) \
     seal_config=$(sed -n '/^seal "static"/,/^}/p' deploy/openbao/config.hcl) \
     jq -n '{
       seal_key_hex: env.seal_key, seal_key_id: "x402-openbao-1", seal_key_sha256: env.sha,
       previous_seal_key_hex: "", previous_seal_key_id: "", recovery_key: env.recovery_key,
       borg_passphrase: "", borg_key_export: "", seal_config: env.seal_config,
       openbao_version: "2.7.2", storage_box_ro_user: "", storage_box_ro_ssh_key: "",
       updated: (now | todate)
     }')
   printf %s "$backup" | aws secretsmanager create-secret --region eu-central-1 \
     --name x402/production/openbao-backup --secret-string file:///dev/stdin \
     --tags Key=Project,Value=stellar-x402 Key=Environment,Value=production
   ```

   Read it back while nothing depends on it. AWS must hold what went in:

   ```sh
   back=$(aws secretsmanager get-secret-value --region eu-central-1 \
     --secret-id x402/production/openbao-backup --query SecretString --output text)
   [ "$back" = "$backup" ] && echo same
   ```

   And its recovery key must work: **A new root token** (below), which takes it from this secret,
   then `bao token revoke -self` and leave that root shell. Init's root token stays valid for
   step 4.

4. Per network, in a root shell on the server with init's root token, one line at a time: `read`
   takes the next line of a paste as the token, and `docker compose exec` reads stdin and swallows
   the rest. Mainnet first adds its listener and socket volume (0038).

   ```sh
   sudo -i
   cd /srv/x402/openbao
   read -rs BAO_TOKEN && export BAO_TOKEN   # paste the root token, Enter
   bao() { docker compose exec -T -e BAO_TOKEN openbao bao "$@"; }
   bao secrets enable transit && bao auth enable approle   # the first network only

   n=testnet
   bao write -f transit/keys/stellar-$n type=ed25519 exportable=false allow_plaintext_backup=false
   printf 'path "transit/sign/stellar-%s" {\n  capabilities = ["update"]\n}\n' $n |
     bao policy write x402-$n -
   bao write auth/approle/role/x402-$n token_policies=x402-$n token_no_default_policy=true \
     token_ttl=1h token_max_ttl=1h secret_id_ttl=0
   v=$(bao read -field=role_id auth/approle/role/x402-$n/role-id) && [ -n "$v" ] &&
     printf %s "$v" | systemd-creds encrypt --with-key=host --name=approle-role-id.$n - \
       /srv/x402/production/creds/approle-role-id.$n.cred
   v=$(bao write -f -field=secret_id auth/approle/role/x402-$n/secret-id) && [ -n "$v" ] &&
     printf %s "$v" | systemd-creds encrypt --with-key=host --name=approle-secret-id.$n - \
       /srv/x402/production/creds/approle-secret-id.$n.cred
   unset v
   bao read -format=json transit/keys/stellar-$n   # .data.keys["1"].public_key
   ```

   `v` is checked first because a pipe would run `systemd-creds` even when `bao` fails, and
   overwrite the credential with an empty one.

   The key's address goes into `FACILITATOR_ADDRESS_TESTNET` (0036). From its public key, in
   `packages/signer-pool` on the admin's machine:

   ```sh
   node -e 'console.log(require("@stellar/stellar-sdk").StrKey.encodeEd25519PublicKey(Buffer.from(process.argv[1], "base64")))' PUBLIC_KEY
   ```

5. `bao token revoke -self`, `unset BAO_TOKEN`, and leave the root shell. On the admin's machine,
   `unset seal_key init backup back`.

6. The key's own account, which pays the fee bumps (ADR 0013), then its channels, from
   `packages/signer-pool` on the admin's machine (#100). `create-channels.ts` checks neither: it
   makes channels for any valid address, and a wrong one leaves their reserves under a key that
   isn't ours. On testnet Friendbot creates the account, and a one-off wallet that Friendbot funds
   pays the channels; its secret lives only in this shell. Mainnet's wallet comes with 0038.

   ```sh
   curl -sf "https://friendbot.stellar.org?addr=ADDRESS" >/dev/null && echo created
   export FUNDER_SECRET=$(node -e 'console.log(require("@stellar/stellar-sdk").Keypair.random().secret())')
   funder=$(node -e 'console.log(require("@stellar/stellar-sdk").Keypair.fromSecret(process.env.FUNDER_SECRET).publicKey())')
   curl -sf "https://friendbot.stellar.org?addr=$funder" >/dev/null && echo funded
   NETWORK=testnet pnpm exec tsx scripts/create-channels.ts ADDRESS 20
   unset FUNDER_SECRET funder
   ```

   It prints the channels' addresses for `CHANNELS_TESTNET` (0036); 20 channels hold ADR 0013's
   ~30 XLM of reserves. If it stops after a batch landed, stderr has that batch's channels
   (`channel setup … landed: …`): run it again for the rest and join both lists.

**A new root token,** when an admin needs one again, from the recovery key in the backup secret.
The CLI's `generate-root` needs a token, so this is the legacy `/sys/generate-root` API, which the
admin listener answers without one (ADR 0013). First, on the admin's machine, the recovery key
goes from the backup secret to a file in `/run`, a tmpfs, that only root reads. It never passes
the clipboard or the screen: on 2026-11-03 a paste from the clipboard reached `read` empty.

```sh
AWS_PROFILE=soroban-admin aws secretsmanager get-secret-value --region eu-central-1 \
  --secret-id x402/production/openbao-backup --query SecretString --output text |
  jq -er .recovery_key |
  ssh SERVER 'sudo sh -c "umask 077; cat > /run/x402/openbao/recovery-key"'
```

If you stop here, remove it: `ssh SERVER sudo rm -f /run/x402/openbao/recovery-key`.

Then in a root shell on the server, one line at a time; the values go over stdin, because the
arguments of a command show in `ps`:

```sh
sudo -i
cd /srv/x402/openbao
bao() { docker compose exec -T -e BAO_TOKEN openbao bao "$@"; }
key=$(cat /run/x402/openbao/recovery-key) && rm /run/x402/openbao/recovery-key
[ ${#key} -eq 44 ] && echo ok || echo 'bad key: stop here'
n=$(bao read -field=otp_length sys/generate-root/attempt)
otp=$(openssl rand -base64 48 | tr -dc A-Za-z0-9 | head -c "$n")
nonce=$(printf %s "$otp" | bao write -field=nonce sys/generate-root/attempt otp=-)
encoded=$(printf %s "$key" | bao write -field=encoded_token sys/generate-root/update key=- nonce="$nonce")
export BAO_TOKEN=$(encoded=$encoded otp=$otp python3 -c 'import base64, os; e, o = os.environ["encoded"], os.environ["otp"]; print(bytes(a ^ b for a, b in zip(base64.b64decode(e + "=" * (-len(e) % 4)), o.encode())).decode())')
unset key otp nonce encoded
bao token lookup -format=json | python3 -c 'import json, sys; print(json.load(sys.stdin)["data"]["policies"])'   # ['root']
```

If a line after `nonce=` fails, the attempt stays open: a rerun answers 400 (`root generation
already in progress`) and `nonce` stays empty. `bao delete sys/generate-root/attempt` clears it,
with no token. When done, step 5 again.

**A lost shell,** after step 3's `create-secret`: `$init` is gone, and init's root token with it,
though it stays valid. A new root token as above, then, in the same root shell, one line at a
time, every other root token revoked by its accessor. Before step 4 those are the only other
tokens: init's, and step 3's if its `revoke -self` didn't run. `</dev/null` keeps each `bao`
from reading the terminal.

```sh
self=$(bao token lookup -format=json </dev/null | python3 -c 'import json, sys; print(json.load(sys.stdin)["data"]["accessor"])')
for a in $(bao list -format=json auth/token/accessors </dev/null | self=$self python3 -c 'import json, sys, os; print(" ".join(a for a in json.load(sys.stdin) if a != os.environ["self"]))'); do bao write -format=json auth/token/lookup-accessor accessor=$a </dev/null | python3 -c 'import json, sys; sys.exit("root" not in json.load(sys.stdin)["data"]["policies"])' && bao write auth/token/revoke-accessor accessor=$a </dev/null >/dev/null && echo "revoked $a"; done
```

The check prints every other token's accessor, policies and creation time, so here nothing:

```sh
for a in $(bao list -format=json auth/token/accessors </dev/null | self=$self python3 -c 'import json, sys, os; print(" ".join(a for a in json.load(sys.stdin) if a != os.environ["self"]))'); do bao write -format=json auth/token/lookup-accessor accessor=$a </dev/null | python3 -c 'import json, sys; d = json.load(sys.stdin)["data"]; print(d["accessor"], d["policies"], d["creation_time"])'; done
```

Then step 4 in this shell, without its `read`, and step 5 (`unset self` too).

## Not here yet

- OpenBao's snapshots and restore drill, key rotation as an on-chain signer change, fee float
  top-ups (0036, 0047). After a restore on the same server, restart the facilitator: a token newer
  than the snapshot answers 403 until its hour ends, and a 403 doesn't make the signer log in again.
- The key theft transaction (ADR 0013): no tool signs it and it has never run (0099).
- A leaked token or secret ID, OpenBao upgrades and what `/settle` does meanwhile, and the weekly
  review after the mainnet deploy (0026, ADR 0013).
- A TPM for the credentials (ADR 0013's first upgrade). Checked on 2026-11-03: the firmware
  exposes none, with no ACPI `TPM2` or `TCPA` table, no SMBIOS type 43 and no `/dev/tpm*` (ASRock
  Rack B450D4U-V1L, BIOS L2.12, Ryzen 9 3900). Not checked: most likely the Ryzen's fTPM is off in
  the BIOS. Turning it on needs Hetzner's KVM console and a reboot of the server the explorer
  shares (0100, before mainnet).
- pgBackRest backups, the database's restore drill and upgrade policy.
- The CloudWatch agent and renewing its Roles Anywhere certificate (0027).
- Restoring the service on another machine, RPC failover, testnet reset recovery, the incident
  process; mainnet (0038).
