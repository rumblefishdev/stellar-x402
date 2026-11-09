# Runbook

The facilitator's `production` environment on the company Hetzner server
([ADR 0011](adr/0011-facilitator-hosting.md)): one facilitator, today serving testnet, behind
Cloudflare Tunnel at `https://x402-facilitator.sorobanscan.com`. Commands on the server run as an
admin with `sudo`; the admins are the explorer's (`soroban-block-explorer`'s
`infra-hetzner/ansible`).

## What is where

| Where                               | What                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/srv/x402/production/compose.yaml` | the Compose project `x402-production`                                                               |
| `/srv/x402/production/deploy.sh`    | the deploy key's forced command                                                                     |
| `/srv/x402/production/digest`       | the image `x402@production` runs; `digest.good` the last ready one                                  |
| `/srv/x402/production/digest.next`  | the digest a deploy is installing, the deploy user's only file                                      |
| `/srv/x402/production/creds/*.cred` | the credentials, encrypted with the host key                                                        |
| `/run/x402/production/`             | the credentials decrypted for the containers (tmpfs)                                                |
| `/srv/x402/openbao/`                | OpenBao's Compose project `x402-openbao`, its config and seal key                                   |
| `/run/x402/openbao/`                | the decrypted seal key; the recovery key for a moment (tmpfs)                                       |
| `/usr/local/libexec/x402/`          | the units' scripts (`deploy/libexec`)                                                               |
| `/etc/systemd/system/x402*`         | the units (`deploy/systemd`)                                                                        |
| `/etc/x402/`                        | the CloudWatch agent's config, the rotation's, the helper's ARNs, the Storage Box's pinned host key |
| `/srv/x402/backup/creds/*.cred`     | the backup jobs' credentials (OpenBao snapshots)                                                    |
| `/var/lib/x402/borg/`               | Borg's cache and the repository's last-seen state                                                   |
| `/var/log/x402/`                    | the files the CloudWatch agent ships (The CloudWatch agent)                                         |
| `/var/lib/x402/last-ok/`            | the stamps a backup or snapshot job touches after it succeeds                                       |

| Unit                                | Runs                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| `x402@production`                   | the facilitator                                           |
| `x402-db-testnet@production`        | testnet's PostgreSQL                                      |
| `x402-tunnel@production`            | `cloudflared`                                             |
| `x402-openbao`                      | OpenBao, the signer of every network                      |
| `x402-deploy@production`            | a deploy (a oneshot, started by `deploy.sh`)              |
| `x402-watchdog@production.timer`    | every 30 s, restarts an `unhealthy` facilitator           |
| `amazon-cloudwatch-agent`           | the CloudWatch agent, as `cwagent`                        |
| `x402-cloudwatch-credentials.timer` | every hour, the agent's 12-hour AWS keys                  |
| `x402-host-probe.timer`             | every minute, the host's signals as metrics               |
| `x402-logrotate.timer`              | every 10 minutes, rotates `/var/log/x402`                 |
| `x402-openbao-snapshot.timer`       | daily at 03:15 UTC, OpenBao's snapshot to the Storage Box |

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
`develop` takes pushes without a review. Each promotion moves `deploy/production`'s tip, and an
older commit would put older files back, so fetch it first, as below.

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

1. The pull request to `deploy/production` merges. Its image job starts at once, since the
   workflow ignores only `lore/**`, `docs/**` and `**/*.md`; its `deploy` job then waits for the
   production environment's approval. Approved before step 2, it runs with the files already on
   the server, so a change under `deploy/` must still work with the old ones until step 3. When
   it can't, for example a new credential the new image reads, split it into two pull requests:
   the files first, written to work with the image that runs, through steps 1 to 3; then the
   image change, as a plain deploy. A promotion carries everything waiting on `develop`, so the
   image change stays off `develop` until the files' promotion has been through steps 1 to 3.
2. The playbook from that merge, as above, at one of two times. Before approving the `deploy` job,
   which waits for the production environment: run step 3 too, and approve only once both have
   ended, so the deploy starts the new image on the new files (2026-11-04). Or once that deploy
   has ended. Run during the deploy, it would replace `deploy.sh` and the compose file under it.
   After the deploy, wait for the workflow run, not the unit: `x402-deploy@production` starts
   only after the image job and the SSH step, so right after the merge it is still inactive and
   looks ended. The run can take as long as a migration:

   ```sh
   gh run list --branch deploy/production --workflow deploy-production.yml --limit 1
   gh run watch <run id> --exit-status
   ```

3. A restart of each unit whose files changed. The production compose file is the facilitator's,
   the databases' and the tunnel's: stop the facilitator first, which drains, so no settlement
   loses its database or the tunnel mid-request, then restart the others and start it again.
   OpenBao's compose file and `config.hcl` are `x402-openbao`'s alone. Run it while `/settle` is
   idle: the drain then ends in seconds, and the whole window takes 30 to 60 s. With every unit
   at its cap it can take about 8 minutes, past `uptime`'s 7; once that alarm is on, post in the
   channel first.

   ```sh
   sudo systemctl stop x402@production
   sudo systemctl restart x402-openbao   # only when its files changed; /settle is down anyway
   sudo systemctl restart x402-db-testnet@production
   sudo systemctl restart x402-tunnel@production
   sudo systemctl start x402@production
   ```

   `x402@production` starts `digest.good`, so the new image isn't running yet. If step 2 ran
   before the approval, approve the waiting `deploy` job now. If step 1's deploy failed,
   **Run workflow** on `deploy/production` again now.

Then check that each container kept what its compose file drops (task 0091):

```sh
for p in x402-production x402-openbao; do  # one each: repeated label filters must all match
  sudo docker ps -q --filter label=com.docker.compose.project=$p
