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

The `migrate` service never passes `--accept-data-loss`. When a schema change
makes Prisma warn about data loss (dropping a column or table that still holds
values, a type change it applies as drop and add, a UNIQUE constraint over
duplicate values), `prisma db push` exits non-zero, `migrate` fails, and
`backend` does not start. The database keeps its old schema and data.

What a failed `migrate` does to a running stack, measured with a scratch
compose project (a `db`, the real `Dockerfile.migrate` image, and a stand-in
`backend` that depends on `migrate` with `service_completed_successfully`):

- `docker compose up -d` exits 1. When the backend's own config is unchanged,
  the running backend keeps running untouched.
- When the backend is recreated (a new image, or `--force-recreate`, which is
  the normal case for a deploy that ships new code), compose replaces the old
  container and leaves the new one in `Created` state, never started. The
  backend is then down until the schema change is resolved or the deploy is
  rolled back. A rollback (previous commit, rebuilt old image) runs the old
  schema's push, which succeeds against the untouched data.

To apply a destructive change on purpose, on the host:

1. Check out the new commit and build the images:
   `docker compose -f docker-compose.prod.yml build migrate backend`.
2. Back up the database to a file outside the checkout (agent-relay refuses a
   tree with untracked files) that only you can read, as in
   [Backing up, step 1](#1-database-dump), and continue only when the dump is
   non-empty.
3. Optional: stop the backend (`docker compose -f docker-compose.prod.yml stop
   backend`) so it does not serve requests against the changed schema.
4. Run the push once, with the flag, from a one-off container of the new
   `migrate` image (the command override replaces the image's `CMD`):
   `docker compose -f docker-compose.prod.yml run --rm --no-deps migrate sh -c
   'npx prisma db push --schema=/app/backend/prisma/schema.prisma
   --skip-generate --accept-data-loss'`. The same override was run against the
   scratch project and applied the drop.
5. Redeploy as usual. The regular `migrate` push now finds nothing to change,
   and the two SQL steps (`grounding-github-fence.sql`,
   `clear-terminal-claims.sql`) run after it.

Do not add the flag to `Dockerfile.migrate`, `docker-compose.prod.yml` or
`.relay.yml`.

## Related

- `docs/attachments.md`: storage location and limits of the uploads
  volume.
- `docs/grounding-migration.md`: capture a database backup before an
  authorized migration and exercise the restore in isolation.
