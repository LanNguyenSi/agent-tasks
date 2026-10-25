#!/usr/bin/env bash
# backend-docker-smoke.sh
#
# CI/local smoke test for the backend production images: the `prod` stage of
# backend/Dockerfile and Dockerfile.migrate. Sibling of
# tools/frontend-docker-smoke.sh and guards the same failure class (the
# 2026-08-17 prod outage): an image that builds fine but crash-loops, or
# serves nothing, once it starts. `docker build` succeeding never catches
# that; only running the containers and asking them for a response does.
#
# What it does, using docker-compose.prod.yml itself (so the migrate and
# backend services are exercised exactly as declared for prod):
#   1. builds the `migrate` and `backend` services (backend --target prod);
#   2. starts `db` and the one-shot `migrate` and waits, bounded, for migrate
#      to exit 0 (a failing schema push or SQL file fails the smoke run);
#   3. starts `backend` and polls GET /api/health from inside the container
#      (the route checks the database, so 200 + database ok proves the Prisma
#      client, the compiled dist and the migrated schema work together), then
#      asserts the compose-declared healthcheck reaches `healthy`;
#   4. always tears the project, its volumes and its images down.
# On any failure it dumps the logs of the service that failed and exits 1.
#
# tools/compose.smoke-override.yml detaches the backend from the shared
# external `traefik` network and disables its Traefik labels, so a smoke run
# on a host that also runs the real proxy can never join the live route; the
# script verifies that on the live container instead of trusting the override.
# Healthcheck parameters are NOT re-encoded here: they come only from
# docker-compose.prod.yml (the override must never carry a healthcheck).
#
# Falsifiability: a bad CMD in the backend prod stage (for example
# `CMD ["node", "dist/does-not-exist.js"]`) or a missing runtime COPY MUST
# turn this script red via the container-exit gate or the health-poll
# timeout; a failing migrate CMD MUST turn it red via the migrate gate.
#
# Usage: tools/backend-docker-smoke.sh
# Env overrides (all optional): SMOKE_PROJECT_PREFIX, MIGRATE_TIMEOUT_SECS,
# READY_TIMEOUT_SECS, HEALTH_TIMEOUT_SECS, POLL_INTERVAL_SECS,
# SMOKE_BUILD_PLATFORM (for example linux/amd64: builds the migrate and backend
# images for that platform only; the Prisma client is generated for
# debian-openssl-3.0.x, which is the x64 engine, so on an arm64 host the
# images only boot when built for linux/amd64, as on the x64 CI runner).

set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)

MIGRATE_TIMEOUT_SECS=${MIGRATE_TIMEOUT_SECS:-120}
READY_TIMEOUT_SECS=${READY_TIMEOUT_SECS:-60}
# Same worst-case bound as the frontend smoke: the shared healthcheck shape
# (interval 5s, timeout 5s, retries 3, start_period 20s on the backend)
# settles within this window.
HEALTH_TIMEOUT_SECS=${HEALTH_TIMEOUT_SECS:-60}
POLL_INTERVAL_SECS=${POLL_INTERVAL_SECS:-1}

COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"
COMPOSE_OVERRIDE_FILE="${REPO_ROOT}/tools/compose.smoke-override.yml"
COMPOSE_PROJECT="${SMOKE_PROJECT_PREFIX:-agent-tasks-backend-smoke}-$$"

# docker-compose.prod.yml declares the shared external `traefik` network at
# the top level, and Compose requires it to exist even though the override
# detaches the started services from it. Create it only when absent and
# remove it only when this run created it and nothing is attached.
TRAEFIK_NETWORK="traefik"
CREATED_TRAEFIK_NETWORK=0

if docker compose version >/dev/null 2>&1; then
  COMPOSE_USE_PLUGIN=1
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_USE_PLUGIN=0
else
  echo "FAIL: no Docker Compose CLI found (need the 'docker compose' plugin or standalone 'docker-compose')" >&2
  exit 1
fi

compose_cmd() {
  if [ "${COMPOSE_USE_PLUGIN}" = "1" ]; then
    docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_OVERRIDE_FILE}" -p "${COMPOSE_PROJECT}" "$@"
  else
    docker-compose -f "${COMPOSE_FILE}" -f "${COMPOSE_OVERRIDE_FILE}" -p "${COMPOSE_PROJECT}" "$@"
  fi
}

