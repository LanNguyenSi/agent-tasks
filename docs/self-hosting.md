# Self-hosting on a server

`docker-compose.prod.yml` runs the production stack (`db`, the one-shot
`migrate`, `backend`, `frontend`). This page covers the parts the compose
file deliberately leaves to the operator: the external Traefik proxy the
file assumes, rotating the database passwords once the stack is live, and
what to watch after a deploy. The deploy runbook and the prod runtime
reference: [docs/okf/deploy.md](docs/okf/deploy.md). Backups, restore and
the destructive-schema procedure: [docs/ops-backups.md](docs/ops-backups.md).

All commands run from the deployment directory on the server, where
`docker-compose.prod.yml` and its `.env` live. Always pass
`-f docker-compose.prod.yml`: the file has its own project name
(`agent-tasks`) and a bare `docker compose` command in the same directory
uses the dev file instead. Set `APP_DOMAIN` in the `.env` to the domain
you own (the compose default is the current production host).

## Prerequisite: an external Traefik

The prod file ships no proxy. Both app services carry Traefik router
labels and join an `external: true` network named `traefik`, so before
the first `docker compose -f docker-compose.prod.yml up -d --build` you
need all of this in place:

1. **The network**: `docker network create traefik` (compose looks the
   name up literally and `up` fails with
   `network traefik declared as external, but could not be found` when
   it is missing).
2. **A Traefik instance** (v2 or v3) attached to that network, with the
   names the labels hard-code:
   - an entrypoint named `websecure` listening on 443 (the routers set
     `entrypoints: websecure`);
   - an ACME certificate resolver named `letsencrypt` (the routers set
     `tls.certresolver: letsencrypt`), configured with your email and a
     persistent storage file for the certificates, so `APP_DOMAIN` gets
     a certificate;
   - an HTTP entrypoint on port 80 that redirects to `websecure`
     (Traefik answers ACME HTTP-01 challenge requests on that entrypoint
     before the redirect applies, so the certificate request still works).
3. **DNS**: an A (and/or AAAA) record for `APP_DOMAIN` pointing at the
   server, since the router rules match on ``Host(`${APP_DOMAIN}`)`` and
   Let's Encrypt validates that name.

Then check the config and the route:

```bash
# Compose-file validation (YAML, interpolation). The external network is
# not checked here; `up` checks it.
docker compose -f docker-compose.prod.yml config --quiet

# After the stack is up: the frontend route and the API health route,
# both through Traefik.
curl -fsS https://<APP_DOMAIN>/
curl -fsS https://<APP_DOMAIN>/api/health
```

## Rotating the database password

The `POSTGRES_PASSWORD` in the deployment `.env` is only read by the
Postgres image when it initializes an empty data directory, i.e. on the
first start against the `agent_tasks_postgres` volume. On every later
start the container ignores it: the accepted password is whatever the
database role actually holds. Editing `.env` alone therefore does not
rotate anything until the role is changed inside the database, and
editing it before the role is changed breaks auth for every service that
reads it (`migrate` and any `backend` running as the owner role; see the
recovery steps below).

Rotate in this order, as one short procedure:

1. Change the role password in the running database first:

   ```bash
   docker compose -f docker-compose.prod.yml exec db \
     psql -U agent_tasks -d agent_tasks \
     -c "ALTER USER agent_tasks WITH PASSWORD '<new-password>';"
   ```

2. Then write the same value to `POSTGRES_PASSWORD` in the deployment
   `.env`. The value is interpolated into the `DATABASE_URL` strings, so
   keep it URL-safe (reserved characters such as `@ : # / ? %` break the
   URL), and free of `$` and backticks, which the double-quoted shell
   string in step 1 would expand.
3. Then apply it, right after steps 1 and 2 (until then the running
   backend still holds the old password, so new database connections
   fail and `/api/health` can answer 503): `docker compose -f docker-compose.prod.yml up -d`.
   The changed interpolation recreates `db`, `migrate` and `backend`
   (`frontend`, which depends on `backend`, may be recreated too; a short database outage while `db` restarts); Postgres restarts
   without re-initializing, so the volume and data are untouched and
   the containers now carry the new value.

