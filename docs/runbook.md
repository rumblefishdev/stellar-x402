# Runbook

The facilitator's `production` environment on the company Hetzner server
([ADR 0011](adr/0011-facilitator-hosting.md)): one facilitator, today serving testnet, behind
Cloudflare Tunnel at `https://x402-facilitator.sorobanscan.com`. Commands on the server run as an
admin with `sudo`; the admins are the explorer's (`soroban-block-explorer`'s
`infra-hetzner/ansible`). The portal's backend runs beside it, with a deploy of its own (The
portal's backend, below).

## What is where

| Where                               | What                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/srv/x402/production/compose.yaml` | the Compose project `x402-production`                                                               |
| `/srv/x402/production/deploy.sh`    | the deploy key's forced command                                                                     |
| `/srv/x402/production/digest`       | the image `x402@production` runs; `digest.good` the last ready one                                  |
| `/srv/x402/production/digest.next`  | the digest a deploy is installing; with `portal.digest.next`, the deploy user's only files          |
| `/srv/x402/production/portal.*`     | the portal's: `portal.compose.yaml`, and `portal.digest`, `.good` and `.next` as the facilitator's  |
| `/srv/x402/production/creds/*.cred` | the credentials, encrypted with the host key                                                        |
| `/run/x402/production/`             | the credentials decrypted for the containers (tmpfs)                                                |
| `/srv/x402/openbao/`                | OpenBao's Compose project `x402-openbao`, its config and seal key                                   |
| `/run/x402/openbao/`                | the decrypted seal key; the recovery key for a moment (tmpfs)                                       |
| `/usr/local/libexec/x402/`          | the units' scripts (`deploy/libexec`)                                                               |
| `/etc/systemd/system/x402*`         | the units (`deploy/systemd`)                                                                        |
| `/etc/x402/`                        | the CloudWatch agent's config, the rotation's, the helper's ARNs, the Storage Box's pinned host key |
| `/srv/x402/backup/creds/*.cred`     | the backup jobs' credentials, decrypted by the snapshot script on the host, not for a container     |
| `/run/x402/backup/`                 | the snapshot job's decrypted files (tmpfs), removed when it ends, or by the next run after a kill   |
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
| `x402-portal@production`            | the portal's backend                                      |
| `x402-portal-deploy@production`     | its deploy (a oneshot, started by `deploy-portal.sh`)     |
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
   workflow ignores only `lore/**`, `docs/**`, `**/*.md` and the portal's own app, page and
   workflow (The portal's backend); its `deploy` job then waits for the
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
for p in x402-production x402-portal-production x402-openbao; do  # one each: repeated label filters must all match
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
([ADR 0011](adr/0011-facilitator-hosting.md)). The backup jobs' are in `/srv/x402/backup/creds/`
and go to no container: the snapshot script decrypts its own on the host, into
`/run/x402/backup/`, and removes them when it ends (OpenBao snapshots):

| Credential                  | Read by                        | Decrypted by        |
| --------------------------- | ------------------------------ | ------------------- |
| `database-url.testnet`      | facilitator, `migrate-testnet` | `x402@`, the deploy |
| `rpc-urls.testnet`          | facilitator                    | `x402@`             |
| `approle-role-id.testnet`   | facilitator                    | `x402@`             |
| `approle-secret-id.testnet` | facilitator                    | `x402@`             |
| `postgres-password.testnet` | `postgres-testnet`             | `x402-db-testnet@`  |
| `tunnel-token`              | `cloudflared`                  | `x402-tunnel@`      |
| `portal-*` (three)          | the portal's backend           | `x402-portal@`      |
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
- `/srv/x402/production/.env` with the Transit key's name and version, its address and its
  channels, from OpenBao's steps 4 and 6: public values, so a plain file, owned by `x402`,
  mode 0644, which the playbook leaves alone. They change together, so they live together, and a
  new key needs no pull request (ADR 0015). `compose.yaml` requires all four: without them `x402@`,
  the deploy's `migrate-testnet` and the `docker compose` commands here stop at interpolation.

  ```sh
  printf 'OPENBAO_KEY_TESTNET=%s\nOPENBAO_KEY_VERSION_TESTNET=%s\nFACILITATOR_ADDRESS_TESTNET=%s\nCHANNELS_TESTNET=%s\n' \
    stellar-testnet 1 ADDRESS CHANNELS |
    ssh SERVER 'sudo install -o x402 -g x402 -m 0644 /dev/stdin /srv/x402/production/.env'
  ```

  A server set up before the key's name and version moved here (2026-11-24, task 0048) has only
  the last two lines: add the first two before the playbook run that copies this `compose.yaml`.
  From that copy on, any start of `x402@` stops at interpolation without them, so the playbook
  refuses to copy the compose files while an existing `.env` lacks any of the four names. The
  command adds the lines once, after a newline if the file doesn't end with one:

  ```sh
  ssh SERVER 'sudo sh -euc '\''f=/srv/x402/production/.env
    grep -q "^OPENBAO_KEY_TESTNET=" "$f" && exit 0
    [ -z "$(tail -c1 "$f")" ] || echo >> "$f"
    printf "OPENBAO_KEY_TESTNET=stellar-testnet\nOPENBAO_KEY_VERSION_TESTNET=1\n" >> "$f"'\'''
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
watchdog's kill of a hung process, which fires `watchdog-restart` beside it. A planned stop (a
deploy, a drain, `systemctl stop`) is a success: Compose's 130 after the stop signal is listed in
the unit's `SuccessExitStatus`. The line in
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

A failed run is tried again twice, 20 minutes apart, then the unit stays failed until the next
night's timer. To run it by hand after fixing what failed, clear the limit first, or the start
is refused for up to 3 hours after the night's first try:

```sh
sudo systemctl reset-failed x402-openbao-snapshot.service
sudo systemctl start x402-openbao-snapshot.service
```

The 3 hours count from the first of the three starts, a start by hand included. One that fails
again in the 3 hours before 03:15 uses up the limit for the timer's run as well, and that night
has no snapshot: clear the limit again after the last failed try.

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
   stored=$(ssh SERVER "sudo sh -c 'test -e $cred && echo stored || echo none'") || stored=
   case $stored in
     none) ;;
     stored) echo "a passphrase is already stored: this step is done"; exit 1 ;;
     *) echo "ssh failed: nothing was checked or written"; exit 1 ;;
   esac
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

   The step refuses to run twice: a stored passphrase stops it before anything is written (an SSH
   or sudo failure stops it too, and says "ssh failed", not that one is stored), and a
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

   A first run that fails is tried twice more by itself, and a start by hand counts too: after
   three starts in 3 hours the next one is refused. Fix the cause, then
   `sudo systemctl reset-failed x402-openbao-snapshot.service` before starting it again.

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
never leaves the repository under a passphrase nobody has. The timer and the job are stopped
meanwhile; stopping the service also cancels a retry that is waiting to start, and ends a
snapshot that is running at that moment. The last line's start makes a fresh one.