# Dummy values so Compose can interpolate docker-compose.prod.yml. None of
# them reach a real service. SESSION_SECRET must be at least 32 characters:
# the backend validates its config at boot and exits otherwise.
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-smoke-dummy}"
export GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-smoke-dummy}"
export GITHUB_CLIENT_SECRET="${GITHUB_CLIENT_SECRET:-smoke-dummy}"
export SESSION_SECRET="${SESSION_SECRET:-smoke-dummy-session-secret-0123456789abcdef}"

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "--- cleanup: compose down (project ${COMPOSE_PROJECT}) ---"
  compose_cmd down -v --remove-orphans >/dev/null 2>&1 || true
  docker rmi -f "${COMPOSE_PROJECT}-backend:latest" "${COMPOSE_PROJECT}-migrate:latest" >/dev/null 2>&1 || true
  if [ "${CREATED_TRAEFIK_NETWORK}" = "1" ]; then
    net_endpoints=$(docker network inspect -f '{{len .Containers}}' "${TRAEFIK_NETWORK}" 2>/dev/null) || net_endpoints=""
    if [ "${net_endpoints}" = "0" ]; then
      docker network rm "${TRAEFIK_NETWORK}" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# fail <message> <service>...: print the message, then the logs of each named
# service (and, for the last, its Health JSON when a container exists).
fail() {
  local message=$1
  shift
  echo "FAIL: ${message}" >&2
  local svc cid
  for svc in "$@"; do
    echo "--- compose logs ${svc} (project ${COMPOSE_PROJECT}) ---" >&2
    compose_cmd logs --no-color "${svc}" >&2 || true
    cid=$(compose_cmd ps -a -q "${svc}" 2>/dev/null) || cid=""
    if [ -n "${cid}" ]; then
      echo "--- docker inspect State (${svc}) ---" >&2
      docker inspect -f '{{json .State}}' "${cid}" >&2 || true
    fi
  done
  exit 1
}

if ! docker network inspect "${TRAEFIK_NETWORK}" >/dev/null 2>&1; then
  echo "--- creating external network '${TRAEFIK_NETWORK}' required by docker-compose.prod.yml ---"
  docker network create "${TRAEFIK_NETWORK}" >/dev/null 2>&1 || true
  if ! docker network inspect "${TRAEFIK_NETWORK}" >/dev/null 2>&1; then
    echo "FAIL: could not create or verify the external network '${TRAEFIK_NETWORK}'" >&2
    exit 1
  fi
  CREATED_TRAEFIK_NETWORK=1
fi

echo "--- build: migrate (Dockerfile.migrate) and backend (backend/Dockerfile, target prod) ---"
build_start=$(date +%s)
if ! DOCKER_DEFAULT_PLATFORM="${SMOKE_BUILD_PLATFORM:-${DOCKER_DEFAULT_PLATFORM:-}}" compose_cmd build migrate backend; then
  echo "FAIL: image build failed" >&2
  exit 1
fi
echo "build wall time: $(($(date +%s) - build_start))s"

echo "--- migrate: start db + migrate (timeout ${MIGRATE_TIMEOUT_SECS}s) ---"
if ! compose_cmd up -d --no-build migrate; then
  fail "compose up failed for db/migrate" migrate db
fi
migrate_start=$(date +%s)
while :; do
  migrate_cid=$(compose_cmd ps -a -q migrate) || migrate_cid=""
  migrate_state=""
  if [ -n "${migrate_cid}" ]; then
    migrate_state=$(docker inspect -f '{{.State.Status}}' "${migrate_cid}" 2>/dev/null) || migrate_state=""
  fi
  if [ "${migrate_state}" = "exited" ]; then
    migrate_code=$(docker inspect -f '{{.State.ExitCode}}' "${migrate_cid}")
    if [ "${migrate_code}" != "0" ]; then
      fail "migrate exited with code ${migrate_code}" migrate db
    fi
    break
  fi
  elapsed=$(($(date +%s) - migrate_start))
  if [ "${elapsed}" -ge "${MIGRATE_TIMEOUT_SECS}" ]; then
    fail "migrate did not finish within ${elapsed}s (state: ${migrate_state:-unknown})" migrate db
  fi
  sleep "${POLL_INTERVAL_SECS}"
done
echo "migrate completed (exit 0) after $(($(date +%s) - migrate_start))s"

echo "--- backend: start (project ${COMPOSE_PROJECT}) ---"
if ! compose_cmd up -d --no-build --no-deps backend; then
  fail "compose up failed for backend" backend