**agent-relay does not undo this.** Its automatic rollback is a
`git reset --hard` of the deploy checkout plus a rebuild and
`docker compose up -d` (`docs/ops-backups.md`, "Applying a destructive
schema change"); the deployment `.env` is not tracked by git, so a
rollback never reverts it. The file keeps the new password across any
rollback, which is another reason to change the role first: with that
order, every rollback endpoint still has a `.env` that matches the
database.

**The optional runtime role works the same way.** If the deployment sets
`POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD` (the backend then connects
as that role, see the backend `DATABASE_URL` in `docker-compose.prod.yml`
and the "Runtime database role" section of `docs/grounding-migration.md`),
rotate it with the same three steps, and in step 1 name that role:
`ALTER USER "<POSTGRES_APP_USER>" WITH PASSWORD '<new-password>'`
(unset `POSTGRES_APP_USER` means the backend uses the owner role, so the
owner rotation above already covers it). Then update
`POSTGRES_APP_PASSWORD` in `.env` and `up -d`.

**Recovery when the rotation already broke auth** (`password
authentication failed`, Prisma `P1000`, `migrate` failing so `backend`
does not start): the role's actual password is the source of truth, so
fix the side that is stale.

- `.env` was edited before the `ALTER USER`: put the old working password
  back in `.env`, `docker compose -f docker-compose.prod.yml up -d`, then
  redo the rotation in the order above.
- The `ALTER USER` ran but `.env` was not updated: write the new password
  into `.env` and `up -d`.
- Both values are lost: the local socket inside the `db` container needs
  no password (that is how the backup steps in `docs/ops-backups.md`
  connect), so run the `exec ... psql -U agent_tasks` command above to
  set a known password, then sync `.env` to it and `up -d`.

## Unhealthy containers: watch the endpoints yourself

The `backend` and `frontend` healthchecks feed two consumers: the
container's health status (`docker ps`, `docker inspect`) and Traefik's
routing decision, since the Docker provider only routes `healthy`
containers. That is a mitigation, not a recovery:

- **Docker never restarts an unhealthy container.** `restart:
  unless-stopped` reacts to the process exiting only. A process that
  keeps running but stops answering (a hung Next.js server, a wedged
  Node event loop) stays `running` + `unhealthy` forever: the probe
  settings turn it unhealthy within tens of seconds, Traefik de-routes
  it (the public site answers 404; the API drops out of the router), and
  because the hung process never answers again there is no successful
  probe to bring it back. Nothing restarts it on its own.
- **What this repo requires of the operator**: run an external uptime
  probe that checks `https://<APP_DOMAIN>/` and
  `https://<APP_DOMAIN>/api/health` and alerts you, so a de-route that
  does not clear gets a human, or run your own autoheal-style mechanism
  that restarts containers Docker marks unhealthy. Shipping either one
  is out of scope for this repo; `docs/okf/deploy.md` likewise ships no
  post-deploy verification.

A crash loop (the process exits) is different: `restart:
unless-stopped` brings that container back, and the route reappears with
its first successful probe.

## GitHub token encryption

The GitHub OAuth token of every connected user (`users.githubAccessToken`)
is stored encrypted: AES-256-GCM, one random IV per value, kept as
`v1:<iv>:<tag>:<ciphertext>`. The backend decrypts it in memory for each
GitHub call made on a user's behalf (PR create and merge, repo sync, the
health probe); no response or log line carries it. The OIDC client secrets
of SSO connections are a separate store with their own key
(`SSO_ENCRYPTION_KEY`, `docs/enterprise-sso.md`) and are not affected.

**Key.** `GITHUB_TOKEN_ENCRYPTION_KEY` when it is set and not empty,
otherwise `SESSION_SECRET`. Either value goes through HKDF-SHA256 with a
fixed purpose string, so the AES key is never the session secret itself.
`docker-compose.prod.yml` forwards the variable with an empty default.

**Upgrade.** Tokens stored before this change are plaintext. They keep
working: a plaintext value is used as it is and rewritten encrypted on its
first use, and once per backend start a background pass encrypts every
remaining plaintext row (it does not delay the start, logs only a count and
is safe to run again or on two instances at once). Rolling back to a build
without the encryption makes encrypted rows unusable for that build, so
users reconnect GitHub after such a rollback.

**Rotation and loss of the key.** There is no re-encryption tool. When the
key in effect changes, every stored token becomes unreadable: the backend
ignores those tokens (a delegated call falls back to a teammate with a
readable token or is refused, repo sync asks the user to connect), logs
nothing about the values, and the GitHub section of Settings shows the
reconnect banner; each user reconnects GitHub there (new tokens are
encrypted under the new key). That includes the case where no `GITHUB_TOKEN_ENCRYPTION_KEY` is set
and you rotate `SESSION_SECRET`: the key then changes with it. To make
later `SESSION_SECRET` rotations harmless, set `GITHUB_TOKEN_ENCRYPTION_KEY`
to the value `SESSION_SECRET` has now: the derived key is the same, so no
stored token becomes unreadable, and the secret can be rotated afterwards
without disconnecting anyone. Setting it to any other value changes the key
in effect like a rotation does. A database restore needs the same key
as the instance that wrote the dump.

## Related

- `docs/ops-backups.md`: backups, restore, the destructive-schema
  procedure, disk hygiene.
- `docs/okf/deploy.md`: prod runtime reference, image pinning, deploy
  runbook.
- `docs/grounding-migration.md`: the optional runtime database role and
  its grants.