```sh
(
set -eu
export AWS_PROFILE=soroban-admin AWS_REGION=eu-central-1
id=x402/production/openbao-backup
c=/srv/x402/backup/creds
ssh SERVER 'sudo systemctl stop x402-openbao-snapshot.timer x402-openbao-snapshot.service'
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
ssh SERVER "sudo rm $c/borg-passphrase.old.cred"
# The unit may be at its retry limit from the night's failed tries; "not loaded" means it isn't.
ssh SERVER 'sudo systemctl reset-failed x402-openbao-snapshot.service || :'
ssh SERVER 'sudo systemctl start x402-openbao-snapshot.service x402-openbao-snapshot.timer'
)
```

Then `journalctl -u x402-openbao-snapshot -n 30 --no-pager` shows the run, and the restore drill
follows when it is next due.

**If it stopped partway,** the timer and the service stay stopped, with no retry waiting, and
the alarm fires a day later:

- Before `change-passphrase`: the repository is unchanged. Delete `borg-passphrase.next.cred`
  and start the timer. If the stop ended that night's run or cancelled its retry, start the
  service too, after `reset-failed` (OpenBao snapshots, above).
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

## Account plans

On pubnet each API key holder's account has a plan: payments a calendar month and a fee budget
per 24 h (task 0107). An account without a plan is on `free`, and every free account shares
`free`'s budget. The plans, the limits and what each refusal means are in the
[facilitator README](../apps/facilitator/README.md), "Accounts and plans". A seller who needs
more writes to us; until charging past the quota exists (0108), the operator raises its plan by
hand.

**Granting a plan.**

1. **Check that `global` holds it.** `SPEND_GLOBAL_STROOPS` must be at least `SPEND_FREE_STROOPS`
   plus the fee budget of every account on a raised plan, this one included: then no account,
   attacked or with a leaked key, takes more than its own day's budget from the others, and
   `global` never fills. `keys plans` (below) lists the raised accounts. At the defaults `global`
   (500,000,000) less `free` (250,000,000) leaves 250,000,000: ten `basic` accounts at 25,000,000,
   or two `pro` at 100,000,000 and two `basic`. The facilitator checks only that `free` is at most
   `global`; this sum is yours.
