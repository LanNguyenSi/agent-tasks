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

## Backing up

### 1. Database dump

`pg_dump` runs inside the `db` container and connects over the local
socket, so it needs no password. The role and database names are fixed in
the compose file (`agent_tasks` for both):

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U agent_tasks -d agent_tasks > db-YYYY-MM-DD.sql
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
read-only at `/data`, the deployment directory mounted at `/backup`:

```bash
docker run --rm -v "$UPLOADS_VOL":/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/uploads-YYYY-MM-DD.tgz -C /data .
```

### 3. Copy both off the host

A backup that only exists on the production host is not a backup. Copy
both artifacts and verify the copies arrived:

```bash
scp db-YYYY-MM-DD.sql uploads-YYYY-MM-DD.tgz \
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
  < db-YYYY-MM-DD.sql
```

If the deployment uses the optional separate runtime role
(`POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD`, see the backend
`DATABASE_URL` in `docker-compose.prod.yml` and the "Runtime database
role" section of `docs/grounding-migration.md`), re-apply its grants on
the restored database before starting the backend.

### 3. Restore the uploads volume

Extract the archive into the same volume (resolve `UPLOADS_VOL` as in the
backup section). Restore the two artifacts as a pair from the same point
in time; if the volume already holds files from a newer state, back it up
or clear it first so stale orphans do not pile up:

```bash
docker run --rm -v "$UPLOADS_VOL":/data -v "$PWD":/backup:ro alpine \
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

4. Back up the database as in [Backing up, step 1](#1-database-dump), to a
   file outside the deploy checkout (an untracked file there makes relay's
   `git_clean` preflight block the next deploy) that only you can read, and
   check it is non-empty (`test -s <dump>`) before continuing.
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
checkout to the previous commit and rebuild before starting the backend again:
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

## Related

- `docs/attachments.md`: storage location and limits of the uploads
  volume.
- `docs/grounding-migration.md`: capture a database backup before an
  authorized migration and exercise the restore in isolation.
