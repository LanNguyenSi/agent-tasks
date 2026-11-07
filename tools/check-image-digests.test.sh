#!/usr/bin/env bash
# Tests for tools/check-image-digests.sh. Run: bash tools/check-image-digests.test.sh
set -eo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$here/check-image-digests.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
D=sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
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
    echo "ok   $name"
  fi
}

printf 'FROM node:22-slim@%s AS base\nFROM base AS dev\nFROM scratch\n' "$D" > "$tmp/pinned.Dockerfile"
expect "pinned dockerfile with internal stages" 0 "" "$tmp/pinned.Dockerfile"

printf 'FROM node:22-slim AS base\n' > "$tmp/unpinned.Dockerfile"
expect "tag-only FROM fails with file and line" 1 "unpinned.Dockerfile:1:" "$tmp/unpinned.Dockerfile"

printf 'FROM node:22-slim@%s AS base\nFROM node:22-slim AS prod\n' "$D" > "$tmp/second.Dockerfile"
expect "second unpinned FROM reports its line" 1 "second.Dockerfile:2:" "$tmp/second.Dockerfile"

printf 'FROM node@%s\n' "$D" > "$tmp/notag.Dockerfile"
expect "digest without tag fails" 1 "notag.Dockerfile:1:" "$tmp/notag.Dockerfile"

printf 'FROM node:22-slim@sha256:abc\n' > "$tmp/short.Dockerfile"
expect "truncated digest fails" 1 "short.Dockerfile:1:" "$tmp/short.Dockerfile"

printf 'FROM base AS dev\n' > "$tmp/internal.Dockerfile"
expect "FROM of an undeclared name is external and fails" 1 "internal.Dockerfile:1:" "$tmp/internal.Dockerfile"

printf '# FROM node:22-slim\n  # image: x\nFROM --platform=linux/amd64 node:22-slim@%s AS base\n' "$D" > "$tmp/comment.Dockerfile"
expect "commented line and --platform flag" 0 "" "$tmp/comment.Dockerfile"

printf 'FROM ${BASE}\n' > "$tmp/var.Dockerfile"
expect "variable reference fails" 1 "var.Dockerfile:1:" "$tmp/var.Dockerfile"

printf 'FROM node:${NODE_TAG}@%s\n' "$D" > "$tmp/interp.Dockerfile"
expect "interpolated tag with a digest fails" 1 "interp.Dockerfile:1:" "$tmp/interp.Dockerfile"

printf 'services:\n  db:\n    image: postgres:16-alpine@%s\n' "$D" > "$tmp/pinned.yml"
expect "pinned compose image" 0 "" "$tmp/pinned.yml"

printf 'services:\n  db:\n    image: postgres:16-alpine\n' > "$tmp/unpinned.yml"
expect "tag-only compose image fails with file and line" 1 "unpinned.yml:3:" "$tmp/unpinned.yml"

printf 'services:\n  db:\n    # image: postgres:16-alpine\n    image: "postgres:16-alpine@%s"  # pinned\n    build: .\n' "$D" > "$tmp/quoted.yml"
expect "commented key, quotes and trailing comment" 0 "" "$tmp/quoted.yml"

printf "services:\n  db:\n    image: 'postgres:16-alpine'\n" > "$tmp/single.yml"
expect "single-quoted tag-only image fails" 1 "single.yml:3:" "$tmp/single.yml"

expect "missing file is a usage error" 2 "file not found" "$tmp/nope.Dockerfile"

(cd "$here/.." && bash "$guard") > /dev/null 2>&1 && echo "ok   repository tree is pinned" || { echo "FAIL repository tree is pinned"; fails=$((fails + 1)); }

[ "$fails" -eq 0 ]