2. **No room: raise `global`, and the float first.** `global` stays at most the float less its
   25 XLM alarm (0024's rule, ADR 0007), so one window can't take the fee account to the alarm: a
   `global` of 60 XLM needs a float of at least 85 XLM. Top up (Topping up the fee account), then
   set `SPEND_GLOBAL_STROOPS` and restart the facilitator, which drains, so plan it like a deploy.
   No compose file passes the variable yet: see "Changing the plans themselves" below.
3. **Set the plan**, with why, in the facilitator's container of the account's network, so the
   command reads that service's database and its own `ACCOUNT_PLANS`, and refuses a plan the
   service doesn't have. Pass your login: `$USER` is unset under `docker exec`, and the row would
   record `operator:unknown` as who set it.

   ```sh
   sudo /usr/local/libexec/x402/x402-compose production exec -T -e USER="$USER" facilitator \
     node dist/keys.js plan discord:412345678901234567 basic asked on Discord
   sudo /usr/local/libexec/x402/x402-compose production exec -T facilitator node dist/keys.js plans
   ```

   It prints the row it wrote: owner, plan, when, by whom and the note. The plan holds from the
   account's next settlement, with nothing restarted, and its month's count is kept. Lowering a
   plan is the same command. Until pubnet has its database and services (0126) the only container
   is testnet's, where no settlement carries a key: a plan set there shows only in the hub's tab,
   which reads testnet's database until then.

**Changing the plans themselves** is `ACCOUNT_PLANS`, in the facilitator's environment and the
portal's, with the same text in both: the facilitator counts by it and the portal shows the hub
the quota from it. Each takes it at its start. Today neither `deploy/production/compose.yaml` nor
`portal.compose.yaml` passes it, nor `SPEND_FREE_STROOPS` or `SPEND_GLOBAL_STROOPS`: each lists
its variables by name, so both services run on the defaults built into their images, which are
the same. Until 0126 a change is a pull request that adds the variable to both files with the
same value, deployed together. 0126 takes the three from the server's `.env` through `${…}`, as
`FACILITATOR_ADDRESS` is today, so both services get one value and a change needs no pull
request. Before removing a plan, move its accounts to another one: a row naming a plan the config
lacks counts as `free`, and each of its settlements logs `account_plan_unknown`. The portal logs
nothing for such a row and shows the hub the `free` quota.

**Which accounts reach a limit.** Each refusal by a budget logs `spend_limit_reached` with the
budget's `scope`, an account's as `account:<owner>`, and `limit`: `count` for its monthly quota,
`stroops` for a fee budget. In Logs Insights on `/x402/production/app`:

```
filter event = "spend_limit_reached"
| stats count() as refusals by scope, `limit`
| sort refusals desc
| limit 50
```

An account refused with `stroops` many times a day is paying more than usual per settlement,
which a buyer's wallet can cause (threat model, "A buyer uses up a seller's quota"). `free` among
the scopes, beside many free accounts each at its own fee budget, looks like the free tier used up
by many accounts (threat model, "Shared budget exhaustion by Sybil self-payments"); the
`budget-nearing` alarm fires for `free` before that.

**The float on pubnet** is not decided yet: ADR 0013's 100 XLM, its alarm at 25 XLM and `global`
at 50 XLM are the starting figures. A typical pubnet settlement is charged 12,203 stroops, so
100 XLM is about 82,000 of them. Under a sustained attack on `free`, which costs up to 25 XLM a
day, the float falls to its alarm in about 3 days; every raised plan's budget that `global` must
hold raises the float with it (step 2).

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

| `/var/log/x402/`                  | Written by                                    | Stream, group                 |
| --------------------------------- | --------------------------------------------- | ----------------------------- |
| `production/facilitator.log`      | `x402@production`, stdout                     | `facilitator` in `app`        |
| `production/facilitator.err.log`  | `x402@production`, stderr                     | `facilitator-stderr` in `app` |
| `production/postgres-testnet.log` | `x402-db-testnet@production`                  | `postgres-testnet` in `app`   |
| `production/cloudflared.log`      | `x402-tunnel@production`                      | `cloudflared` in `app`        |
| `production/deploy.log`           | the deploys, their migrations, `x402-migrate` | `deploy` in `app`             |
| `production/portal.log`           | `x402-portal@production`                      | `portal` in `app`             |
| `production/portal-deploy.log`    | the portal's deploys                          | `portal-deploy` in `app`      |
| `openbao/openbao.log`             | `x402-openbao`                                | `openbao` in `app`            |
| `host/metrics.log`                | the host probe, the watchdog, `x402@`'s stop  | `host` in `metrics`           |
| `metrics/agent.log`               | `x402-metrics`                                | `metrics-agent` in `app`      |

`x402-logrotate.timer` runs every 10 minutes and rotates each file once a day, empty or not, or
sooner once past 100 MB; it keeps 10, `*.log.1` as it was and the older ones compressed, and
deletes any older than 30 days. So no line stays on the server past the 30 days the hub's privacy
policy states, the facilitator's (whose lines name a pubnet caller) and the portal's alike (0106). A rotation during an AWS outage loses the app lines the agent
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

## The portal's backend

The backend of x402's API keys (`apps/portal`, task 0106): it issues, shows and revokes a seller's
pubnet key (0105) for the API hub. The hub (`rumblefishdev/sorobanscan-api-portal`, at
`https://sorobanscan.com/api`) signs members in with Discord and shows them an x402 tab. Its
backend calls this one server to server, at `https://x402-portal.sorobanscan.com/api/hub/v1/`,
with a token on each call that lives 60 seconds and names one account and one act (`read`,
`reveal`, `revoke` or `issue`), signed with a secret both hold. No browser calls it, and it has no
sign-in, session or CORS. The four calls, their answers and the settings are in its
[README](../apps/portal/README.md).

It is `x402-portal@production`, one container in a Compose project of its own,
`x402-portal-production` (`portal.compose.yaml`), on the facilitator's two networks and reached
through its tunnel. It has its own image, deploy key, workflow and digest files, so nothing below
restarts the facilitator, and a facilitator deploy never restarts it.

It writes the facilitator's registry, `api_keys`, and `api_key_copies`, a sealed copy of each key
it issues so that the hub can show the key again. Until pubnet has a database (0126) both are
testnet's, where no request reads a key: the keys it issues today are for testing the hub's tab.

```sh
systemctl status x402-portal@production
sudo /usr/local/libexec/x402/x402-portal-compose production exec -T portal \
  node -e "fetch('http://127.0.0.1:4022/health').then((r) => r.text()).then(console.log)"
curl -s https://x402-portal.sorobanscan.com/health   # {"ready":true}
sudo tail -F /var/log/x402/production/portal.log
```

### Before its first deploy

In this order. Until the first deploy the unit is skipped at boot: it runs only once a deploy has
written `portal.digest`. It decrypts three credentials at each start, `portal-database-url` (step
3), `portal-key-encryption-key` (step 4) and `portal-hub-token-secret` (step 5); without one it
doesn't start.

1. **A facilitator deploy with the migration `0014_api_key_copies`** (Deploy, above). The backend
   runs no migration: on a database without `api_keys` or `api_key_copies` it logs
   `startup_failed`, naming the table, and exits. The table is there when this prints its name:

   ```sh
   cd /srv/x402/production
   sudo FACILITATOR_IMAGE=unused docker compose exec -T postgres-testnet \
     psql -U postgres -d x402 -tAc "SELECT to_regclass('api_key_copies')"   # api_key_copies
   ```

2. **The playbook**, from the commit that has the portal's files (The playbook). It installs the
   compose file, the units, `deploy-portal.sh`, the portal's deploy key and its sudo rule, enables
   `x402-portal@production`, which its condition skips until the first deploy, and restarts the
   CloudWatch agent, whose config gained two files. Nothing else restarts.
3. **The database role.** The backend reads and writes the registry's two tables, and reads two
   things for the usage the hub shows (0107): `account_plans`, every account's plan row with the
   operator's note, and the view `account_usage`, the time of every account's payment the store
   still keeps, with its owner but no amount, fee or address. A leaked `portal-database-url`
   gives those too. Nothing else in the database: it can't read a settlement or the spend tables
   themselves, change a key's owner or hash, or delete a key's row. The two `SET`s keep the
   statements, with the password, out of Postgres's log if one fails. The rest is one
   transaction, and the credential is written only once it has committed: a failed run (a `GRANT`
   before `0014`, say) changes nothing, and the backend's password stays the role's.

   ```sh
   (
     cd /srv/x402/production || exit 1
     pw=$(openssl rand -hex 24) || { echo "stopped: openssl failed; nothing was changed" >&2; exit 1; }
     if sudo FACILITATOR_IMAGE=unused docker compose exec -T postgres-testnet \
       psql -U postgres -d x402 -v ON_ERROR_STOP=1 <<SQL
   SET log_statement = 'none';
   SET log_min_error_statement = 'panic';
   BEGIN;
   SELECT 'CREATE ROLE x402_portal'
     WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'x402_portal') \gexec
   ALTER ROLE x402_portal LOGIN PASSWORD '$pw';
   GRANT SELECT, INSERT ON api_keys TO x402_portal;
   GRANT UPDATE (state, revoked_at) ON api_keys TO x402_portal;
   GRANT SELECT, INSERT, DELETE ON api_key_copies TO x402_portal;
   GRANT SELECT ON account_plans, account_usage TO x402_portal;
   COMMIT;
   SQL
     then
       printf 'postgres://x402_portal:%s@postgres-testnet:5432/x402' "$pw" |
         sudo systemd-creds encrypt --with-key=host --name=portal-database-url - \
           /srv/x402/production/creds/portal-database-url.cred ||
         { echo "stopped: the role's new password is not in the credential; run this step again" >&2; exit 1; }
     else
       echo "stopped: the role was not made or changed; the credential is unchanged" >&2
       exit 1
     fi
   )
   ```

   On success psql prints `SET`, `SET`, `BEGIN`, `CREATE ROLE` (the first time only),
   `ALTER ROLE`, four `GRANT`s and `COMMIT`, and the step nothing more. A failed statement prints
   psql's `ERROR:`, then `stopped: the role was not made or changed; the credential is unchanged`,
   and the subshell exits 1. The subshell keeps `pw` and the `cd` out of your shell. Run again, it
   converges: the role keeps its grants and takes a new password, and the credential follows;
   that is also how the password changes later. Every run sets a new password, so restart
   `x402-portal@production` after it whenever the backend runs: it reads the credential when it
   starts, and its new connections fail until it has read the new one. The last `GRANT` (0107) is
   for the account's use the backend shows the hub: run this step again on the existing role once
   the facilitator has applied `0018_account_plans`, or `account` answers `usage: null` (logged as
   `hub_usage_unavailable`). `deploy/scripts/check-production-portal.sh` makes its role from these
   `GRANT` lines. A migration that replaces one of the four objects (the view `account_usage`
   included, by `DROP VIEW` and `CREATE VIEW`) must grant again: the grants are the object's, not
   the name's. The grants don't keep anyone else from the copies: the facilitator connects as the
   database's owner, so only the encryption does (0106 decision 18).

4. **The key encryption key**, on the server. It seals the copies and is kept nowhere else; a
   second one would leave every copy sealed under the first unable to open (Its other secrets,
   below), so this makes none when the credential exists:

   ```sh
   c=/srv/x402/production/creds/portal-key-encryption-key.cred
   if sudo test -e "$c"; then echo "$c exists: kept"; else
     openssl rand -base64 32 | tr -d '\n' |
       sudo systemd-creds encrypt --with-key=host --name=portal-key-encryption-key - "$c"
   fi
   ```

5. **The hub's token secret**, in AWS Secrets Manager, and its copy on the server (0106 decision
   23). The secret is `sorobanscan-hub/production/x402-token` in `eu-central-1`, in the account of
   the `stellar` profile, as JSON:

   ```json
   { "current": "<base64 of 32 bytes>", "previous": "<base64 of 32 bytes>" }
   ```

   `current` is required and `previous` optional, each exactly what `openssl rand -base64 32`
   prints. The hub's backend reads it through AWS, signs with `current` only, and reads it again
   after 5 minutes. This backend reads a copy, the credential `portal-hub-token-secret`, once,
   when it starts, and accepts a token under `current` or `previous`; it refuses to start without
   one, or with anything else (0106 decision 26). Its container holds no AWS credentials. Whoever
   can read the secret can sign a token for any Discord account, `issue` included.

   It is made once, by akot, with a value no one sees. Every command here, this one included,
   runs in bash on a machine with the `stellar` profile (after `aws sso login --profile stellar`,
   if it is an SSO one), and passes a key over a pipe or in one command's environment, never in
   its arguments, which `ps` shows to every user of the machine. First these, set once per shell.
   They hold no key, and a step run without them stops:

   ```bash
   SECRET_ID=sorobanscan-hub/production/x402-token
   SERVER=   # the server as you reach it with ssh: its address, or your ~/.ssh/config alias
   # true only for {"current": K} or {"current": K, "previous": K}, K being standard padded
   # base64 of 32 bytes: the rule the backend starts by (apps/portal/src/config.ts). The type
   # comes first, so a value of another shape is refused before jq could quote it in an error.
   KEYS_OK='def ok: type == "string" and test("^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$");
     type == "object" and (keys - ["current", "previous"] == []) and (.current | ok)
     and (if has("previous") then .previous | ok else true end)'
   ```

   Then the secret, checked with `KEYS_OK` before it is made, as every later put is:

   ```bash
   (
     set -euo pipefail
     NEW=$(openssl rand -base64 32) || { echo "stopped: openssl failed; nothing was made" >&2; exit 1; }
     JSON=$(NEW="$NEW" jq -nc '{current: env.NEW}' \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) ||
       { echo "stopped: the new secret is not as it must be; nothing was made" >&2; exit 1; }
     printf %s "$JSON" | aws secretsmanager create-secret --profile stellar --region eu-central-1 \
       --name "$SECRET_ID" --secret-string file:///dev/stdin
   )
   ```

   It prints the secret's `ARN`, `Name` and `VersionId`. The copy, and each step of Changing the
   token's secret below, also needs SSH to the server.

   The copy reads the secret as stored, checks it with `KEYS_OK`, and writes it into the server's
   credential through a pipe, never a file or the screen. Then it compares a SHA-256 of what is
   stored with one of the server's copy, each computed on its own side, and prints the copy's
   field names. A stored secret that fails `KEYS_OK` is not written. Nothing here prints a key or
   any part of one; a copy that stops says why, in its own words (`stopped: …`) or in those of the
   tool that failed (`aws`, `ssh`, `systemd-creds`):

   ```bash
   (
     set -euo pipefail
     : "${SERVER:?set SERVER first}"
     JSON=$(aws secretsmanager get-secret-value --profile stellar --region eu-central-1 \
         --secret-id "$SECRET_ID" --query SecretString --output text \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) ||
       { echo "stopped: the stored secret was not read, or not as it must be" >&2; exit 1; }
     printf %s "$JSON" | ssh "$SERVER" 'sudo systemd-creds encrypt --with-key=host --name=portal-hub-token-secret - /srv/x402/production/creds/portal-hub-token-secret.cred' ||
       { echo "stopped: writing the server's copy failed" >&2; exit 1; }
     here=$(printf %s "$JSON" | shasum -a 256 | cut -d' ' -f1)
     there=$(ssh "$SERVER" 'sudo systemd-creds decrypt --name=portal-hub-token-secret /srv/x402/production/creds/portal-hub-token-secret.cred - | sha256sum' | cut -d' ' -f1) ||
       { echo "stopped: the server's copy was not read back" >&2; exit 1; }
     [ "$here" = "$there" ] || { echo "stopped: the server's copy is not the stored secret" >&2; exit 1; }
     printf %s "$JSON" | jq -c keys   # ["current"]: what the server holds, never the values
   )
   ```

   It ends on `["current"]`. Before the first deploy that is all: the deploy starts the backend on
   it.

