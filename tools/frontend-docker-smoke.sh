#!/bin/sh
# frontend-docker-smoke.sh
#
# CI/local smoke test for the frontend production Docker image. Builds the
# `prod` stage of frontend/Dockerfile, starts it as a container, waits for
# the server to come up, and asserts that GET / actually serves (HTTP 200,
# following redirects). Fails fast -- with docker logs dumped -- if the
# container exits during the ready-poll, or if the ready-poll times out.
#
# This guards the failure class behind the 2026-08-17 prod outage: the
# image built fine, but the container crash-looped at start because
# runtime-only files (frontend/src, tsconfig.json, the typescript package)
# were missing from the prod stage. `docker build` succeeding can never
# catch that class of bug -- only actually starting the container and
# observing it stay up and serve a request does.
#
# Measured behavior (local Docker 29.7.1, macOS, 2026-08-17, no backend
# present): GET / returns a plain HTTP 200 directly, no redirect, no auth
# wall -- the middleware only adds a CSP header on this route. The `-L` on
# the curl calls below is defensive: if that ever changes to a redirect
# chain (e.g. an auth gate added later), this script still passes as long
# as the chain terminates in a 200, per the acceptance criteria.
#
# Falsifiability (mutation probe): removing this line from frontend/
# Dockerfile's prod stage MUST turn this script red (verified 2026-08-17,
# fails rc=1 via the container-exit gate in the ready-poll, because
# next.config.mjs imports it at every `next start`):
#   COPY --from=build /app/frontend/api-origin.mjs frontend/api-origin.mjs
# (The original probe lines from the incident -- the frontend/src and
# node_modules/typescript COPYs -- were removed for good by the
# next.config.mjs conversion; removing the next.config.mjs COPY itself is
# NOT a reliable probe, since next start can boot on defaults without one.)
#
# Phase 2 (health-assert): boots the frontend service via Docker Compose
# (docker-compose.prod.yml, the same file that deploys prod, plus
# tools/compose.smoke-override.yml -- see that file's header for why it's
# needed) using the already-built image from phase 1 -- no second build --
# and polls `docker inspect` State.Health.Status until it reports
# "healthy". The healthcheck itself (probe command, interval, timeout,
# retries, start_period) is intentionally NOT re-encoded here: it is read
# solely from docker-compose.prod.yml's services.frontend.healthcheck
# block (the override file must never add one -- see its header), so this
# script can never silently drift from what actually ships. Requires
# either the `docker compose` plugin or standalone `docker-compose`; fails
# loudly (never skips) if neither is on PATH.
#
# Environment assumption: the frontend runs ALONE here, with phase 1's
# build args (NEXT_PUBLIC_API_URL=https://api.smoke.invalid) and no
# backend container reachable at http://backend:3001. The probed route
# (GET /, same as phase 1) must stay backend-independent for this phase to
# mean anything -- if the probed route or the healthcheck's own probe ever
# starts requiring a live backend, this phase needs a real backend in the
# compose project, not just the frontend service.
#
# Falsifiability (mutation probe, phase 2): breaking the healthcheck in
# docker-compose.prod.yml (e.g. changing the probed port from 3000 to
# 3001) MUST turn this script red. Verified 2026-08-17 (local Docker
# client 29.7.1 / engine 29.5.2 / Compose 5.5.0, macOS): with the probed
# port changed 3000 -> 3001,
# the compose-managed container reported State.Health.Status=unhealthy
# after FailingStreak reached 3 at ~21s (matches the healthcheck's own
# "connection-refused unhealthy ~21s" comment below), and this script
# exited rc=1 via the `unhealthy` branch of the health-poll below. Restored
# immediately after; not left in the tree.
#
# Usage: tools/frontend-docker-smoke.sh
# Env overrides (all optional): NEXT_PUBLIC_API_URL, READY_TIMEOUT_SECS,
# POLL_INTERVAL_SECS, HEALTH_TIMEOUT_SECS.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)

NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-https://api.smoke.invalid}
READY_TIMEOUT_SECS=${READY_TIMEOUT_SECS:-60}
POLL_INTERVAL_SECS=${POLL_INTERVAL_SECS:-1}
# 45s bound: docker-compose.prod.yml's frontend healthcheck (interval 5s,
# timeout 5s, retries 3, start_period 10s) has a measured worst-case of
# ~41s to reach a terminal Health.Status, in its slowest failure mode (a
# hung server that accepts TCP but never responds -- see that file's own
# "Detection bounds measured locally" comment on services.frontend for the
# full breakdown: healthy ~5-6s, connection-refused unhealthy ~21s, hung
# ~41s). 45s leaves a small margin over that measured worst case rather
# than re-deriving a theoretical bound from interval*retries+start_period,
# which does not account for the observed per-probe timeout stacking.
HEALTH_TIMEOUT_SECS=${HEALTH_TIMEOUT_SECS:-45}

IMAGE_TAG="agent-tasks-frontend-smoke:$$"
CONTAINER_NAME="agent-tasks-frontend-smoke-$$"

# --- phase 2 (health-assert) setup: isolated compose project so the
# container, network and volume NAMES can never collide with a real
# deployment (project/container/volume names, plus the compose-managed
# `internal` network, are all namespaced by the $$-suffixed project name
# below). That alone is not enough: docker-compose.prod.yml's frontend
# service also joins the shared *external* `traefik` network with live
# Traefik router labels, which project-namespacing does not isolate --
# tools/compose.smoke-override.yml (layered in via compose_cmd below)
# detaches the smoke-started frontend from that network and disables its
# Traefik registration, so the smoke container can never appear on a real
# host's public route. See that file's header for the mechanics/rationale.
# ---
COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"
COMPOSE_OVERRIDE_FILE="${REPO_ROOT}/tools/compose.smoke-override.yml"
COMPOSE_PROJECT="agent-tasks-smoke-$$"
# Docker Compose's implicit build-image naming convention (verified locally
# via `docker compose config --images`): "<project>-<service>:latest".
COMPOSE_IMAGE="${COMPOSE_PROJECT}-frontend:latest"
# Even though the override above detaches the *frontend* service from the
# `traefik` network, docker-compose.prod.yml still declares it at the
# top-level `networks:` key and the `backend` service (not started here --
# `up --no-deps frontend` skips it) still references it there. Verified
# empirically 2026-08-17: `compose up --no-deps frontend` against the real
# file + override still fails with "network traefik declared as external,
# but could not be found" when the network is absent, and still succeeds
# without it needing to be created when NO service in the file references
# it at all. So this script still owns creating/removing it. The create
# side is race-tolerant (create || re-inspect below); the REMOVE side is
# deliberately only guarded against foreign attachments (a real stack), NOT
# against a concurrent smoke run: a second local run attaches nothing to
# this network (the override detaches its frontend), so the creator's
# cleanup can rm the network between that run's existence check and its
# `compose up`, which then fails LOUDLY with "network traefik declared as
# external, but could not be found". Accepted: local-concurrency only (CI
# is one job per ephemeral runner), and a loud red, never a silent pass.
TRAEFIK_NETWORK="traefik"
CREATED_TRAEFIK_NETWORK=0
COMPOSE_CID=""

# Prefer the `docker compose` plugin (what GitHub-hosted runners ship);
# fall back to standalone `docker-compose`. Fail loudly if neither exists --
# never silently skip the health-assert phase.
COMPOSE_USE_PLUGIN=0
if docker compose version >/dev/null 2>&1; then
  COMPOSE_USE_PLUGIN=1
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_USE_PLUGIN=0
else
  echo "FAIL: no Docker Compose CLI found (need the 'docker compose' plugin or standalone 'docker-compose') for the health-assert phase" >&2
  exit 1
fi

