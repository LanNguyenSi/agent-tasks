#!/usr/bin/env bash
# Tests for tools/check-image-digests.sh. Run: bash tools/check-image-digests.test.sh
# Prints one line per failure and a final `Result: N cases passed` (exit 0) or
# `Result: N cases passed, M failed` (exit 1).
# Argument `dockerfile`: run only the Dockerfile cases (no docker needed).
# Compose cases run `docker compose config` on fixture files.
set -eo pipefail
section="${1:-all}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$here/check-image-digests.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
H=5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
D="sha256:$H"
pass=0
fails=0

# expect <name> <want-exit> <want-output-substring-or-empty> <file...>
expect() {
  local name="$1" want="$2" sub="$3"; shift 3
  local out rc=0
  out="$(bash "$guard" "$@" 2>&1)" || rc=$?
  if [ "$rc" -ne "$want" ] || { [ -n "$sub" ] && [[ "$out" != *"$sub"* ]]; }; then
    echo "FAIL $name: exit $rc (want $want), output: $out"
    fails=$((fails + 1))
  else
    pass=$((pass + 1))
  fi
}

# df <name> <want-exit> <sub> <printf-format> [args]: a Dockerfile case
df() {
  local name="$1" want="$2" sub="$3"; shift 3
  printf "$@" > "$tmp/case.Dockerfile"
  expect "dockerfile: $name" "$want" "$sub" "$tmp/case.Dockerfile"
}

# --- Dockerfile ---
df "pinned with internal stages and scratch" 0 "" 'FROM node:22-slim@%s AS base\nFROM base AS dev\nFROM scratch\n' "$D"
df "tag-only FROM fails with file and line" 1 "case.Dockerfile:1:" 'FROM node:22-slim AS base\n'
df "second unpinned FROM reports its line" 1 "case.Dockerfile:2:" 'FROM node:22-slim@%s AS base\nFROM node:22-slim AS prod\n' "$D"
df "digest without tag fails" 1 "case.Dockerfile:1:" 'FROM node@%s\n' "$D"
df "63 hex digits fail" 1 "case.Dockerfile:1:" 'FROM node:22@sha256:%s\n' "${H%?}"
df "60 hex digits fail" 1 "case.Dockerfile:1:" 'FROM node:22@sha256:%s\n' "${H%????}"
df "65 hex digits fail" 1 "case.Dockerfile:1:" 'FROM node:22@sha256:%sa\n' "$H"
df "truncated digest fails" 1 "case.Dockerfile:1:" 'FROM node:22-slim@sha256:abc\n'
df "uppercase hex fails" 1 "case.Dockerfile:1:" 'FROM node:22@sha256:%s\n' "$(printf %s "$H" | tr a-f A-F)"
df "valid digest with trailing characters fails" 1 "case.Dockerfile:1:" 'FROM node:22@%sxyz\n' "$D"
df "other digest algorithm fails" 1 "case.Dockerfile:1:" 'FROM node:22@sha512:%s\n' "$H"
df "two digests fail" 1 "case.Dockerfile:1:" 'FROM node:22@%s@%s\n' "$D" "$D"
df "FROM of an undeclared name is external" 1 "case.Dockerfile:1:" 'FROM base AS dev\n'
df "commented FROM ignored, --platform flag parsed" 0 "" '# FROM node:22-slim\n  # image: x\nFROM --platform=linux/amd64 node:22-slim@%s AS base\n' "$D"
df "variable reference fails" 1 "case.Dockerfile:1:" 'FROM ${BASE}\n'
df "interpolated tag with a digest fails" 1 "case.Dockerfile:1:" 'FROM node:${NODE_TAG}@%s\n' "$D"
df "lowercase from, pinned" 0 "" 'from node:22-slim@%s as base\n' "$D"
df "lowercase from, unpinned" 1 "case.Dockerfile:1:" 'from node:22-slim as base\n'
df "tab after FROM, pinned" 0 "" 'FROM\tnode:22-slim@%s\n' "$D"
df "tab after FROM, unpinned" 1 "case.Dockerfile:1:" 'FROM\tnode:22-slim\n'
df "FROMX is not FROM" 0 "" 'FROMX node:22-slim\n'
df "mixed-case alias reference is internal" 0 "" 'FROM node:22-slim@%s AS Base\nFROM base AS dev\nFROM BASE AS prod\n' "$D"
df "FROM dev after FROM base AS dev is internal" 0 "" 'FROM node:22-slim@%s AS base\nFROM base AS dev\nFROM dev AS x\n' "$D"
df "alias registered from an internal FROM" 0 "" 'FROM node:22-slim@%s AS base\nFROM base AS dev\nFROM dev AS x\nFROM x\n' "$D"
df "FROM with a space and no image fails" 1 "no image reference" 'FROM \n'
df "bare FROM fails" 1 "case.Dockerfile:1: FROM has no image reference" 'FROM\n'
df "FROM with a flag and no image fails" 1 "no image reference" 'FROM --platform=linux/amd64\n'
df "CRLF pinned" 0 "" 'FROM node:22-slim@%s AS base\r\nFROM base AS dev\r\n' "$D"
df "CRLF unpinned" 1 "case.Dockerfile:2:" 'FROM node:22-slim@%s AS base\r\nFROM node:22-slim\r\n' "$D"
df "BOM before the first FROM, pinned" 0 "" '\xef\xbb\xbfFROM node:22-slim@%s\n' "$D"
df "BOM before the first FROM, unpinned" 1 "case.Dockerfile:1:" '\xef\xbb\xbfFROM node:22-slim\n'