6. **Cloudflare:** Browser Integrity Check off for `x402-portal.sorobanscan.com` (Cloudflare,
   below). With it on, Cloudflare answers the hub's calls with error 1010 at its edge.
7. **The deploy key and its environment**, apart from the facilitator's, so this key starts the
   portal's deploy and no other. Made on 2026-11-17: the pair with
   `ssh-keygen -t ed25519 -N '' -C x402-deploy-portal-production -f deploy-portal-production`, its
   public half in `deploy/ansible/files/deploy-portal-production.pub`, the private half in the
   `production-portal` environment's secret `DEPLOY_SSH_KEY`, then
   `shred -u deploy-portal-production`. The environment has `production`'s reviewers with
   "Prevent self-review", no admin bypass, deployment branches limited to `deploy/production`,
   and the secret `DEPLOY_HOST`; no `DEPLOY_PORT`, as `production` has none, so the workflow uses
   port 22. Step 2's playbook puts the key in `authorized_keys`, held to `deploy-portal.sh`. A new
   key later is the facilitator's procedure (The deploy key and the host key) with these names.
8. **The hostname,** `x402-portal.sorobanscan.com` to `http://portal:4022` on the tunnel `x402`,
   in `soroban-infrastructure`'s `cloudflare/x402.tf` (#11, applied 2026-11-18). It answers 502
   until the first deploy.
9. **A stub of `deploy-portal-production.yml` on `main`,** as the facilitator's (#126; Rollback,
   above), or **Run workflow** and `gh workflow run` don't find the workflow. `main` has none on
   2026-11-18.

### The first deploy, and the checks after a deploy

The promotion that brings the portal starts **Deploy portal production** beside the facilitator's
deploy (Deploy and rollback, below). Its image job pushes the first image, and its `deploy` job
then waits for the `production-portal` environment's approval. Approve it once steps 1 to 6 are
done, after making the GHCR package `x402-portal` public, so the server pulls without a login. If
this deploy fails there is no good image to go back to: the backend stays down, and
`portal.digest` is removed so the unit stays skipped.

After it, and after every deploy, from anywhere:

```sh
curl -s -w ' %{http_code}\n' https://x402-portal.sorobanscan.com/health
# {"ready":true} 200
curl -s -A '' -w ' %{http_code}\n' https://x402-portal.sorobanscan.com/api/hub/v1/account
# {"code":"invalid_token","message":"The token is missing or not valid."} 401
curl -s -A '' -w ' %{http_code}\n' -H 'Authorization: Bearer v1.probe.probe' \
  https://x402-portal.sorobanscan.com/api/hub/v1/account
# {"code":"invalid_token","message":"The token is missing or not valid."} 401
```

- **The two `401 invalid_token` are the backend's own answers.** It is up, and since it doesn't
  start without a well-formed secret, it holds one. The first is refused before a token is read
  and logged at `debug` only; the second has its token read and refused, and logs one
  `hub_call_refused` with `invalid_token`, which is expected. Neither says the secret is the
  hub's: only a call from the hub's x402 tab shows that.
- **`-A ''` sends no `User-Agent`,** as a server's call may not. Browser Integrity Check answers
  such a request with 1010 (0026), so these probes also show the check is off.
