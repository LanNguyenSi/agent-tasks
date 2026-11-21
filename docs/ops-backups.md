# Backups and restore (production)

Production state lives in exactly two places, and both need to be backed
up:

- **The database**: everything Prisma stores (users, teams, agents and
  tokens, tasks, comments, signals, audits, attachment metadata), in the
  PostgreSQL 16 container of the `db` service (`docker-compose.prod.yml`).
- **The uploads volume**: the bytes of human-uploaded attachments, on the
  `agent_tasks_uploads` named volume mounted at `/app/uploads` in the
  backend container. The database stores only metadata and a `/uploads/...`
  reference per file (`docs/attachments.md`), so a backup is only
  consistent when the dump and the volume are taken close together.

**This repo ships no backup automation.** There is no backup script and no
scheduled job in the tree; running the commands below (or wiring them into
a host cron or systemd timer, or pointing an external VPS snapshot service
at both volumes) is the operator's responsibility.

All commands below run from the deployment directory on the production
host, where `docker-compose.prod.yml` and its `.env` live.

## Schedule

The repo ships no schedule for those commands either; this section is the
recommendation, not automation. Run [Backing up](#backing-up) once a day,
taking both artifacts (database dump and uploads archive) as a pair, and
additionally before every destructive schema change (that procedure, see
[Applying a destructive schema change](#applying-a-destructive-schema-change),
already requires a fresh dump as a prerequisite).

A daily cadence fixes the recovery point objective: a restore returns the
site to the last dump, so with a daily schedule **up to 24 hours of data
can be lost** (everything written since the previous dump). If that is too
much, schedule the pair more often than daily.

No backup script ships in this repo, so the example below calls a wrapper
the operator writes themselves (explicitly an example, not a repo file):
its body is just the commands of the three steps under
[Backing up](#backing-up), run from the deployment directory, with the
artifacts named `db-$(date +%F).sql` and `uploads-$(date +%F).tgz`. Host
crontab of root on the deploy host, daily at 03:15:

```cron
15 3 * * * /usr/local/bin/agent-tasks-backup >> /var/log/agent-tasks-backup.log 2>&1
```

Retention: keep a rolling window of daily pairs on the host (delete the
`db-*.sql` and `uploads-*.tgz` files older than that window, for example
14 days), and keep the off-host copies of step 3 at least as long; the
off-host copy is the one that survives the loss of the host.

One-line check of the newest dump's age, from a shell where `BACKUP_DIR`
is set; empty output means there is no non-empty dump from the last day,
and an error from `find` (for example an unset or wrong `BACKUP_DIR`) means
the check itself did not run:

```bash
find "$BACKUP_DIR" -name 'db-*.sql' -size +0 -mtime -1 -print
```

## Backing up

### 0. Choose the backup directory

Back up into a private directory outside the deploy checkout, never into
the checkout itself: an untracked file there makes relay's `git_clean`
preflight block the next deploy (see "Applying a destructive schema
change"). Pick any directory only you can read and set it in the shell
that runs the commands below (and the restore commands later); the restore
section reads the artifacts from the same paths:

```bash
BACKUP_DIR=/root/agent-tasks-backups   # example: an existing private dir outside the checkout
install -d -m 700 "$BACKUP_DIR"
```

### 1. Database dump

`pg_dump` runs inside the `db` container and connects over the local
socket, so it needs no password. The role and database names are fixed in
the compose file (`agent_tasks` for both):

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U agent_tasks -d agent_tasks > "$BACKUP_DIR"/db-YYYY-MM-DD.sql
```

`-T` keeps the output stream clean for the redirect.

### 2. Uploads volume

The compose file declares the volume without a `name:` key, so Docker
Compose prefixes it with the project name: on the host it is
`<project>_agent_tasks_uploads`. A host can hold more than one volume with
that suffix (for example after the project name changed), so take the one
the backend container actually mounts at `/app/uploads` (`-a` also finds a
stopped container) and stop if there is none:

```bash
BACKEND=$(docker compose -f docker-compose.prod.yml ps -aq backend)
UPLOADS_VOL=$(docker inspect --format \
  '{{range .Mounts}}{{if eq .Destination "/app/uploads"}}{{.Name}}{{end}}{{end}}' \
  "$BACKEND")
[ -n "$UPLOADS_VOL" ] || { echo "no uploads volume found" >&2; exit 1; }
echo "$UPLOADS_VOL"
```

Then tar the volume out with a throwaway container: the volume mounted
read-only at `/data`, `$BACKUP_DIR` mounted at `/backup`:

```bash
docker run --rm -v "$UPLOADS_VOL":/data:ro -v "$BACKUP_DIR":/backup alpine \
  tar czf /backup/uploads-YYYY-MM-DD.tgz -C /data .
```

### 3. Copy both off the host

A backup that only exists on the production host is not a backup. Copy
both artifacts and verify the copies arrived:

```bash
scp "$BACKUP_DIR"/db-YYYY-MM-DD.sql "$BACKUP_DIR"/uploads-YYYY-MM-DD.tgz \
  ops@<backup-host>:/backups/
ssh ops@<backup-host> 'ls -l /backups'
```

## Restoring

Restore order: **database first, then uploads**. Keep the backend stopped
for the whole procedure so no request writes to a half-restored database
or reads an attachment whose bytes are not on the volume yet. The `db`
service must be running; if it is not, start it alone with
`docker compose -f docker-compose.prod.yml up -d db` and wait until
`docker compose -f docker-compose.prod.yml ps` reports it healthy.

### 1. Stop the backend

```bash
docker compose -f docker-compose.prod.yml stop backend
```

### 2. Restore the database

The dump holds plain SQL with `CREATE TABLE` statements, so restore it
into an empty database. Recreating the database drops every object in it
first (the dump then rebuilds the schema):

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  dropdb -U agent_tasks --if-exists agent_tasks
docker compose -f docker-compose.prod.yml exec -T db \
  createdb -U agent_tasks -O agent_tasks agent_tasks
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U agent_tasks -d agent_tasks -v ON_ERROR_STOP=1 -q \
  < "$BACKUP_DIR"/db-YYYY-MM-DD.sql
```

If the deployment uses the optional separate runtime role
(`POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD`, see the backend
`DATABASE_URL` in `docker-compose.prod.yml` and the "Runtime database
role" section of `docs/grounding-migration.md`), re-apply its grants on
the restored database before starting the backend.

### 3. Restore the uploads volume

Extract the archive into the same volume (resolve `UPLOADS_VOL` as in the
backup section, and set `BACKUP_DIR` as there, since the artifacts are
read from it). Restore the two artifacts as a pair from the same point
in time; if the volume already holds files from a newer state, back it up
or clear it first so stale orphans do not pile up:

```bash
docker run --rm -v "$UPLOADS_VOL":/data -v "$BACKUP_DIR":/backup:ro alpine \
  sh -c 'tar xzf /backup/uploads-YYYY-MM-DD.tgz -C /data'
```

### 4. Start the backend

```bash
docker compose -f docker-compose.prod.yml up -d backend
```

Starting the backend also re-runs the one-shot `migrate` service, which
applies `prisma db push` (without `--accept-data-loss`) to the database
(`Dockerfile.migrate`); restoring a dump taken from the app version being
deployed keeps that schema sync a no-op.

Then smoke-check: load the board, open a task that has an attachment, and
confirm the image renders (that exercises the restored database and the
restored volume together).

## Applying a destructive schema change

The `migrate` service never passes `--accept-data-loss`. When Prisma prints a
data-loss warning for a schema change, `prisma db push` exits non-zero,
`migrate` fails, and `backend` does not start. The database keeps its old
schema and data. The warning is not limited to changes that lose rows: adding
any UNIQUE constraint triggers it whether or not the column holds duplicates.
Other triggers are dropping a populated column or table and type changes
Prisma cannot apply losslessly.

What a failed `migrate` does to a running stack (`backend` depends on
`migrate` with `service_completed_successfully`):

- `docker compose up -d` exits 1. A service whose config and image are
  unchanged keeps running, but a deploy that ships a destructive schema change
  does not leave the backend unchanged: `backend/Dockerfile` copies
  `backend/prisma` and runs `prisma generate`, so the backend image changes
  and the backend is always recreated. The frontend (`frontend/Dockerfile`
  runs `COPY . .` and does not pin the build id) is usually recreated too.
- A recreated service is replaced by a new container left in `Created` state,
  never started. So the whole site, UI and API, is down until the deploy is
  resolved.
- agent-relay then rolls back automatically (`rollbackIfEnabled` in
  `src/deploy/engine.ts`: `git reset --hard` to the commit before the deploy,
  the critical preflights, `docker compose build`, `docker compose up -d`; it
  runs no health check afterwards). The rolled-back stack runs the old
  schema's push, which succeeds against the untouched data. If the rollback is
  blocked (for example by a preflight), the site stays down until someone
  fixes that.

To apply a destructive change on purpose, on the host:

1. Fast-forward the deploy branch to the new commit
   (`git pull origin <branch>`).
2. Build the new images:

   ```bash
   docker compose -f docker-compose.prod.yml build migrate backend
   ```

3. Stop the backend (required, so it does not serve requests against the
   changed schema):

   ```bash
   docker compose -f docker-compose.prod.yml stop backend
   ```

4. Back up the database as in [Backing up, step 1](#1-database-dump). The
   dump lands in `$BACKUP_DIR` (set it as in that section), outside the deploy checkout (an untracked
   file there makes relay's `git_clean` preflight block the next deploy)
   and readable only by you; check it is non-empty (`test -s <dump>`)
   before continuing.
5. Run the push once, with the flag, from a one-off container of the new
   `migrate` image (the command override replaces the image's `CMD`):

   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps migrate sh -c \
     'npx prisma db push --schema=/app/backend/prisma/schema.prisma --skip-generate --accept-data-loss'
   ```
6. Redeploy as usual. The regular `migrate` push now finds nothing to change,
   and the two SQL steps (`grounding-github-fence.sql`,
   `clear-terminal-claims.sql`) run after it.

To abort before step 5 (for example when the dump is empty), reset the deploy
checkout to the previous commit and rebuild before starting the backend again
(from the base-image pinning onward, the rebuild uses the base images pinned by digest in that commit):
the images built in step 2 already carry the new schema, so starting the
backend on them runs the failing `migrate` again. The destructive commit is
still on the upstream deploy branch. Before relay deploys again, revert it
upstream or complete steps 1-6; until then, trigger no relay deploy.
Otherwise the next relay deploy pulls it, `migrate` fails, and the site is
down until the automatic rollback completes.

After step 5, rolling back the images no longer brings the data back. To
recover, reset the deploy checkout to the previous commit, rebuild, restore
the dump with the backend stopped (as in [Restoring](#restoring)), then start
the backend. As when aborting, the destructive commit is still upstream:
before relay deploys again, revert it upstream, and trigger no relay deploy
until then.

Do not add the flag to `Dockerfile.migrate`, `docker-compose.prod.yml` or
`.relay.yml`.

## Disk hygiene

A production deploy runs through agent-relay (runbook:
`docs/okf/deploy.md`), whose pre-update hook is `docker compose -f
docker-compose.prod.yml build --pull` (`.relay.yml`), so every deploy
builds new images and the superseded ones stay on disk. `.relay.yml`
deliberately has no `post_update` hook: a prune wired in there could
delete the image a rollback still needs while the deploy is not yet known
good, so pruning stays a manual step, done after a deploy you have
verified healthy, on a host `.relay.yml` sizes at 7.7 GB shared with ~25
containers:

```bash
docker image prune -f
df -h
docker system df
```

`docker image prune -f` removes dangling images only. The app services in
`docker-compose.prod.yml` are built, not pulled (`build:` keys, no tagged
`image:`), so each deploy retags the image name and the previous release's
image becomes dangling: `-f` removes it too. That is safe, because a
rollback does not start a kept image, it rebuilds the previous commit (see
[Applying a destructive schema change](#applying-a-destructive-schema-change))
and reuses the builder cache. Do not use `docker image prune -a` or a
`docker system prune -a`: they also remove unused tagged base images and
build layers that rebuild would reuse, which turns the next rollback into a
cold full rebuild on this small host. Check disk
usage after every deploy (`df -h` for the filesystem, `docker system df`
for what Docker holds) and treat about 80 % full as the act-now watermark,
before the next deploy rather than after a failed one: first delete
backups in `$BACKUP_DIR` whose off-host copies
[Copy both off the host](#3-copy-both-off-the-host) has verified, then
prune again;
if space is still tight, remove stopped containers and unused volumes you
have confirmed you do not need.

## Related

- `docs/self-hosting.md`: rotating the database password on a live
  volume, the external Traefik prerequisite, uptime monitoring for
  unhealthy containers.
- `docs/attachments.md`: storage location and limits of the uploads
  volume.
- `docs/grounding-migration.md`: capture a database backup before an
  authorized migration and exercise the restore in isolation.