df "non-hex first character in a 64-character field fails" 1 "case.Dockerfile:1:" 'FROM node:22@sha256:g%s\n' "${H%?}"
df "@ inside the digest field fails" 1 "case.Dockerfile:1:" 'FROM node:22@sha256:%s@%s\n' "${H%??????????????}" "${H%??????????????}"
df "FROM with a continuation fails" 1 "case.Dockerfile:1:" 'FROM \\\n  node:22-slim\n'
df "FROM directly followed by a continuation fails" 1 "case.Dockerfile:1:" 'FROM\\\n  node:22-slim\n'
df "RUN with a continuation is not FROM" 0 "" 'RUN echo \\\n  FROMAGE\n'
printf 'FROM node:22-slim@%s AS base\n' "$D" > "$tmp/good.Dockerfile"
printf 'FROM node:22-slim AS prod\n' > "$tmp/bad.Dockerfile"
expect "several Dockerfiles: an offender in the second is reported" 1 "bad.Dockerfile:1:" "$tmp/good.Dockerfile" "$tmp/bad.Dockerfile"
expect "missing file is a usage error" 2 "file not found" "$tmp/nope.Dockerfile"

if [ "$section" = dockerfile ]; then
  echo "Result: $pass cases passed"
  [ "$fails" -eq 0 ] && exit 0
  echo "Result: $pass cases passed, $fails failed"
  exit 1
fi

# --- Compose, resolved by docker compose config ---
UNPINNED='FROM node:22-slim\n'
PINNED="FROM node:22-slim@$D\n"
n=0
# fx <name>: fresh fixture dir $fx with pinned Dockerfiles at ./Dockerfile,
# ./backend/Dockerfile, ./worker/Dockerfile and ./worker/Dockerfile.alt
fx() {
  n=$((n + 1))
  fx="$tmp/fx$n"
  mkdir -p "$fx/backend" "$fx/worker"
  for d in Dockerfile backend/Dockerfile worker/Dockerfile worker/Dockerfile.alt; do
    printf "$PINNED" > "$fx/$d"
  done
}
# cc <name> <want-exit> <sub> <compose-text>: compose case in the current $fx
cc() {
  local name="$1" want="$2" sub="$3"
  printf '%s\n' "$4" > "$fx/compose.yml"
  expect "compose: $name" "$want" "$sub" "$fx/compose.yml"
}

fx; cc "pinned image" 0 "" "services:
  db:
    image: postgres:16-alpine@$D"
fx; cc "digest without a tag fails" 1 "service db:" "services:
  db:
    image: postgres@$D"