- **A `502`, or an error page with 1010, is not the backend's answer.** It comes from Cloudflare
  or the tunnel, and the backend never saw the request. 1010 is Browser Integrity Check
  (Cloudflare, below). A 502 is the tunnel not reaching `portal:4022`: the backend is down or not
  on the `edge` network, and `systemctl status x402-portal@production` and the end of
  `portal.log` say why.
- **`{"ready":false} 503`** from `/health`: the backend runs and its database didn't answer its
  last probe, at most 2 s old (`not_ready` in `portal.log`, once in 2 s at most).

### Deploy and rollback

A push to `deploy/production` that changes what the image is built from (`apps/portal`,
`packages/api-keys`, the root `package.json`, the lockfile, `pnpm-workspace.yaml`,
`tsconfig.base.json`, `.dockerignore` or the workflow itself, Markdown aside) starts **Deploy
portal production**, which builds the image and waits for the `production-portal` environment's
approval. A push that changes only the portal's app, its page (`apps/portal-web`) or its workflow
starts no facilitator deploy; one that changes `packages/api-keys` starts both. By hand: **Run
workflow** on `deploy/production` (once `main` has its stub, step 9 above), or on the server,
through the same lock:

```sh
DIGEST=   # the image to deploy: sha256: and 64 hex digits
sudo -u x402-deploy env SSH_ORIGINAL_COMMAND="$DIGEST" /srv/x402/production/deploy-portal.sh
sudo tail -F /var/log/x402/production/portal-deploy.log
```

`deploy-portal.sh` refuses anything but a digest. The deploy unit pulls the image, restarts
`x402-portal@production` on it and waits up to 60 s for `/health`, which answers once the
database does. An image that doesn't is replaced by `portal.digest.good`, and the deploy fails.
The restart takes seconds: open requests get 10 s to finish, and a call from the hub in that
moment fails, so its member tries again.

- **With a facilitator deploy in the same promotion:** each waits for its own approval. When the
  promotion carries a migration the backend needs, approve the facilitator's first and the
  portal's once that has ended: the backend runs no migration.
- **Rollback by hand:** an earlier digest, from the portal's own deployments:

  ```sh
  gh api 'repos/rumblefishdev/stellar-x402/deployments?environment=production-portal&per_page=10' \
    --jq '.[] | "\(.id) \(.sha[:7]) \(.created_at)"'
  ID=   # the id of the deployment to go back to, from the list
  gh api "repos/rumblefishdev/stellar-x402/deployments/${ID:?}/statuses" --jq '.[].description' |
    grep sha256
  DIGEST=   # the digest that printed
  gh workflow run deploy-portal-production.yml --ref deploy/production -f digest="${DIGEST:?}"
  ```

  Without the stub on `main`, deploy that digest on the server instead (above). The older image
  runs on the newer schema: every migration is expand/contract (Rollback, above).

- **A change to `portal.compose.yaml` or its units:** the playbook, then
  `sudo systemctl restart x402-portal@production`. The facilitator's units read none of them, but
  they are under `deploy/`, so their promotion starts a facilitator deploy too (The playbook).

### Changing the token's secret

This backend keeps the value it read until it restarts; the hub picks up a new `current` within 5
minutes. So a new key must be in the server's copy, and the backend restarted on it, **before**
the hub can sign with it. Four steps, with the variables of step 5 above set. Each is safe to
stop after, but not part-way through step 2: if step 2 fails or is cut off, run it again before
going on. Steps 2 and 4 restart the backend, and for those few seconds the hub's calls fail and
its tab shows x402 as unavailable; at no other moment is a good token refused.

Each step builds the new JSON from the secret as stored, never from shell variables, so a step
can be run in a new shell, and checks it with `KEYS_OK` before the put. No step prints a key or
any part of one. A step that stops says why, in its own words (`stopped: …`) or in those of the
tool that failed (`aws`, `ssh`, `systemd-creds`), and one that stops before its put changes
nothing in AWS. A step run out of turn stops and says what to run instead: step 1 while a change
is under way (the stored secret has a `previous`), step 2 between steps 3 and 4 (step 4), step 3
before the backend has started on the stored secret (step 2), and step 3 once it has run (step
4). Anywhere else step 2 can be run again; it is how the server catches up with AWS.

1. **Add the new key as `previous`.** The hub keeps signing with the old one. The step stops
   when the stored secret already has a `previous`: a change is under way, and a second new key
   would replace the one step 2 may have given the backend.

   ```bash
   (
     set -euo pipefail
     STORED=$(aws secretsmanager get-secret-value --profile stellar --region eu-central-1 \
         --secret-id "$SECRET_ID" --query SecretString --output text \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) ||
       { echo "stopped: the stored secret was not read, or not as it must be" >&2; exit 1; }
     printf %s "$STORED" | jq -e 'has("previous") | not' > /dev/null || {
       echo "stopped: a change is under way (the stored secret has a previous key); finish it from step 2, or drop it with step 4" >&2
       exit 1
     }
     NEW=$(openssl rand -base64 32) || { echo "stopped: openssl failed; nothing was put" >&2; exit 1; }
     JSON=$(printf %s "$STORED" | NEW="$NEW" jq -ce '{current} + {previous: env.NEW}' 2>/dev/null \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) ||
       { echo "stopped: the new secret is not as it must be; nothing was put" >&2; exit 1; }
     printf %s "$JSON" | aws secretsmanager put-secret-value --profile stellar --region eu-central-1 \
       --secret-id "$SECRET_ID" --secret-string file:///dev/stdin --query VersionId --output text
   )
   ```