compose_cmd() {
  if [ "${COMPOSE_USE_PLUGIN}" = "1" ]; then
    docker compose -f "${COMPOSE_FILE}" -f "${COMPOSE_OVERRIDE_FILE}" -p "${COMPOSE_PROJECT}" "$@"
  else
    docker-compose -f "${COMPOSE_FILE}" -f "${COMPOSE_OVERRIDE_FILE}" -p "${COMPOSE_PROJECT}" "$@"
  fi
}

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "--- cleanup: removing container and image ---"
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker rmi -f "${IMAGE_TAG}" >/dev/null 2>&1 || true
  echo "--- cleanup: compose down (project ${COMPOSE_PROJECT}) ---"
  compose_cmd down -v --remove-orphans >/dev/null 2>&1 || true
  docker rmi -f "${COMPOSE_IMAGE}" >/dev/null 2>&1 || true
  if [ "${CREATED_TRAEFIK_NETWORK}" = "1" ]; then
    # This endpoint guard detects FOREIGN attachments only (a real stack
    # that started using the network mid-test): with the compose override
    # in place, neither this run's frontend nor a concurrent smoke run's
    # ever attaches to this network, so a concurrent run is invisible here
    # (see the comment at TRAEFIK_NETWORK above for the accepted remove-side
    # race). Only remove the network when it is provably unused right now.
    net_endpoints=$(docker network inspect -f '{{len .Containers}}' "${TRAEFIK_NETWORK}" 2>/dev/null) || net_endpoints=""
    if [ "${net_endpoints}" = "0" ]; then
      docker network rm "${TRAEFIK_NETWORK}" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

fail() {
  echo "FAIL: $1" >&2
  echo "--- container logs (${CONTAINER_NAME}) ---" >&2
  docker logs "${CONTAINER_NAME}" >&2 || true
  exit 1
}

health_fail() {
  echo "FAIL: $1" >&2
  echo "--- compose frontend logs (project ${COMPOSE_PROJECT}) ---" >&2
  compose_cmd logs frontend >&2 || true
  # Reuse COMPOSE_CID when already resolved; otherwise (a failure before
  # that point, e.g. `compose up` itself failing) fall back to `ps -a -q`
  # rather than the default `ps -q`, so the Health JSON dump below still
  # fires for a container that already exited instead of silently finding
  # nothing.
  if [ -n "${COMPOSE_CID}" ]; then
    health_fail_cid="${COMPOSE_CID}"
  else
    health_fail_cid=$(compose_cmd ps -a -q frontend 2>/dev/null) || health_fail_cid=""
  fi
  if [ -n "${health_fail_cid}" ]; then
    echo "--- docker inspect State.Health (project ${COMPOSE_PROJECT}) ---" >&2
    docker inspect -f '{{json .State.Health}}' "${health_fail_cid}" >&2 || true
  fi
  exit 1
}

echo "--- build (context=${REPO_ROOT}, dockerfile=frontend/Dockerfile, target=prod) ---"
build_start=$(date +%s)
docker build \
  -f "${REPO_ROOT}/frontend/Dockerfile" \
  --target prod \
  --build-arg "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}" \
  -t "${IMAGE_TAG}" \
  "${REPO_ROOT}"
build_end=$(date +%s)
echo "build wall time: $((build_end - build_start))s"

echo "--- run ---"
# Bind to a host-assigned random port on the loopback interface only, so
# concurrent runs (or a stray leftover container) never collide.
docker run -d --name "${CONTAINER_NAME}" -p 127.0.0.1::3000 "${IMAGE_TAG}" >/dev/null

HOST_PORT=$(docker port "${CONTAINER_NAME}" 3000/tcp | head -n1 | sed 's/.*://')
if [ -z "${HOST_PORT}" ]; then
  fail "could not determine the published host port for container port 3000/tcp"
fi
BASE_URL="http://127.0.0.1:${HOST_PORT}/"
echo "published on ${BASE_URL}"