fx; cc "interpolated registry with a digest fails" 1 "service db:" "services:
  db:
    image: \${REG}/postgres:16@$D"
fx; cc "digest with trailing characters fails" 1 "service db:" "services:
  db:
    image: postgres:16@${D}zz"
fx; cc "tag-only image fails with the service name" 1 "service db: image \"postgres:16-alpine\"" "services:
  db:
    image: postgres:16-alpine"
fx; cc "interpolated tag with a digest fails" 1 "service db:" "services:
  db:
    image: postgres:\${TAG}@$D"
fx; cc "63 hex digits fail" 1 "service db:" "services:
  db:
    image: postgres:16@sha256:${H%?}"
fx; cc "interpolated image fails" 1 "service db:" 'services:
  db:
    image: ${IMG}'
fx; cc "required-variable interpolation needs no environment" 0 "" "services:
  db:
    image: postgres:16@$D
    environment:
      A: \${A:?required}"
fx; cc "quoted key, tag-only, fails" 1 "service db:" 'services:
  db:
    "image": postgres:16'
fx; cc "quoted key, pinned, passes" 0 "" "services:
  db:
    \"image\": postgres:16@$D"
fx; cc "spaced key, tag-only, fails" 1 "service db:" 'services:
  db:
    image : postgres:16'
fx; cc "flow mapping, tag-only, fails" 1 "service db:" 'services:
  db: {image: postgres:16}'
fx; cc "flow mapping, pinned, passes" 0 "" "services: {db: {image: \"postgres:16@$D\"}}"
fx; cc "merged anchor, tag-only, fails" 1 "service db:" 'x-d: &d {image: postgres:16}
services:
  db:
    <<: *d'
fx; cc "list item under a merged anchor, tag-only, fails" 1 "service db:" 'x-d: &d
  image: postgres:16
services:
  db:
    <<: [*d]'
fx; cc "explicit key, tag-only, fails" 1 "service db:" 'services:
  db:
    ? image
    : postgres:16'
fx; cc "tagged key, tag-only, fails" 1 "service db:" 'services:
  db:
    !!str image: postgres:16'
fx; cc "hash inside a quoted label does not hide the image" 1 "service db:" 'services:
  db:
    labels: ["a#b", "c"]
    image: postgres:16'