fi
backend_cid=$(compose_cmd ps -a -q backend) || backend_cid=""
if [ -z "${backend_cid}" ]; then
  fail "could not resolve the compose-managed backend container id" backend
fi

# Assert the override detached the backend from the shared proxy. An unknown
# YAML tag on an old Compose is accepted silently, so check the live container.
on_traefik=$(docker inspect -f '{{range $name, $v := .NetworkSettings.Networks}}{{$name}} {{end}}' "${backend_cid}" 2>/dev/null | grep -c "\b${TRAEFIK_NETWORK}\b") || on_traefik=0
traefik_enable=$(docker inspect -f '{{index .Config.Labels "traefik.enable"}}' "${backend_cid}" 2>/dev/null) || traefik_enable=""
if [ "${on_traefik}" != "0" ] || [ "${traefik_enable}" != "false" ]; then
  fail "smoke override did not apply: backend on '${TRAEFIK_NETWORK}' network=${on_traefik}, traefik.enable='${traefik_enable}' (expected detached + 'false'; Compose older than 2.24.4?)" backend
fi

has_healthcheck=$(docker inspect -f '{{if .Config.Healthcheck}}{{if ne (index .Config.Healthcheck.Test 0) "NONE"}}yes{{end}}{{end}}' "${backend_cid}" 2>/dev/null) || has_healthcheck=""
if [ -z "${has_healthcheck}" ]; then
  fail "backend has no enabled healthcheck: docker-compose.prod.yml's services.backend.healthcheck is missing, disabled, or was not applied" backend
fi

echo "--- ready-poll: GET /api/health inside the container (timeout ${READY_TIMEOUT_SECS}s) ---"
poll_start=$(date +%s)
body=""
while :; do
  # restart: unless-stopped keeps a crashing container "running" between
  # restarts, so a restart count above zero is the crash-loop signal.
  running=$(docker inspect -f '{{.State.Running}}' "${backend_cid}" 2>/dev/null) || running=false
  restarts=$(docker inspect -f '{{.RestartCount}}' "${backend_cid}" 2>/dev/null) || restarts=0
  if [ "${running}" != "true" ] || [ "${restarts}" != "0" ]; then
    fail "backend container exited or crash-looped during the ready-poll (State.Running=${running}, RestartCount=${restarts})" backend
  fi
  # node:22-slim ships no curl/wget; node's global fetch is the probe. Prints
  # "<status> <body>" and exits 0 only on HTTP 200.
  if body=$(docker exec "${backend_cid}" node -e "fetch('http://127.0.0.1:3001/api/health').then(async (r) => { console.log(r.status + ' ' + (await r.text())); process.exit(r.status === 200 ? 0 : 1) }).catch(() => process.exit(1))" 2>/dev/null); then
    break
  fi
  elapsed=$(($(date +%s) - poll_start))
  if [ "${elapsed}" -ge "${READY_TIMEOUT_SECS}" ]; then
    fail "ready-poll timed out after ${elapsed}s (GET /api/health never returned HTTP 200)" backend db
  fi
  sleep "${POLL_INTERVAL_SECS}"
done
echo "ready after $(($(date +%s) - poll_start))s: ${body}"

case "${body}" in
  *'"status":"ok"'*'"database":{"status":"ok"'*) ;;
  *) fail "GET /api/health returned 200 but not a database-backed ok body: ${body}" backend db ;;
esac

echo "--- health-assert: poll docker inspect State.Health.Status (timeout ${HEALTH_TIMEOUT_SECS}s) ---"
health_start=$(date +%s)
while :; do
  health_status=$(docker inspect -f '{{.State.Health.Status}}' "${backend_cid}" 2>/dev/null) || health_status=unknown
  if [ "${health_status}" = "healthy" ]; then
    break
  fi
  if [ "${health_status}" = "unhealthy" ]; then
    fail "backend reported unhealthy (the healthcheck declared in docker-compose.prod.yml's services.backend.healthcheck failed)" backend db
  fi
  elapsed=$(($(date +%s) - health_start))
  if [ "${elapsed}" -ge "${HEALTH_TIMEOUT_SECS}" ]; then
    fail "health-poll timed out after ${elapsed}s (last docker-reported status: ${health_status})" backend db
  fi
  sleep "${POLL_INTERVAL_SECS}"
done
echo "backend reported healthy after $(($(date +%s) - health_start))s"

echo "PASS: migrate image completes and the backend prod image serves GET /api/health (database ok) and reaches healthy"
