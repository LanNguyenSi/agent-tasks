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
# Usage: tools/frontend-docker-smoke.sh
# Env overrides (all optional): NEXT_PUBLIC_API_URL, READY_TIMEOUT_SECS,
# POLL_INTERVAL_SECS.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)

NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-https://api.smoke.invalid}
READY_TIMEOUT_SECS=${READY_TIMEOUT_SECS:-60}
POLL_INTERVAL_SECS=${POLL_INTERVAL_SECS:-1}

IMAGE_TAG="agent-tasks-frontend-smoke:$$"
CONTAINER_NAME="agent-tasks-frontend-smoke-$$"

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "--- cleanup: removing container and image ---"
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker rmi -f "${IMAGE_TAG}" >/dev/null 2>&1 || true
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