fx; cc "hash inside a quoted label, pinned, passes" 0 "" "services:
  db:
    labels: [\"a # image: x\"]
    image: postgres:16@$D"
fx; cc "profile service, tag-only, fails" 1 "service tools:" 'services:
  tools:
    profiles: [debug]
    image: busybox:1'
fx; cc "build: ./worker, pinned Dockerfile, passes" 0 "" 'services:
  w:
    build: ./worker'
fx; printf "$UNPINNED" > "$fx/worker/Dockerfile"; cc "build: ./worker, unpinned Dockerfile, fails with file and line" 1 "worker/Dockerfile:1:" 'services:
  w:
    build: ./worker'
fx; printf "$UNPINNED" > "$fx/worker/Dockerfile"; cc "context alone, unpinned Dockerfile, fails" 1 "worker/Dockerfile:1:" 'services:
  w:
    build:
      context: ./worker'
fx; printf "$UNPINNED" > "$fx/worker/Dockerfile"; cc "context with dockerfile: Dockerfile, unpinned, fails" 1 "worker/Dockerfile:1:" 'services:
  w:
    build:
      context: ./worker
      dockerfile: Dockerfile'
fx; printf "$UNPINNED" > "$fx/Dockerfile"; cc "root Dockerfile is not confused with backend/Dockerfile" 0 "" 'services:
  b:
    build:
      context: .
      dockerfile: backend/Dockerfile'
fx; printf "$UNPINNED" > "$fx/Dockerfile"; cc "root Dockerfile unpinned, fails" 1 "Dockerfile:1:" 'services:
  b:
    build: .'
fx; printf "$UNPINNED" > "$fx/worker/Dockerfile.alt"; cc "dockerfile named like another file in another context, fails" 1 "worker/Dockerfile.alt:1:" 'services:
  m:
    build:
      context: ./worker
      dockerfile: Dockerfile.alt'
fx; printf "$UNPINNED" > "$fx/worker/Dockerfile.alt"; cc "only the Dockerfile that is used is read" 0 "" 'services:
  m:
    build:
      context: ./worker'
fx; printf "$UNPINNED" > "$fx/extra.Dockerfile"; cc "a new service with its own unpinned Dockerfile fails" 1 "extra.Dockerfile:1:" 'services:
  a:
    build: ./worker
  fresh:
    build:
      context: .
      dockerfile: extra.Dockerfile'
fx; printf "$UNPINNED" > "$fx/worker/Dockerfile"
printf 'services:\n  a:\n    build: ./worker\n  b:\n    build: ./worker\n' > "$fx/compose.yml"
out="$(bash "$guard" "$fx/compose.yml" 2>&1 || true)"
if [ "$(printf '%s\n' "$out" | grep -c 'worker/Dockerfile:1:')" -eq 1 ]; then pass=$((pass + 1)); else echo "FAIL compose: a Dockerfile shared by two services is reported once: $out"; fails=$((fails + 1)); fi
fx; printf "$PINNED" > "$fx/extra.Dockerfile"; cc "a new service with its own pinned Dockerfile passes" 0 "" 'services:
  a:
    build: ./worker
  fresh:
    build:
      context: .
      dockerfile: extra.Dockerfile'
fx; mkdir "$fx-out"; printf "$PINNED" > "$fx-out/Dockerfile"; cc "existing Dockerfile outside the compose directory fails" 1 "is outside" "services:
  o:
    build:
      context: .
      dockerfile: ../fx$n-out/Dockerfile"
fx; mkdir "$fx-evil"; printf "$PINNED" > "$fx-evil/Dockerfile"; cc "sibling directory sharing the compose directory prefix is outside" 1 "is outside" "services:
  o:
    build: ../fx$n-evil"
fx; cc "context outside the compose directory fails" 1 "is outside" 'services:
  o:
    build: ../elsewhere'
fx; mkdir "$fx-out"; cc "outside context with an absolute inside Dockerfile fails" 1 "build context" "services:
  o:
    build:
      context: ../fx$n-out
      dockerfile: $fx/worker/Dockerfile"
fx; mkdir "$fx-out"; printf "$PINNED" > "$fx-out/Dockerfile"; ln -s "$fx-out/Dockerfile" "$fx/worker/Linked"; cc "symlinked Dockerfile pointing outside fails" 1 "is outside" 'services:
  o:
    build:
      context: ./worker
      dockerfile: Linked'
fx; mkdir "$fx-out"; printf "$PINNED" > "$fx-out/Dockerfile"; ln -s "$fx-out" "$fx/linked"; cc "symlinked context pointing outside fails" 1 "is outside" 'services:
  o:
    build: ./linked'
fx; ln -s Dockerfile.alt "$fx/worker/Linked"; cc "symlinked Dockerfile pointing inside is followed, pinned" 0 "" 'services:
  o:
    build:
      context: ./worker
      dockerfile: Linked'
fx; printf "$UNPINNED" > "$fx/worker/Dockerfile.alt"; ln -s Dockerfile.alt "$fx/worker/Linked"; cc "symlinked Dockerfile pointing inside is followed, unpinned" 1 "worker/Linked:1:" 'services:
  o:
    build:
      context: ./worker
      dockerfile: Linked'
fx; ln -s worker "$fx/linked"; cc "symlinked context pointing inside is followed, pinned" 0 "" 'services:
  o:
    build: ./linked'
fx; printf "$UNPINNED" > "$fx/worker/Dockerfile"; ln -s worker "$fx/linked"; cc "symlinked context pointing inside is followed, unpinned" 1 "linked/Dockerfile:1:" 'services:
  o:
    build: ./linked'
fx; printf 'services:\n  o:\n    build: ./worker\n' > "$fx/compose.yml"; ln -s "$fx" "$fx-link"
expect "compose: compose file reached through a symlinked directory passes" 0 "" "$fx-link/compose.yml"
fx; cc "remote context fails" 1 "is not a local directory" 'services:
  o:
    build: https://example.com/repo.git#main'
fx; cc "missing Dockerfile fails" 1 "does not exist" 'services:
  o:
    build:
      context: ./worker
      dockerfile: Nope'
fx; cc "dockerfile_inline fails" 1 "dockerfile_inline" 'services:
  o:
    build:
      context: ./worker
      dockerfile_inline: |
        FROM node:22-slim'
fx; cc "dockerfile_inline with an extra dockerfile key fails" 1 "dockerfile_inline" 'services:
  o:
    build:
      context: ./worker
      dockerfile: Dockerfile
      dockerfile_inline: |
        FROM alpine'
fx; cc "additional_contexts docker-image fails" 1 "additional_contexts" 'services:
  o:
    build:
      context: ./worker
      additional_contexts:
        base: docker-image://alpine:3'
fx; cc "additional_contexts local path passes" 0 "" 'services:
  o:
    build:
      context: ./worker
      additional_contexts:
        base: ./backend'
fx; cc "additional_contexts remote URL fails" 1 "additional_contexts \"base\"" 'services:
  o:
    build:
      context: ./worker
      additional_contexts:
        base: https://example.com/repo.git'
fx; cc "additional_contexts oci-layout fails" 1 "additional_contexts \"base\"" 'services:
  o:
    build:
      context: ./worker
      additional_contexts:
        base: oci-layout:///tmp/layout'
fx; cc "additional_contexts service: form passes" 0 "" "services:
  o:
    build:
      context: ./worker
      additional_contexts:
        base: service:db
  db:
    image: postgres:16@$D"
fx; cc "image next to build fails" 1 "service o: image \"registry.example/app:1\" next to build" 'services:
  o:
    image: registry.example/app:1
    build: ./worker'
fx; cc "image next to build with pull_policy: always fails" 1 "next to build" 'services:
  o:
    image: registry.example/app:1
    pull_policy: always
    build: ./worker'
fx; cc "pinned image next to build fails" 1 "next to build" "services:
  o:
    image: registry.example/app:1@$D
    build: ./worker"
fx; cc "service without image and build is an offender" 1 "service o:" 'services:
  o:
    restart: always'
fx; cc "invalid YAML is exit 2, never a pass" 2 "docker compose config failed" 'services: [unclosed'
fx; printf 'services:\n  db:\n    image: postgres:16@%s\n' "$D" > "$fx/compose.yml"
rc=0; out="$(env PATH=/nonexistent "$BASH" "$guard" "$fx/compose.yml" 2>&1)" || rc=$?
if [ "$rc" -eq 2 ] && [[ "$out" == *"docker compose is required"* ]]; then pass=$((pass + 1)); else echo "FAIL compose: no docker is exit 2: $rc $out"; fails=$((fails + 1)); fi
fx; cc "services: {} is an offender" 1 "no services" 'services: {}'
fx; cc "a file with only name: is an offender" 1 "no services" 'name: x'

# --- Compose output and reader that real Compose never gives ---
# Every case runs against a compose file with a tag-only image, so a reader
# that lets the output through shows up as a false pass.
fakebin="$tmp/fakebin"
mkdir -p "$fakebin"
printf '#!/bin/sh\n[ "$2" = version ] && exit 0\nprintf "%%s" "$FAKE_COMPOSE_OUTPUT"\n' > "$fakebin/docker"
chmod +x "$fakebin/docker"
TAGONLY='services:\n  db:\n    image: postgres:16\n'
# fake <name> <want-exit> <sub> <output of the fake `docker compose config`,
# with @FX@ standing for the fixture directory>
fake() {
  fx
  printf "$TAGONLY" > "$fx/compose.yml"
  FAKE_COMPOSE_OUTPUT="${4//@FX@/$fx}" PATH="$fakebin:$PATH" expect "fake compose: $1" "$2" "$3" "$fx/compose.yml"
}
fake "empty object" 1 "no services" '{}'
fake "empty services" 1 "no services" '{"services":{}}'
fake "null services" 1 "no services" '{"services":null}'
fake "empty services list" 1 "no services" '{"services":[]}'
fake "services list with an item" 1 "no services" '{"services":["db"]}'
fake "services under a capitalised key" 1 "no services" '{"Services":{"db":{"image":"postgres:16"}}}'
fake "services one level down" 1 "no services" '{"project":{"services":{"db":{"image":"postgres:16"}}}}'
fake "top-level list" 1 "no services" '[]'
fake "malformed output is exit 2" 2 "could not read" 'not json'
fake "empty output is exit 2" 2 "could not read" ''
fake "control: tag-only image is reported" 1 "service db:" '{"services":{"db":{"image":"postgres:16"}}}'
fake "control: pinned image passes" 0 "" "{\"services\":{\"db\":{\"image\":\"postgres:16@$D\"}}}"
fake "additional_contexts target: form passes" 0 "" '{"services":{"o":{"build":{"context":"@FX@/worker","additional_contexts":{"t":"target:other"}}}}}'
fake "additional_contexts relative form fails" 1 "additional_contexts \"t\"" '{"services":{"o":{"build":{"context":"@FX@/worker","additional_contexts":{"t":"other"}}}}}'
fake "additional_contexts null value fails" 1 "additional_contexts \"t\"" '{"services":{"o":{"build":{"context":"@FX@/worker","additional_contexts":{"t":null}}}}}'

# stub <body>: fresh $stubbin holding a python3 that runs <body>
stub() {
  stubbin="$tmp/stub$n"
  mkdir -p "$stubbin"
  printf '#!/bin/sh\n%s\n' "$1" > "$stubbin/python3"
  chmod +x "$stubbin/python3"
}
fx; printf "$TAGONLY" > "$fx/compose.yml"; stub 'cat > /dev/null; exit 0'
PATH="$stubbin:$PATH" expect "compose: a python3 that reads stdin and prints nothing is exit 2" 2 "without a RESOLVED line" "$fx/compose.yml"
fx; printf "$TAGONLY" > "$fx/compose.yml"; stub 'exit 0'
PATH="$stubbin:$PATH" expect "compose: a python3 that exits 0 at once is exit 2" 2 "" "$fx/compose.yml"
fx; printf "$TAGONLY" > "$fx/compose.yml"; stub 'cat > /dev/null; echo "RESOLVED 0"'
PATH="$stubbin:$PATH" expect "compose: RESOLVED 0 is exit 2" 2 "without a RESOLVED line" "$fx/compose.yml"
fx; printf "$TAGONLY" > "$fx/compose.yml"; stub 'cat > /dev/null; echo "RESOLVED 1"; exit 1'
PATH="$stubbin:$PATH" expect "compose: a failing python3 after RESOLVED is exit 2" 2 "could not read" "$fx/compose.yml"

fx; printf "$TAGONLY" > "$fx/compose.yml"
rc=0; out="$(env PATH="$fakebin" "$BASH" "$guard" "$fx/compose.yml" 2>&1)" || rc=$?
if [ "$rc" -eq 2 ] && [[ "$out" == *"python3 is required"* ]]; then pass=$((pass + 1)); else echo "FAIL compose: no python3 is exit 2: $rc $out"; fails=$((fails + 1)); fi

fx; printf 'services:\n  db:\n    image: postgres:16@%s\n' "$D" > "$fx/compose.yml"
rc=0; out="$(bash "$guard" "$fx/compose.yml" "$tmp/bad.Dockerfile" 2>&1)" || rc=$?
if [ "$rc" -eq 1 ] && [[ "$out" == *"bad.Dockerfile:1:"* ]]; then pass=$((pass + 1)); else echo "FAIL compose and Dockerfile arguments together: $rc $out"; fails=$((fails + 1)); fi

# --- repository tree ---
rc=0
out="$(cd "$here/.." && bash "$guard" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then
  pass=$((pass + 1))
else
  echo "FAIL repository tree is pinned: $out"
  fails=$((fails + 1))
fi

if [ "$fails" -eq 0 ]; then
  echo "Result: $pass cases passed"
else
  echo "Result: $pass cases passed, $fails failed"
  exit 1
fi