done | xargs -r sudo docker inspect --format \
  '{{.Name}} user={{.Config.User}} drop={{.HostConfig.CapDrop}} add={{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}}'
sudo /usr/local/libexec/x402/x402-compose production --profile migrate config migrate-testnet \
  | grep -A1 -E 'cap_drop|security_opt'
```

Each running container shows `drop=[ALL]`, `add=[]` and `[no-new-privileges:true]`, and Postgres
`user=999:999`. `migrate-testnet` runs only during a deploy,
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
| `storage-box-ssh-key`       | Borg (the write sub-account)   | the snapshot job    |
| `borg-passphrase`           | Borg                           | the snapshot job    |
| `snapshot-role-id`          | the snapshot job's login       | the snapshot job    |
| `snapshot-secret-id`        | the snapshot job's login       | the snapshot job    |

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
  approving review, approved after its last push by someone other than whoever made it (a push to
  `develop` while a promotion is open lands in it), no bypass.
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
`sudo tail -F /var/log/x402/production/deploy.log`; `journalctl -u x402-deploy@production` has only
its start and end.

A deploy that lowers `SETTLE_BUDGET_MS` makes the new process close the old process's live claims
early. A sweep closes a claim with no hash at its start plus its own budget plus 5 s, and a repeat
at its start plus the budget, each with its own process's budget. Those buyers get
`settle_exact_stellar_interrupted` with `extra.retryable`, and repeating the same payment settles
it. Expect one round of such answers. No money moves for a closed claim: the store refuses its
hash.

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

  `gh workflow run` and **Run workflow** need the workflow on the default branch, `main`, so `main`
  holds a stub of `deploy-production.yml` for that alone (#126). The form opens on `main`: choose
  **Use workflow from → `deploy/production`**; a run from `main` fails and says so. A run uses
  `deploy/production`'s own file, and a push to `deploy/production` starts one without the stub
  (2026-11-04). Keep the stub's `name` and inputs the same as the real file's, since the form and
  `-f` read them from `main`. If GitHub refuses, deploy the digest on the server instead (Deploy,
  above).

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
    -p StandardOutput=append:/var/log/x402/production/deploy.log -p StandardError=inherit \
    --setenv=FACILITATOR_IMAGE=ghcr.io/rumblefishdev/x402-facilitator@sha256:… \
    docker compose run --rm --name x402-production-migrate-testnet migrate-testnet
  sudo tail -F /var/log/x402/production/deploy.log   # shipped with the deploys' lines
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
`journalctl -u x402-watchdog@production`, and each one counts `watchdog_restarts_total`, which
fires `watchdog-restart`. Five starts in 300 s, a crash loop's, leave `x402@production` `failed`;
the deploy and the watchdog reset that count before their own restarts. After fixing the cause:
`sudo systemctl reset-failed x402@production` and start it.

A crash after `ready` in cycles of a minute or more never reaches that limit, so every end of
`x402@production` but a success counts `facilitator_failures_total`, which fires
`facilitator-failed`: a crash, a failed start, a drain cut short, a `dockerd` crash, and the
watchdog's kill of a hung process, which fires `watchdog-restart` beside it. The line in
`/var/log/x402/host/metrics.log` says how it ended (`result`, `exit_code`, `exit_status`), and
the reason is at the end of `facilitator.log` or `facilitator.err.log` just before it.

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
   the snapshots (OpenBao snapshots).

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

## OpenBao snapshots

Once a day `x402-openbao-snapshot.timer` saves a Raft snapshot and sends it to our Borg repository
on the Storage Box ([ADR 0013](adr/0013-facilitator-key-custody.md), task 0026). It logs in with
the AppRole `x402-snapshot`, whose policy allows only `sys/storage/raft/snapshot`, keeps 14 daily
archives and touches `/var/lib/x402/last-ok/openbao-snapshot` when every step passed. 0027's
`snapshot-age` alarm reads that stamp. Its output is in `journalctl -u x402-openbao-snapshot`.

| Storage Box (BX21 `ch-prod-01-backup`, port 23) | Home         | Use                                   |
| ----------------------------------------------- | ------------ | ------------------------------------- |
| `u595862-sub2`, reachable only from the server  | `/x402`      | writes: the snapshots, `data/openbao` |
| `u595862-sub3`, reachable from outside          | `/x402/data` | reads only: a restore, its key in AWS |

The box's host key is pinned in `deploy/ansible/files/storage-box.known_hosts`
(`SHA256:XqONwb1S0zuj5A1CDxpOSuD2hnAArV1A3wKY7Z3sdgM`). The box takes its own daily snapshots too,
which our keys can't delete. A restore from one copies our directory out of `.zfs/snapshot` with
the box's main account, never a rollback in the Console, which reverts the whole box.

**Borg runs in repokey mode:** the repository's key is on the box, locked by the passphrase, and
`borg key export` is in the backup secret too, so a damaged key in the repository can be replaced.
Nothing on the box decrypts a snapshot by itself.

`x402-openbao-snapshot borg ARGS` runs any Borg command on the repository with the job's
credentials, host key and settings, and removes the decrypted files after. It takes the job's lock,
so during the night's run it waits for it (up to 10 minutes):

```sh
sudo /usr/local/libexec/x402/x402-openbao-snapshot borg list
sudo /usr/local/libexec/x402/x402-openbao-snapshot borg check --repository-only
```

### Setting it up

Once, after a playbook run with this job (it installs Borg, the script, the policy file and the
host key, and enables the timer without starting it; until step 4 makes the AppRole's credential,
a run the timer starts after a reboot is skipped).

1. **The Storage Box key**, made on the server on 2026-11-05, its private half only in this
   credential (`SHA256:B7SozkS7mimbWA1OLyEdfRJ/Yp0i/T5pfTnWJB4bQU0`). Again, in a root shell:

   ```sh
   umask 077; t=$(mktemp -d /run/x402-keygen.XXXXXX)
   ssh-keygen -q -t ed25519 -N '' -C 'x402-backup@ch-prod-01 (u595862-sub2)' -f "$t/key"
   systemd-creds encrypt --with-key=host --name=storage-box-ssh-key "$t/key" /srv/x402/backup/creds/storage-box-ssh-key.cred
   cat "$t/key.pub"; shred -u "$t/key"; rm -rf "$t"
   ```

   The public half goes to whoever holds the box's main account, for `/x402/.ssh/authorized_keys`.

   **The read-only account's key,** for a restore from outside the server, made on the admin's
   machine on 2026-11-05 (`SHA256:cusjUd5fHX1CBCnAj1e7Fnn9E6iK9PUNgLN8aVxwgw0`) and kept only in
   the backup secret, as `storage_box_ro_user` and `storage_box_ro_ssh_key`. Again, from the root
   of this repo, with nothing else in the secret changing:

   ```sh
   (
   set -eu
   export AWS_PROFILE=soroban-admin AWS_REGION=eu-central-1
   id=x402/production/openbao-backup
   umask 077; t=$(mktemp -d /dev/shm/x402-keygen.XXXXXX); trap 'shred -u "$t/key" 2>/dev/null; rm -rf "$t"' EXIT
   ssh-keygen -q -t ed25519 -N '' -C 'x402-restore (u595862-sub3)' -f "$t/key"
   cur=$(aws secretsmanager get-secret-value --secret-id $id --query SecretString --output text)
   new=$(printf %s "$cur" | k=$(cat "$t/key") jq -c '.storage_box_ro_user = "u595862-sub3" | .storage_box_ro_ssh_key = env.k | .updated = (now | todate)')
   strip='del(.storage_box_ro_user, .storage_box_ro_ssh_key, .updated)'
   [ "$(printf %s "$cur" | jq -S "$strip")" = "$(printf %s "$new" | jq -S "$strip")" ] || { echo "other fields changed"; exit 1; }
   printf %s "$new" | aws secretsmanager put-secret-value --secret-id $id --secret-string file:///dev/stdin --query VersionId --output text
   [ "$(aws secretsmanager get-secret-value --secret-id $id --query SecretString --output text)" = "$new" ] && echo "secret: read back the same"
   cat "$t/key.pub"
   )
   ```

   The public half goes to whoever holds the box's main account, for `u595862-sub3`'s
   `authorized_keys` (`/x402/data/.ssh/`). Check it from outside Hetzner: it lists `openbao` and
   `pgbackrest`, and a `mkdir` fails.

2. **Borg on both ends.** The box keeps several Borg versions for us; the script asks for
   `borg-1.2` (`BORG_REMOTE_PATH`), whose major version must be the server's package's:

   ```sh
   borg --version   # 1.2.x; for another major, change BORG_REMOTE_PATH by pull request first
   ```

   Step 3's `borg init` is the first call to the box, so it fails there if the box lacks it.

3. **The passphrase and the repository,** from the admin's machine at the root of this repo. The
   passphrase lives in this subshell's memory, then only in the credential and the backup secret.
   The export and the passphrase go into AWS in one `put-secret-value`, since the export is
   encrypted with the passphrase. Nothing changes the secret unless every other field stays the
   same.

   ```sh
   (
   set -eu
   export AWS_PROFILE=soroban-admin AWS_REGION=eu-central-1
   id=x402/production/openbao-backup
   cred=/srv/x402/backup/creds/borg-passphrase.cred
   ssh SERVER "sudo test ! -e $cred" || { echo "a passphrase is already stored: this step is done"; exit 1; }
   pass=$(openssl rand -base64 32 | tr -d '\n')
   printf %s "$pass" | ssh SERVER "sudo systemd-creds encrypt --with-key=host --name=borg-passphrase - $cred"
   ssh SERVER 'sudo /usr/local/libexec/x402/x402-openbao-snapshot borg init -e repokey-blake2' ||
     { ssh SERVER "sudo rm $cred"; echo "borg init refused (a repository already there?): passphrase removed"; exit 1; }
   export_=$(ssh SERVER 'sudo /usr/local/libexec/x402/x402-openbao-snapshot borg key export :: -')
   [ "${export_#BORG_KEY }" != "$export_" ] || { echo "no key export"; exit 1; }
   cur=$(aws secretsmanager get-secret-value --secret-id $id --query SecretString --output text)
   new=$(printf %s "$cur" | p=$pass e=$export_ jq -c '.borg_passphrase = env.p | .borg_key_export = env.e | .updated = (now | todate)')
   strip='del(.borg_passphrase, .borg_key_export, .updated)'
   [ "$(printf %s "$cur" | jq -S "$strip")" = "$(printf %s "$new" | jq -S "$strip")" ] || { echo "other fields changed"; exit 1; }
   printf %s "$new" | aws secretsmanager put-secret-value --secret-id $id --secret-string file:///dev/stdin --query VersionId --output text
   [ "$(aws secretsmanager get-secret-value --secret-id $id --query SecretString --output text)" = "$new" ] && echo "secret: read back the same"
   )
   ```

   The step refuses to run twice: a stored passphrase stops it before anything is written, and a
   `borg init` that finds a repository already on the box removes the passphrase it just stored,
   so the job is never left with one that opens nothing. A rebuilt server with the repository
   still on the box takes the secret's `borg_passphrase` instead; that path comes with the restore
   drill. If it stopped after `borg init`, the repository is still empty: delete it and the
   credential, then run step 3 again:

   ```sh
   sudo /usr/local/libexec/x402/x402-openbao-snapshot borg delete ::   # asks for YES
   sudo rm /srv/x402/backup/creds/borg-passphrase.cred
   ```

4. **The AppRole,** in a root shell with a root token (A new root token, above):

   ```sh
   bao policy write x402-snapshot - < /srv/x402/openbao/x402-snapshot.hcl
   bao write auth/approle/role/x402-snapshot token_policies=x402-snapshot token_ttl=5m token_max_ttl=5m </dev/null
   v=$(bao read -field=role_id auth/approle/role/x402-snapshot/role-id </dev/null) && [ -n "$v" ] &&
     printf %s "$v" | systemd-creds encrypt --with-key=host --name=snapshot-role-id - \
       /srv/x402/backup/creds/snapshot-role-id.cred
   v=$(bao write -f -field=secret_id auth/approle/role/x402-snapshot/secret-id </dev/null) && [ -n "$v" ] &&
     printf %s "$v" | systemd-creds encrypt --with-key=host --name=snapshot-secret-id - \
       /srv/x402/backup/creds/snapshot-secret-id.cred
   unset v
   ```

   `</dev/null` keeps each `bao` from reading the rest of a pasted block as its input. Then step 5
   of OpenBao's setup: revoke the root token and leave the shell.

5. **The first run,** then the timer:

   ```sh
   sudo systemctl start x402-openbao-snapshot.service
   journalctl -u x402-openbao-snapshot -n 30 --no-pager   # "snapshot saved, … bytes"
   sudo /usr/local/libexec/x402/x402-openbao-snapshot borg list
   ls -l /var/lib/x402/last-ok/openbao-snapshot
   sudo systemctl start x402-openbao-snapshot.timer
   systemctl list-timers x402-openbao-snapshot.timer
   ```

   Then the `snapshots` alarm group goes on (`infra/README.md`), so a run that fails every night
   alerts instead of showing only in the journal. From `infra/`:

   ```sh
   make check-series GROUP=snapshots   # until it passes: the stamp's age has reached CloudWatch
   # then "snapshots": true in infra/envs/production.json, by pull request
   make deploy-production-alarms
   make fire-test
   ```

### Changing Borg's passphrase

The export is encrypted with the passphrase, so both fields of the backup secret change together.
The new passphrase is stored on the server before the repository changes, so a step that fails
never leaves the repository under a passphrase nobody has, and the timer is stopped meanwhile.

```sh
(
set -eu
export AWS_PROFILE=soroban-admin AWS_REGION=eu-central-1
id=x402/production/openbao-backup
c=/srv/x402/backup/creds
ssh SERVER 'sudo systemctl stop x402-openbao-snapshot.timer'
pass=$(openssl rand -base64 32 | tr -d '\n')
printf %s "$pass" | ssh SERVER "sudo systemd-creds encrypt --with-key=host --name=borg-passphrase - $c/borg-passphrase.next.cred"
printf %s "$pass" | ssh SERVER 'sudo sh -c "BORG_NEW_PASSPHRASE=\$(cat) /usr/local/libexec/x402/x402-openbao-snapshot borg key change-passphrase ::"'
ssh SERVER "sudo mv $c/borg-passphrase.cred $c/borg-passphrase.old.cred && sudo mv $c/borg-passphrase.next.cred $c/borg-passphrase.cred"
export_=$(ssh SERVER 'sudo /usr/local/libexec/x402/x402-openbao-snapshot borg key export :: -')
[ "${export_#BORG_KEY }" != "$export_" ] || { echo "no key export"; exit 1; }
cur=$(aws secretsmanager get-secret-value --secret-id $id --query SecretString --output text)
new=$(printf %s "$cur" | p=$pass e=$export_ jq -c '.borg_passphrase = env.p | .borg_key_export = env.e | .updated = (now | todate)')
strip='del(.borg_passphrase, .borg_key_export, .updated)'
[ "$(printf %s "$cur" | jq -S "$strip")" = "$(printf %s "$new" | jq -S "$strip")" ] || { echo "other fields changed"; exit 1; }
printf %s "$new" | aws secretsmanager put-secret-value --secret-id $id --secret-string file:///dev/stdin --query VersionId --output text
[ "$(aws secretsmanager get-secret-value --secret-id $id --query SecretString --output text)" = "$new" ] && echo "secret: read back the same"
ssh SERVER 'sudo /usr/local/libexec/x402/x402-openbao-snapshot borg list --last 1'   # the new passphrase opens the repository
ssh SERVER "sudo rm $c/borg-passphrase.old.cred && sudo systemctl start x402-openbao-snapshot.service x402-openbao-snapshot.timer"
)
```

Then `journalctl -u x402-openbao-snapshot -n 30 --no-pager` shows the run, and the restore drill
follows when it is next due.

**If it stopped partway,** the timer stays stopped and the alarm fires a day later:

- Before `change-passphrase`: the repository is unchanged. Delete `borg-passphrase.next.cred`
  and start the timer.
- After it, before the swap: the new passphrase is in `borg-passphrase.next.cred`. Run the swap
  line and the rest by hand, reading the passphrase back with
  `sudo systemd-creds decrypt --name=borg-passphrase $c/borg-passphrase.next.cred -`.
- After the swap, before AWS: the server works; the secret still has the old passphrase and
  export, which still open a copy of the repository (the restore drill imports the export). Run
  the lines from `export_=` on, with `pass` read from the credential as above.
- To go back to the old passphrase on the repository: `borg key import` the secret's
  `borg_key_export` (it is locked by `borg_passphrase`), and move `borg-passphrase.old.cred` back.

### Testing locally

The script takes its paths from the environment, so it runs against a throwaway OpenBao and a
container standing in for the box: `X402_CREDS_DIR` (plain files instead of credentials, left in
place), `X402_OPENBAO_DIR` (a copy of `deploy/openbao` with its own volume names),
`X402_STAMPS`, `X402_KNOWN_HOSTS`, `BORG_REPO`, `BORG_REMOTE_PATH` and `BORG_BASE_DIR`. 0026's
implementation notes have the run of 2026-11-05: a snapshot, the restore of it into a second
OpenBao through a copy of the repository with its key imported from the export, and the same
Transit key after it.

## Topping up the fee account

`balance-low` (below 25 XLM, about 5 days of settlements) and `balance-critical` (below 10 XLM,
about a day) name the network and the fee account, from `infra/envs/production.json`'s
`feeAccounts` (0027). At 5 XLM 0024's floor stops settlement. Top-ups are by hand, never from a key
on the server (ADR 0013).

**Testnet.** Friendbot only creates accounts, so a one-off account it funds with 10,000 XLM is
merged into the fee account, which moves its whole balance and deletes it. From
`packages/signer-pool` on the admin's machine, with the address from the alarm:

```sh
export TOPUP_SECRET=$(node -e 'console.log(require("@stellar/stellar-sdk").Keypair.random().secret())')
topup=$(node -e 'console.log(require("@stellar/stellar-sdk").Keypair.fromSecret(process.env.TOPUP_SECRET).publicKey())')
curl -sf "https://friendbot.stellar.org?addr=$topup" >/dev/null && echo funded
node -e '
const s = require("@stellar/stellar-sdk");
const kp = s.Keypair.fromSecret(process.env.TOPUP_SECRET);
const horizon = new s.Horizon.Server("https://horizon-testnet.stellar.org");
horizon.loadAccount(kp.publicKey()).then((a) => {
  const tx = new s.TransactionBuilder(a, { fee: s.BASE_FEE, networkPassphrase: s.Networks.TESTNET })
    .addOperation(s.Operation.accountMerge({ destination: process.argv[1] }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  return horizon.submitTransaction(tx);
}).then((r) => console.log("merged", r.hash));
' ADDRESS
unset TOPUP_SECRET topup
```

The merge reaches the fee account as `account_credited` alone, which `account-effects` lets
through, and the balance alarm reads OK at the off-server check's next run. Tried on 2026-11-05
between two one-off accounts: 9,999.99999 XLM arrived. If the fee account is gone, after
testnet's reset, Friendbot creates it again (OpenBao, step 6).

**Mainnet.** A withdrawal from the company's exchange account to the fee account. Who makes it,
and a backup person, are named before mainnet (ADR 0013, 0026).

## The CloudWatch agent

The only process on the server that talks to AWS (0027, its server-side spine): it ships the
files under `/var/log/x402/` to `/x402/production/app` and `/x402/production/metrics`, and the
server's memory and disk use to `x402-host`. Nothing is ordered after it, so an AWS or agent
outage stops no container. Its keys come from IAM Roles Anywhere: every hour
`x402-cloudwatch-credentials` runs `aws_signing_helper update --once` as `cwagent`, with the key
`/srv/x402/production/creds/cloudwatch-agent-key.cred` and the certificate
`/srv/x402/production/cloudwatch-agent.crt`, and writes 12-hour keys to
`/run/x402-cloudwatch/credentials`, which only `cwagent` reads. So the agent ships through a Roles
Anywhere outage of up to about 11 hours. The agent starts the helper at boot, and starts whether
it succeeded or not.

**Before the first start,** once, each step agreed separately (the AWS account is shared):

1. `/x402/production/server-ip` in SSM and the Telemetry stack (`infra/README.md`): the trust
   anchor, profile, logging role and the two log groups.
2. The ARNs into `deploy/ansible/inventory.ini` (`logging_trust_anchor_arn`,
   `logging_profile_arn`): `make telemetry-arns` in `infra/`. The playbook builds the role's ARN
   from their account.
3. The certificate. The key was made on the server on 2026-11-05 and its CSR
   (`CN=x402-cloudwatch-agent-production`, `CA:FALSE`, `digitalSignature`, `clientAuth`, as
   Roles Anywhere and the trust policy require) went to the ClickHouse project's CA holder, who
   signs it for 365 days; the explorer's `issue-client-cert.sh` makes its own key, so it signs
   our CSR instead. The certificate is public: commit it as
   `deploy/ansible/files/cloudwatch-agent-production.crt` by pull request to `deploy/production`.
   The playbook checks it (`deploy/scripts/check-agent-certificate.sh`) and that it is the key's
   before it copies it. Committed with #113: issued by `soroban-internal-ca-2026`, serial
   `5A0C505BB66E988BA8A444759F678B0B`, valid until 2027-11-05 11:17:43 UTC, its public key the
   CSR's.

**The admin step,** as `deploy` with sudo, after the playbook run from that merge:

```sh
sudo systemctl start x402-cloudwatch-credentials.service
journalctl -u x402-cloudwatch-credentials -n 5   # "Credentials will be refreshed at ..."
sudo test -s /run/x402-cloudwatch/credentials && echo ok
sudo systemctl start x402-cloudwatch-credentials.timer amazon-cloudwatch-agent
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status
ps -o user= -p "$(systemctl show -p MainPID --value amazon-cloudwatch-agent)"   # cwagent
sudo grep -E ' E! |AccessDenied|Expired' /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
sudo tail -n 8 /var/log/x402/host/metrics.log   # credentials_age_seconds under 3600
```

Then, with SSO, `aws logs tail /x402/production/metrics --log-stream-names host --since 5m` shows
the probe's lines, and `make check-series GROUP=host` in `infra/` the series.

**Where the logs are.** Each unit appends its output to a file the agent ships, so its history
outlives the server (0027 decision 1); `journalctl -u` keeps only a unit's own start and stop
lines. The watchdog, the host probe, the helper and the agent itself stay in the journal (the
agent's own log is `/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log`).

| `/var/log/x402/`                  | Written by                                    | Stream, group                                      |
| --------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| `production/facilitator.log`      | `x402@production`, stdout                     | `facilitator` in `app`; its EMF lines in `metrics` |
| `production/facilitator.err.log`  | `x402@production`, stderr                     | `facilitator-stderr` in `app`                      |
| `production/postgres-testnet.log` | `x402-db-testnet@production`                  | `postgres-testnet` in `app`                        |
| `production/cloudflared.log`      | `x402-tunnel@production`                      | `cloudflared` in `app`                             |
| `production/deploy.log`           | the deploys, their migrations, `x402-migrate` | `deploy` in `app`                                  |
| `openbao/openbao.log`             | `x402-openbao`                                | `openbao` in `app`                                 |
| `host/metrics.log`                | the host probe, the watchdog, `x402@`'s stop  | `host` in `metrics`                                |

`x402-logrotate.timer` rotates a file past 100 MB every 10 minutes and keeps 10: `*.log.1` as it
was, the older ones compressed. A rotation during an AWS outage loses the app lines the agent
hadn't sent yet from CloudWatch, never from the server: they are in `*.log.1` (ADR 0011).

**The units' first move to files** (0027), after the admin step, in the window of The playbook's
step 3 with all four units restarted: the facilitator, OpenBao, the database and the tunnel.
`x402-deploy@production` takes its new unit at the next deploy. Then `/health` says `ready`, the
files above grow, and their streams arrive in both groups.

**Renewing the certificate,** yearly; the `certificate` alarm fires 30 days ahead. A new key each
time, kept as a dated version behind `cloudwatch-agent-key.cred`, as `rpc-urls.testnet` is
(Credentials). The decrypted key goes through a pipe only:

```sh
d=$(date +%F); c=/srv/x402/production/creds
sudo sh -c "umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 |
  systemd-creds encrypt --with-key=host --name=cloudwatch-agent-key - $c/cloudwatch-agent-key.$d.cred"
sudo systemd-creds decrypt --name=cloudwatch-agent-key "$c/cloudwatch-agent-key.$d.cred" - |
  openssl req -new -key /dev/stdin -subj /CN=x402-cloudwatch-agent-production \
    -addext 'basicConstraints=critical,CA:FALSE' -addext 'keyUsage=critical,digitalSignature' \
    -addext 'extendedKeyUsage=clientAuth'   # the CSR, for the CA holder
```

The CA holder reissues the CN (`--force`) from the CSR, and the certificate goes through a pull
request to `deploy/production`. Once its deploy has ended, in one sitting: the key first, since
the playbook refuses a certificate that isn't the active key's.

```sh
# The first renewal only: today's key becomes its first dated version.
sudo mv "$c/cloudwatch-agent-key.cred" "$c/cloudwatch-agent-key.2026-11-05.cred"
sudo ln -sfn "cloudwatch-agent-key.$d.cred" "$c/cloudwatch-agent-key.cred"
```

Then the playbook, which now copies the certificate, and
`sudo systemctl start x402-cloudwatch-credentials.service` with the checks of the admin step. The
keys in the file last 12 hours, which covers the sitting; moving the symlink back undoes it.
Remove the old version once the start succeeded.

**Upgrading the agent or the helper** changes the version and the SHA-256 in the playbook's vars
by pull request. The agent's package is signed: verify it once, on a laptop, before pinning it,
and re-run the 0027 spike's stub case for its `PutMetricData` before it merges.

```sh
v=1.300074.1b2005; u=https://amazoncloudwatch-agent.s3.amazonaws.com
curl -fsSLO "$u/ubuntu/amd64/$v/amazon-cloudwatch-agent.deb"
curl -fsSLO "$u/ubuntu/amd64/$v/amazon-cloudwatch-agent.deb.sig"
curl -fsSL "$u/assets/amazon-cloudwatch-agent.gpg" | gpg --import
gpg --fingerprint 937616F3450B7D806CBD9725D58167303B789C72   # must be listed
gpg --verify amazon-cloudwatch-agent.deb.sig amazon-cloudwatch-agent.deb
sha256sum amazon-cloudwatch-agent.deb
```

AWS doesn't sign the helper's Linux build: its SHA-256 is the one the Roles Anywhere user guide's
credential helper page lists, which shows only the current version, so read it on the day of the
pin.

## Not here yet

- OpenBao's restore drill, key rotation as an on-chain signer change, mainnet's
  fee float top-ups (0036, 0047). After a restore on the same server, restart the facilitator: a token newer
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
- The agent's config under `cwagent`: the agent hands its `etc/` to `cwagent` at every start and
  its root wrapper translates it at the next one, so a compromised `cwagent` could make the agent
  root. A drop-in that restores a root-owned config first comes before mainnet (0038).
- Restoring the service on another machine, RPC failover, testnet reset recovery, the incident
  process; mainnet (0038).