echo "--- ready-poll (timeout ${READY_TIMEOUT_SECS}s) ---"
poll_start=$(date +%s)
while :; do
  state=$(docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || echo false)
  if [ "${state}" != "true" ]; then
    fail "container exited during the ready-poll (docker inspect State.Running=${state})"
  fi

  http_code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 5 "${BASE_URL}") || http_code=000
  if [ "${http_code}" = "200" ]; then
    break
  fi

  now=$(date +%s)
  elapsed=$((now - poll_start))
  if [ "${elapsed}" -ge "${READY_TIMEOUT_SECS}" ]; then
    fail "ready-poll timed out after ${elapsed}s (last GET / -> HTTP ${http_code})"
  fi
  sleep "${POLL_INTERVAL_SECS}"
done
poll_end=$(date +%s)
echo "ready after $((poll_end - poll_start))s"

echo "--- final assertion: GET / -> HTTP 200 (curl -L) ---"
final_code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 5 "${BASE_URL}") || final_code=000
if [ "${final_code}" != "200" ]; then
  fail "GET / returned HTTP ${final_code}, expected 200"
fi
echo "GET / -> HTTP ${final_code}"

state=$(docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || echo false)
if [ "${state}" != "true" ]; then
  fail "container exited after the ready assertion (docker inspect State.Running=${state})"
fi

echo "PASS: frontend prod image builds, starts, and serves GET / with HTTP 200"

echo "--- health-assert: tag image for compose (project ${COMPOSE_PROJECT}) ---"
docker tag "${IMAGE_TAG}" "${COMPOSE_IMAGE}"

if ! docker network inspect "${TRAEFIK_NETWORK}" >/dev/null 2>&1; then
  echo "--- health-assert: creating external network '${TRAEFIK_NETWORK}' (docker-compose.prod.yml's 'backend' service still declares it, so Compose requires it to exist even though only 'frontend' is started) ---"
  # `docker network create` is not idempotent: a concurrent smoke run can
  # win the same create race, in which case ours fails with "already
  # exists". Tolerate that failure and re-verify existence next -- only a
  # genuine failure (permissions, daemon issue) that leaves the network
  # still absent afterward is fatal.
  docker network create "${TRAEFIK_NETWORK}" >/dev/null 2>&1 || true
  if ! docker network inspect "${TRAEFIK_NETWORK}" >/dev/null 2>&1; then
    echo "FAIL: could not create or verify the external network '${TRAEFIK_NETWORK}' required by docker-compose.prod.yml's top-level networks declaration" >&2
    exit 1
  fi
  CREATED_TRAEFIK_NETWORK=1
fi

# Dummy values so Compose can interpolate docker-compose.prod.yml without
# warnings -- these belong to the db/backend/migrate services, not frontend,
# but Compose interpolates the whole file up front regardless of which
# service is started. Exported only for the compose_cmd invocations below.
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-smoke-dummy}
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID:-smoke-dummy}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET:-smoke-dummy}
SESSION_SECRET=${SESSION_SECRET:-smoke-dummy}
export POSTGRES_PASSWORD GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET SESSION_SECRET

echo "--- health-assert: compose up --no-deps --no-build frontend (project ${COMPOSE_PROJECT}) ---"
compose_up_start=$(date +%s)
if ! compose_cmd up -d --no-deps --no-build frontend; then
  health_fail "compose up failed for the health-assert phase (expected pre-tagged image ${COMPOSE_IMAGE}; if this is 'No such image', Compose's implicit image-naming convention no longer matches what this script assumes -- re-verify with 'docker compose config --images')"
fi
compose_up_end=$(date +%s)
echo "compose up wall time: $((compose_up_end - compose_up_start))s (--no-build: no rebuild should occur)"