2. **Copy it to the server and restart the backend,** so it accepts both keys: the copy of step 5
   above, then the restart. It stops first, changing nothing, between steps 3 and 4, when the
   backend's copy is the stored secret with its two keys exchanged: a copy then would make step 3
   look not yet run, and a second step 3 would swap the keys back.

   ```bash
   (
     set -euo pipefail
     : "${SERVER:?set SERVER first}"
     JSON=$(aws secretsmanager get-secret-value --profile stellar --region eu-central-1 \
         --secret-id "$SECRET_ID" --query SecretString --output text \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) ||
       { echo "stopped: the stored secret was not read, or not as it must be" >&2; exit 1; }
     # After step 3 the copy the backend started on is the stored secret with its keys exchanged,
     # in the bytes step 3 compares; empty with no previous.
     SWAP=$(printf %s "$JSON" | jq -ce '{current: .previous, previous: .current}' 2>/dev/null \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) || SWAP=
     running=$(ssh "$SERVER" 'sudo sha256sum /run/x402/production/portal-hub-token-secret' 2>/dev/null \
       | cut -d' ' -f1) || running=
     [ -z "$SWAP" ] || [ "$(printf %s "$SWAP" | shasum -a 256 | cut -d' ' -f1)" != "$running" ] ||
       { echo "stopped: step 3 has run; go on to step 4, then run this step" >&2; exit 1; }
     printf %s "$JSON" | ssh "$SERVER" 'sudo systemd-creds encrypt --with-key=host --name=portal-hub-token-secret - /srv/x402/production/creds/portal-hub-token-secret.cred' ||
       { echo "stopped: writing the server's copy failed; run this step again" >&2; exit 1; }
     here=$(printf %s "$JSON" | shasum -a 256 | cut -d' ' -f1)
     there=$(ssh "$SERVER" 'sudo systemd-creds decrypt --name=portal-hub-token-secret /srv/x402/production/creds/portal-hub-token-secret.cred - | sha256sum' | cut -d' ' -f1) ||
       { echo "stopped: the server's copy was not read back; run this step again" >&2; exit 1; }
     [ "$here" = "$there" ] ||
       { echo "stopped: the server's copy is not the stored secret; run this step again" >&2; exit 1; }
     printf %s "$JSON" | jq -c keys   # ["current","previous"]: what the server holds
     ssh "$SERVER" 'sudo systemctl restart x402-portal@production' ||
       { echo "stopped: the backend was not restarted; run this step again" >&2; exit 1; }
     # The restart stopped the old process before the new one read the copy, so a 401 now is the
     # new one's. Every 2 s for up to 60 s, as a deploy waits.
     for _ in $(seq 30); do
       code=$(curl -s -o /dev/null -A '' -w '%{http_code}' -H 'Authorization: Bearer v1.probe.probe' \
         https://x402-portal.sorobanscan.com/api/hub/v1/account) || code=000
       if [ "$code" = 401 ]; then echo "restarted on it: the backend answers 401"; exit 0; fi
       sleep 2
     done
     echo "stopped: the backend doesn't answer since its restart ($code); portal.log says why" >&2
     exit 1
   )
   ```

   The subshell prints the copy's field names, never their values, restarts the backend only once
   the server's copy is the stored secret, and then calls it with a made-up token until it answers.
   A `401` says only that a backend is up; that it restarted on the copy is the subshell ending
   without `stopped:`, on `restarted on it: the backend answers 401`. A backend that doesn't come
   back leaves `startup_failed` in `portal.log` with the reason. After any `stopped:`, run the step
   again. A deploy or a reboot between the steps reads the same credential again.

3. **Swap them: the new key becomes `current`.** Within 5 minutes the hub signs with it, and the
   backend accepts it as `previous` since step 2. With no `previous` in the stored secret the step
   stops: there is nothing to swap. Before the swap it compares a SHA-256 of the stored secret
   with one of the copy the running backend started on,
   `/run/x402/production/portal-hub-token-secret`, which `x402-creds` decrypts from the
   credential at each start, so a step 2 cut off before its restart doesn't pass. It puts nothing
   unless the two are the same: the backend would not accept the key the hub is about to sign
   with. When they differ it says which step to run: step 4 when the backend's copy is the stored
   secret with its two keys exchanged, as this step leaves them, and step 2 otherwise. Nothing
   changes on the server.

   ```bash
   (
     set -euo pipefail
     : "${SERVER:?set SERVER first}"
     STORED=$(aws secretsmanager get-secret-value --profile stellar --region eu-central-1 \
         --secret-id "$SECRET_ID" --query SecretString --output text \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) ||
       { echo "stopped: the stored secret was not read, or not as it must be" >&2; exit 1; }
     # The swap, checked as every put is, in the bytes step 2 copies.
     JSON=$(printf %s "$STORED" \
       | jq -ce '{current: .previous, previous: .current}' 2>/dev/null \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) ||
       { echo "stopped: the stored secret has no previous to swap in" >&2; exit 1; }
     here=$(printf %s "$STORED" | shasum -a 256 | cut -d' ' -f1)
     swapped=$(printf %s "$JSON" | shasum -a 256 | cut -d' ' -f1)
     there=$(ssh "$SERVER" 'sudo sha256sum /run/x402/production/portal-hub-token-secret' | cut -d' ' -f1) ||
       { echo "stopped: the backend's copy was not read; is x402-portal@production running?" >&2; exit 1; }
     if [ "$here" != "$there" ]; then
       if [ "$swapped" = "$there" ]; then
         echo "stopped: step 3 has already run; go on to step 4" >&2
       else
         echo "stopped: the server doesn't hold the stored secret; run step 2, then step 3" >&2
       fi
       exit 1
     fi
     printf %s "$JSON" | aws secretsmanager put-secret-value --profile stellar --region eu-central-1 \
       --secret-id "$SECRET_ID" --secret-string file:///dev/stdin --query VersionId --output text
   )
   ```

4. **After at least 10 minutes, drop the old key,** then run step 2's commands again, so the
   backend no longer accepts it; its check then prints `["current"]`. The hub's cache is 5
   minutes, and a read that started just before step 3 can land after it, so 5 leaves no margin.
   While the hub still signs with the old key, dropping it here refuses every hub call. Run before
   step 3, it drops the new key instead, which abandons the change; run step 2's commands after it
   all the same.

   ```bash
   (
     set -euo pipefail
     JSON=$(aws secretsmanager get-secret-value --profile stellar --region eu-central-1 \
         --secret-id "$SECRET_ID" --query SecretString --output text \
       | jq -ce '{current}' 2>/dev/null \
       | jq -ce "if ($KEYS_OK) then . else error(\"refused\") end" 2>/dev/null) ||
       { echo "stopped: the stored secret was not read, or not as it must be" >&2; exit 1; }
     printf %s "$JSON" | aws secretsmanager put-secret-value --profile stellar --region eu-central-1 \
       --secret-id "$SECRET_ID" --secret-string file:///dev/stdin --query VersionId --output text
   )
   ```

`put-secret-value` replaces the whole JSON, and each put prints the new version's id. Never
`echo` a key. If a step goes wrong, this backend refuses the hub's tokens. The hub's x402 tab
shows each refusal as a `502` (the hub turns a `401` or `403` from a product into one), and
`portal.log` has a `hub_call_refused` with `invalid_token` for each call. The hub's calls come
from a few addresses, and a token that doesn't verify counts against its address: past 30 such
calls in a minute from one, the backend answers `429 rate_limited` instead, with one
`hub_strangers_limited` a window and no `hub_call_refused` (`apps/portal/src/app.ts`), and the
tab says "Too many requests for your account". So a burst of 429s on the tab, with
`hub_call_refused` lines just before them, right after a change of the secret is the same fault.
Put back the previous version, then run step 2's commands so the server holds it too:

```bash
aws secretsmanager list-secret-version-ids --profile stellar --region eu-central-1 \
    --secret-id "$SECRET_ID" \
    --query 'Versions[].[VersionId, join(`,`, VersionStages), CreatedDate]' \
    --output text
PREV_ID=   # the version on the line with AWSPREVIOUS, the good one
BAD_ID=    # the version on the line with AWSCURRENT, the bad one
aws secretsmanager update-secret-version-stage --profile stellar --region eu-central-1 \
    --secret-id "$SECRET_ID" --version-stage AWSCURRENT \
    --move-to-version-id "${PREV_ID:?}" --remove-from-version-id "${BAD_ID:?}"
```

**Skipping steps 1 and 2** (writing `{current: NEW, previous: OLD}` and copying it afterwards)
leaves a window, from the hub's next read to the restart, in which the backend refuses every hub
call.

### Its other secrets

