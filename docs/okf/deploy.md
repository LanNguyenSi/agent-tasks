---
type: runbook
title: "Deploy: no in-repo automation, prod is docker-compose"
description: "ci.yml only tests and builds; deploy/verify is an external ops concern; prod runtime is db + one-shot Prisma db push + backend/frontend behind Traefik."
tags: [deploy, docker-compose, ops, ci]
timestamp: 2026-08-21T09:00:00Z
sources:
  - .github/workflows/ci.yml
  - .github/workflows/docker-smoke.yml
  - docker-compose.prod.yml
  - Dockerfile.migrate
  - tools/frontend-docker-smoke.sh
  - tools/compose.smoke-override.yml
  - docs/deploy-verify-strategy.md
---

**There is no deploy automation in this repo.** `.github/workflows/ci.yml` (triggered on push to `master`/`main`/`develop`/`release/*`, on PRs to `master`/`main`/`develop` only, plus `workflow_call`/`workflow_dispatch`) runs five independent jobs, `backend` (Postgres 16 service container, native-dep smoke test, Prisma generate, typecheck, lint, `test:coverage`), `frontend` (typecheck, lint, `test:coverage`, `next build`), `mcp-server`, `mcp-bridge` (`needs: mcp-server`), `cli`. Since 2026-08-17 (incident follow-up, PR #456) `.github/workflows/docker-smoke.yml` additionally builds the frontend prod image and boots the container on frontend-touching PRs (`tools/frontend-docker-smoke.sh`: build `--target prod`, run, assert `GET / -> 200`, fail on container exit) -- a pre-merge image-viability guard, still not a deploy. A second phase boots the frontend service via `docker-compose.prod.yml` itself and asserts the compose-declared healthcheck reaches `healthy` (single-sourced -- the script re-encodes no probe parameters); `tools/compose.smoke-override.yml` detaches that smoke container from the shared external `traefik` network and sets `traefik.enable=false` so a smoke run on a proxy-carrying host can never join the live route, and the script verifies that detachment on the live container at runtime. Nothing in `.github/workflows/` pushes an image, SSHes anywhere, or calls a deploy webhook. `docs/deploy-verify-strategy.md` makes this an explicit design decision, not an oversight: deploy/verify are modeled as "operational follow-ups," not task-workflow states, `done` means "PR merged," not "change is live" (ADR 0001). Teams that need a formal deploy gate are expected to define a custom workflow (e.g. `merged → staging → production → verified`) via `POST /api/workflows`, not to wait for the default workflow to grow one.

**Prod runtime** (`docker-compose.prod.yml`): `db` (`postgres:16-alpine`, named volume `agent_tasks_postgres`, healthcheck `pg_isready`) → `migrate` (one-shot, `Dockerfile.migrate`, `depends_on: db: condition: service_healthy`, `restart: "no"`) → `backend` (`depends_on: migrate: condition: service_completed_successfully`) → `frontend` (`depends_on: backend`, so it waits for `migrate` only transitively; since 2026-08-17 with its own `node -e fetch` healthcheck on port 3000 -- interval 5s, timeout 5s, retries 3, start_period 10s -- whose comment in the compose file documents the measured detection bounds and the Traefik coupling: Traefik's Docker provider, with its default `allowEmptyServices=false`, only routes containers whose health is `healthy`, so the public route appears with the first successful probe and an unhealthy frontend is de-routed to a public 404 that self-heals on the next successful probe). `migrate`'s `Dockerfile.migrate` installs the backend workspace with `--ignore-scripts`, copies only `backend/prisma`, and its `CMD` is `npx prisma db push --schema=/app/backend/prisma/schema.prisma --skip-generate --accept-data-loss`, schema sync via `db push`, not `migrate deploy`; **`--accept-data-loss` is present**, so a column/type change that Prisma judges destructive is applied without a manual confirmation step in this container.

`backend` and `frontend` both join two Docker networks: `internal` (talks to `db`) and the external `traefik` network, with Traefik router labels for `agent-tasks.opentriologue.ai` (`/api`+`/docs` prefix → backend port 3001; everything else → frontend port 3000), TLS via `letsencrypt` cert resolver. `backend` has an uploads volume (`agent_tasks_uploads`) for human-uploaded attachments, explicitly called out in the compose file as **not** covered by the Postgres backup scope. Memory limits are hand-tuned per service (`db` 512m, `migrate` 512m, `backend` 768m, `frontend` 1g) based on observed idle/peak RSS, documented inline.

**Verifying a deployment**: since there is no in-repo mechanism, verification is external, confirm the `backend`/`frontend` containers are healthy and on the expected image digest, hit `GET /api/health` AND the root URL (the 2026-08-17 outage was a green backend with a crash-looping frontend), and check the Traefik router is serving the current cert/host. `tools/frontend-docker-smoke.sh` covers pre-merge image viability; there is still no scripted post-deploy verification in this repo -- that is an ops runbook outside `docs/okf/`.

Related: `architecture.md`, `release-flow.md`.