COMPOSE_CID=$(compose_cmd ps -q frontend) || COMPOSE_CID=""
if [ -z "${COMPOSE_CID}" ]; then
  # `compose up -d` exits 0 even when the container starts and immediately
  # dies, and `ps -q` only lists running containers -- so an empty id here
  # usually MEANS the crash-loop class this script exists for. Name it.
  exited_cid=$(compose_cmd ps -a -q frontend 2>/dev/null) || exited_cid=""
  if [ -n "${exited_cid}" ]; then
    exit_code=$(docker inspect -f '{{.State.ExitCode}}' "${exited_cid}" 2>/dev/null) || exit_code="?"
    health_fail "compose-managed frontend container started and exited (State.ExitCode=${exit_code})"
  fi
  health_fail "could not resolve the compose-managed frontend container id (compose ps -q frontend returned empty)"
fi

# Assert the smoke override actually detached us from the shared proxy. The
# primary lock is `networks: !override` in tools/compose.smoke-override.yml,
# but an unrecognized YAML tag on an old Compose (< 2.24.4) is ACCEPTED
# SILENTLY and merges instead of replacing (measured on 5.5.0 with an
# unknown tag: rc=0, no warning) -- so verify the safety property on the
# live container instead of trusting the override by construction.
on_traefik=$(docker inspect -f '{{range $name, $v := .NetworkSettings.Networks}}{{$name}} {{end}}' "${COMPOSE_CID}" 2>/dev/null | grep -c "\b${TRAEFIK_NETWORK}\b") || on_traefik=0
traefik_enable=$(docker inspect -f '{{index .Config.Labels "traefik.enable"}}' "${COMPOSE_CID}" 2>/dev/null) || traefik_enable=""
if [ "${on_traefik}" != "0" ] || [ "${traefik_enable}" != "false" ]; then
  health_fail "smoke override did not apply: container on '${TRAEFIK_NETWORK}' network=${on_traefik}, traefik.enable='${traefik_enable}' (expected detached + 'false'; is this Compose older than 2.24.4, silently ignoring the !override tag in tools/compose.smoke-override.yml?)"
fi

# Assert a healthcheck is actually configured AND enabled before polling for
# it. Without this, a docker-compose.prod.yml edit that drops
# services.frontend.healthcheck (Config.Healthcheck empty) or disables it
# (`disable: true` renders Test=["NONE"]) leaves State.Health permanently
# absent, and the poll below would just run out the full
# ${HEALTH_TIMEOUT_SECS}s clock with an opaque "unknown" status instead of
# failing immediately with a precise reason.
has_healthcheck=$(docker inspect -f '{{if .Config.Healthcheck}}{{if ne (index .Config.Healthcheck.Test 0) "NONE"}}yes{{end}}{{end}}' "${COMPOSE_CID}" 2>/dev/null) || has_healthcheck=""
if [ -z "${has_healthcheck}" ]; then
  health_fail "compose-managed frontend container has no enabled healthcheck (docker inspect .Config.Healthcheck is empty or Test is NONE) -- docker-compose.prod.yml's services.frontend.healthcheck block is missing, disabled, or was not applied"
fi

echo "--- health-assert: poll docker inspect State.Health.Status (timeout ${HEALTH_TIMEOUT_SECS}s) ---"
health_poll_start=$(date +%s)
while :; do
  health_status=$(docker inspect -f '{{.State.Health.Status}}' "${COMPOSE_CID}" 2>/dev/null || echo unknown)
  if [ "${health_status}" = "healthy" ]; then
    break
  fi
  if [ "${health_status}" = "unhealthy" ]; then
    health_fail "compose-managed frontend container reported unhealthy (the healthcheck declared in docker-compose.prod.yml's services.frontend.healthcheck failed)"
  fi

  now=$(date +%s)
  elapsed=$((now - health_poll_start))
  if [ "${elapsed}" -ge "${HEALTH_TIMEOUT_SECS}" ]; then
    health_fail "health-poll timed out after ${elapsed}s (last docker-reported status: ${health_status})"
  fi
  sleep "${POLL_INTERVAL_SECS}"
done
health_poll_end=$(date +%s)
echo "compose frontend reported healthy after $((health_poll_end - health_poll_start))s"

echo "PASS: compose-managed frontend container reaches State.Health.Status=healthy per the healthcheck declared in docker-compose.prod.yml"