- **The key encryption key** opens the sealed copies in `api_key_copies`, which let the hub show
  an account its key again. It has no backup and no rotation yet. Lost or replaced, every key
  still works, but none can be shown: `account` answers `showable: false`, so the tab offers no
  Show, `reveal` answers `409 key_not_viewable`, and the backend logs `hub_key_copy_unreadable`.
  A seller who has lost the key revokes it and waits for the next calendar month (UTC) for a new
  one (0106 decision 24). With a database dump it gives every active key the portal issued; a
  dump alone gives none. If both leaked, stop the backend, revoke every key the portal issued and
  delete the copies, as `postgres`; each of those accounts then waits for the next calendar month
  for a new key:

  ```sh
  sudo systemctl stop x402-portal@production
  cd /srv/x402/production
  sudo FACILITATOR_IMAGE=unused docker compose exec -T postgres-testnet \
    psql -U postgres -d x402 -v ON_ERROR_STOP=1 <<'SQL'
  BEGIN;
  UPDATE api_keys SET state = 'revoked', revoked_at = (extract(epoch FROM now()) * 1000)::bigint
    WHERE owner LIKE 'discord:%' AND state = 'active';
  DELETE FROM api_key_copies;
  COMMIT;
  SQL
  ```

  Then replace the key, a new credential over the old one, and start the backend again:

  ```sh
  openssl rand -base64 32 | tr -d '\n' |
    sudo systemd-creds encrypt --with-key=host --name=portal-key-encryption-key - \
      /srv/x402/production/creds/portal-key-encryption-key.cred
  sudo systemctl start x402-portal@production
  ```

- **The database password:** with the role (step 3 above).

### Logs

One JSON object per line in `/var/log/x402/production/portal.log`, shipped as `portal` in
`/x402/production/app`. A call is named by its token's `jti` and `act`, a key by its `key_id`,
the first 12 hex digits of its SHA-256; never a key, a token, a secret or a Discord id. No alarm
reads them yet: what watches the backend is the uptime probe on its `/health` (Monitoring, below).

| Event                                                           | Level | Means, and what to do                                                                                                                                                                          |
| --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startup_failed`                                                | error | the process exits: `problems` names each bad setting, never its value, or `error` says the database is out of reach or lacks a table. **Act**                                                  |
| `hub_call_failed`, `pool_error`, `not_ready`                    | error | the database failed (`502 key_unavailable`, or `issue`'s `outcome: failed`), or something else in a call (`500 internal`). **Act** on a run of them                                            |
| `hub_usage_unavailable`                                         | error | the plan or the count couldn't be read, and `account` answers `usage: null` (the key is still answered): the role lacks the 0107 grant (**run the role's step again**), or the database failed |
| `hub_key_copy_unreadable`                                       | error | a copy exists and doesn't open: the wrong `KEY_ENCRYPTION_KEY`, or a damaged row. **Act**                                                                                                      |
| `shutdown_failed`                                               | error | a stop didn't end cleanly, and the process exited 1                                                                                                                                            |
| `hub_call_refused` with `invalid_token`                         | warn  | **expected from strangers**. Only a run of them while the hub's x402 tab fails means the two sides disagree: the secret changed on one side only, or the two clocks more than 5 s apart        |
| `hub_call_refused` with `action_not_allowed`                    | warn  | the hub doesn't send one: a hub bug, or a captured token replayed. Look                                                                                                                        |
| `hub_strangers_limited`                                         | warn  | one address (an IPv6 /56) is over 30 calls a minute with tokens that don't verify; once per window. Right after a change of the secret, the hub's own calls (Changing the token's secret)      |
| `hub_key_issued`, `hub_key_revealed`, `hub_key_revoked`         | info  | the key events, with `jti`, `act` and `key_id`                                                                                                                                                 |
| `hub_issue_refused`, `hub_reveal_refused`, `hub_revoke_refused` | info  | what a call came to, its `outcome` (`has_key`, `capped`, `too_young`, `no_key`, …): the account's state, not a fault                                                                           |
| `hub_account_answered`                                          | info  | the `state` `account` gave                                                                                                                                                                     |
| `listening`                                                     | info  | started, with its port                                                                                                                                                                         |

A call with no bearer at all is logged at `debug` only, which the backend doesn't write (its
`LOG_LEVEL` is `info`). `startup_failed` repeats: the unit restarts the process after 5 s, up to 5
starts in 300 s, then stays `failed`. Everything but the strangers' refusals:

```sh
sudo grep -E '"level":"(error|warn)"' /var/log/x402/production/portal.log |
  grep -v '"reason":"invalid_token"' | tail -n 20
```

### Cloudflare

The hub's backend calls `https://x402-portal.sorobanscan.com` through Cloudflare, and so does a
developer's local hub tried on production's backend. HTTPS ends at Cloudflare (ADR 0011), so it
sees each answer, `reveal`'s key included. Rules on this hostname must let those calls through:

- **Browser Integrity Check off** for the hostname, as for the facilitator's: it answers a
  request whose headers don't look like a browser's with error 1010, and only a server calls this
  one (0106 decision 32). A rule beside `x402_facilitator_no_bic` in `soroban-infrastructure`'s
  `cloudflare/x402.tf`, by pull request there, not by hand, so Terraform's state keeps agreeing.
  That file's comment says the portal's clients are browsers: no longer so. Not applied on
  2026-11-18.
- **No challenge, and Bot Fight Mode off** (it is off on the zone, 0026): the hub's backend can't
  answer one, and a challenge page isn't the contract's JSON.
- **No rate limit by address that counts the hub as one caller.** Every member's call comes from
  the hub's few addresses. The backend limits 60 calls a minute by account, and 30 by address for
  calls whose token doesn't verify, reading the address from `CF-Connecting-IP`
  (`CLIENT_IP=cloudflare`) and counting an IPv6 one by its /56: the container publishes no port,
  so only the tunnel reaches it. A rate rule on this hostname must exempt `/api/hub/*` or sit
  above the hub's peak.
- **The `Authorization` header reaches the backend unchanged:** it carries the token.

### A key, end to end

A member presses "Get API Key" in the hub's x402 tab:

1. The hub sends the browser through Discord again and checks the account: a member of Stellar
   Developers who has cleared Membership Screening, and old enough. Then its backend signs a token
   for `issue`, `sub` `discord:<id>`, `aud` `x402`, and calls
   `POST https://x402-portal.sorobanscan.com/api/hub/v1/key/issue`.
2. This backend checks the token's MAC under `current` or `previous` and its claims and time, its
   `act` against the route, and the account's limit. Then the account's age, from its Discord id
   (`MIN_ACCOUNT_AGE_MINUTES`, 5), and its keys: an active one is `has_key`, a revoke this month
   `capped`. Otherwise it makes a key, its SHA-256 and the sealed copy, writes both in one
   transaction, logs `hub_key_issued` with the `jti` and `key_id`, and answers
   `{"outcome":"issued"}`.
3. The hub logs the same `jti` with `discord:<id>`, and the browser lands on
   `/api/dashboard/x402?issue=issued`.

Show is a call with a `reveal` token: the copy is opened and the key answered (`hub_key_revealed`).
Regenerate is one with a `revoke` token: the key is marked revoked and its copy deleted in one
transaction (`hub_key_revoked`), and on pubnet the facilitator refuses it from its next request
(0105); no new key until the next calendar month (UTC). The `jti` ties one call across both logs:
the hub's names the account, this one the key. The account of a `key_id`:

```sh
KEY_ID=   # the 12 hex digits from the log line
cd /srv/x402/production
sudo FACILITATOR_IMAGE=unused docker compose exec -T postgres-testnet psql -U postgres -d x402 \
  -c "SELECT owner, state, revoked_at FROM api_keys WHERE key_hash LIKE '${KEY_ID:?}%'"
```

Trying it touches real keys: a revoke holds back a new key until the next calendar month, so try
revoke last, or with a second Discord account.

### Monitoring

An uptime probe in AWS, `x402-production-portal-uptime-probe`, reads
`https://x402-portal.sorobanscan.com/health` through Cloudflare every minute and publishes
`portal_ready` (1 for a 200 with `{"ready":true}`) to `x402-watch`; its alarm is `portal-uptime`
(7 minutes in a row, a missing point counted as down), in the group `portalUptime`. A second probe,
`x402-production-hub-uptime-probe`, reads the hub's `https://sorobanscan.com/api/hub/me` through
the explorer's CloudFront, the whole path a member's browser takes, and publishes `hub_ready` (1
for a 200 with `{"authenticated":false}`); its alarm is `hub-uptime`, in `hubUptime`. Both come
with the Uptime stack (`infra/`, 0106 decision 21); what each alarm means and what to do is in
[monitoring, Uptime](monitoring.md#uptime).

Both groups are off when the probes are first deployed, since an alarm made before its probe has
data pages at once:

- **`portalUptime`**, once the portal's probe has published for a few minutes: from `infra/`,
  `make deploy-production-uptime`, then `make check-series GROUP=portalUptime` until it passes,
  then `"portalUptime": true` in `infra/envs/production.json`, `make deploy-production-alarms` and
  `make fire-test` (infra/README.md, Alarm groups).
- **`hubUptime`**, once the hub's backend is routed in the explorer's distribution (the hub's
  runbook, step 4) and the probe reads 1: until then the distribution answers `/api/hub/me` with
  a `302` to `/api/`, which the probe reads as down. The same steps, with `GROUP=hubUptime`; first
  check the probe's last lines say `"ready":1` (`/aws/lambda/x402-production-hub-uptime-probe`).

The hub's own alarms, on its Lambda's `Throttles` and `Url5xxCount`, are being added in its repo
(`rumblefishdev/sorobanscan-api-portal`), publishing to this repo's `x402-production-alarms` topic,
so they reach `#stellar-x402-bot` beside these. Later, not built: a watchdog for this backend,
metric filters with alarms on its log lines (`startup_failed`, `hub_call_failed`,
`hub_key_copy_unreadable`), and an alarm on the hub's Lambda nearing its concurrency
(`ConcurrentExecutions`), which `Throttles` sees only once it is reached.

### What this backend lacks

- A watchdog: Docker marks a hung backend `unhealthy` and nothing restarts it; the probe above
  sees it, and a person restarts it. Its logs ship (`portal` in `app`), and no metric filter or
  alarm reads them yet.
- The page's own publish, `aws s3 sync` to the explorer's bucket, and the page's Basic Auth
  (0106 decisions 1 and 6): both are the explorer's distribution's.
- A gate on the backend's hostname: there is none, on purpose. Every route but `/health` needs
  the hub's token (0106 decisions 22 and 33).

## The metrics agent

`x402-metrics.service` runs `/srv/x402/metrics`: Prometheus in agent mode and node_exporter (ADR
0011, "Metrics"). The agent scrapes node_exporter and itself every 15 s and sends the samples to
the monitoring VM, `https://metrics.sorobanscan.com/api/v1/write`, with a client certificate from
the ClickHouse project's CA. Its write-ahead log, the volume `x402-metrics-wal`, holds the samples
while the VM can't be reached. node_exporter's textfile collector reads the host probe's files in
`/var/lib/x402/textfile`: `host-probe.prom`, the gauges of its last run, replaced whole each
minute, so its age is the probe's; and one file per counter (`watchdog_restarts_total.prom`,
`facilitator_failures_total.prom`), the total since the file was made, written when the event
happens and rewritten by every run, so every file's age is the probe's. The agent scrapes the
facilitator too, at `facilitator:9464` on the `x402-metrics` network the facilitator joins:
`METRICS_PORT` in `deploy/production/compose.yaml` sets the port, and unset, the facilitator
serves no `/metrics` (0139). ClickHouse's own endpoint is on, but listens on
127.0.0.1 inside `app-clickhouse-1` (the explorer's
`crates/db-clickhouse/config.d/prometheus.xml`), so the agent can't reach it yet: only
`docker exec` or a scraper in that container's network namespace can. The VM lets only the CNs in
`metrics_writer_cns` write (soroban-infrastructure, `monitoring/`).

**The certificate,** as the CloudWatch agent's: the key was made on the server on 2026-11-18 as
`/srv/x402/metrics/creds/metrics-agent-key.2026-11-18.cred` (`metrics-agent-key.cred` links to
it), with `--name=metrics-agent-key`, and its CSR (`CN=x402-metrics-agent-production`,
`CA:FALSE`, `digitalSignature`, `clientAuth`) was signed by the CA for 365 days. The certificate
is `deploy/ansible/files/metrics-agent-production.crt`; the playbook checks it and that it is the
key's before it copies it. Issued by `soroban-internal-ca-2026`, serial
`03869E42EE8A16EB9F0060AABC2C0811`, valid until 2027-11-18 14:24:12 UTC. Renewal follows the
CloudWatch agent's, with these names, except its last step: the playbook restarts the agent when
it copies the new certificate, so there is no `systemctl start` to run.

**The admin step,** as `deploy` with sudo, after the playbook run from that merge:

```sh
sudo systemctl start x402-metrics
tail -n 20 /var/log/x402/metrics/agent.log   # no "remote_write" errors
cd /srv/x402/metrics && sudo docker compose exec -T agent \
  wget -qO- localhost:9090/metrics | grep prometheus_remote_storage_samples_total
```

On the VM, in Prometheus (`ssh -L 9090:localhost:9090 monitoring`), each of these answers for
`ch-prod-01`: `up{job="node"} == 1`, `up{job="facilitator"} == 1`,
`node_textfile_scrape_error == 0`, and `time() - node_textfile_mtime_seconds < 120` for all three
of the probe's files.

**The facilitator needs the agent's network.** `x402-metrics` is the agent's project's network,
external to production's, so the facilitator can't start where the agent's project never ran, or
after a `docker compose down` of it (`systemctl stop` is `compose stop`, which keeps the network).
`x402@production` then fails at once with `network x402-metrics declared as external, but could
not be found` in `/var/log/x402/production/facilitator.err.log`, five times, and stays `failed`
(`StartLimitBurst`): starting the agent later doesn't bring it back. The fix:

```sh
sudo systemctl start x402-metrics
sudo docker network inspect x402-metrics --format '{{.Name}}'   # x402-metrics
sudo systemctl reset-failed x402@production && sudo systemctl start x402@production
```

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
