#!/usr/bin/env bash
# Tests for tools/check-image-digests.sh. Run: bash tools/check-image-digests.test.sh
# Prints one line per failure and a final `Result: N cases passed` (exit 0) or
# `Result: N cases passed, M failed` (exit 1).
set -eo pipefail
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
# cf <name> <want-exit> <sub> <printf-format> [args]: a compose case
cf() {
  local name="$1" want="$2" sub="$3"; shift 3
  printf "$@" > "$tmp/case.yml"
  expect "compose: $name" "$want" "$sub" "$tmp/case.yml"
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
df "FROM with no image is skipped" 0 "" 'FROM \n'
df "CRLF pinned" 0 "" 'FROM node:22-slim@%s AS base\r\nFROM base AS dev\r\n' "$D"
df "CRLF unpinned" 1 "case.Dockerfile:2:" 'FROM node:22-slim@%s AS base\r\nFROM node:22-slim\r\n' "$D"
df "BOM before the first FROM, pinned" 0 "" '\xef\xbb\xbfFROM node:22-slim@%s\n' "$D"
df "BOM before the first FROM, unpinned" 1 "case.Dockerfile:1:" '\xef\xbb\xbfFROM node:22-slim\n'

# --- Compose ---
cf "pinned image" 0 "" 'services:\n  db:\n    image: postgres:16-alpine@%s\n' "$D"
cf "tag-only image fails with file and line" 1 "case.yml:3:" 'services:\n  db:\n    image: postgres:16-alpine\n'
cf "commented key, double quotes, trailing comment" 0 "" 'services:\n  db:\n    # image: postgres:16-alpine\n    image: "postgres:16-alpine@%s"  # pinned\n    build: .\n' "$D"
cf "single-quoted pinned" 0 "" "services:\n  db:\n    image: 'postgres:16-alpine@%s'\n" "$D"
cf "unquoted pinned with trailing comment" 0 "" 'services:\n  db:\n    image: postgres:16-alpine@%s # base\n' "$D"
cf "single-quoted tag-only fails" 1 "case.yml:3:" "services:\n  db:\n    image: 'postgres:16-alpine'\n"
cf "double-quoted tag-only fails" 1 "case.yml:3:" 'services:\n  db:\n    image: "postgres:16-alpine"\n'
cf "CRLF pinned" 0 "" 'services:\r\n  db:\r\n    image: postgres:16-alpine@%s\r\n' "$D"
cf "CRLF unpinned" 1 "case.yml:3:" 'services:\r\n  db:\r\n    image: postgres:16-alpine\r\n'
cf "63 hex digits fail" 1 "case.yml:3:" 'services:\n  db:\n    image: postgres:16@sha256:%s\n' "${H%?}"
cf "space before the colon fails closed" 1 "case.yml:3:" 'services:\n  db:\n    image : postgres:16-alpine\n'
cf "double-quoted key fails closed" 1 "case.yml:3:" 'services:\n  db:\n    "image": postgres:16-alpine\n'
cf "single-quoted key fails closed" 1 "case.yml:3:" "services:\n  db:\n    'image': postgres:16-alpine\n"
cf "flow mapping fails closed" 1 "case.yml:2:" 'services:\n  db: {image: postgres:16-alpine}\n'
cf "flow mapping with a pinned image still fails closed" 1 "case.yml:2:" 'services:\n  db: {image: postgres:16-alpine@%s}\n' "$D"
cf "services as flow mapping fails closed" 1 "case.yml:1:" 'services: {db: {image: postgres:16-alpine}}\n'
cf "anchor with flow mapping fails closed" 1 "case.yml:1:" 'x-d: &d {image: postgres:16-alpine}\nservices:\n  db:\n    <<: *d\n'
cf "flow mapping behind a comma fails closed" 1 "case.yml:2:" 'services:\n  db: {build: ., image: postgres:16-alpine}\n'
cf "empty image value fails closed" 1 "case.yml:3: image key in a form this guard cannot read" 'services:\n  db:\n    image:\n      postgres:16-alpine\n'
cf "flow mapping in a comment is ignored" 0 "" '# x: {image: postgres}\nservices:\n  db:\n    image: postgres:16@%s\n' "$D"
cf "nested environment image: is a tolerated false failure" 1 "case.yml:5:" 'services:\n  db:\n    image: postgres:16@%s\n    environment:\n      image: foo\n' "$D"
printf 'FROM node:22-slim@%s\n' "$D" > "$tmp/case.Dockerfile"
printf 'services:\n  a:\n    build:\n      dockerfile: ./case.Dockerfile\n' > "$tmp/case.yml"
expect "dockerfile among the checked files" 0 "" "$tmp/case.Dockerfile" "$tmp/case.yml"
cf "dockerfile not among the checked files" 1 "case.yml:4: dockerfile \"other/Dockerfile\"" 'services:\n  a:\n    build:\n      dockerfile: other/Dockerfile\n'
cf "empty quoted dockerfile value fails" 1 "case.yml:4:" "services:\n  a:\n    build:\n      dockerfile: ''\n"
cf "empty dockerfile value fails closed" 1 "case.yml:4: dockerfile key in a form this guard cannot read" 'services:\n  a:\n    build:\n      dockerfile:\n        x\n'
cf "dockerfile in a flow mapping fails closed" 1 "case.yml:3:" 'services:\n  a:\n    build: {context: ., dockerfile: other/Dockerfile}\n'
cf "dockerfile_inline is refused" 1 "dockerfile_inline" 'services:\n  a:\n    build:\n      dockerfile_inline: |\n        FROM node\n'

printf 'FROM node:22-slim@%s\n' "$D" > "$tmp/ok.Dockerfile"
printf 'services:\n  a:\n    build:\n      context: .\n      dockerfile: sub/ok.Dockerfile\n' > "$tmp/c.yml"
mkdir -p "$tmp/sub" && cp "$tmp/ok.Dockerfile" "$tmp/sub/ok.Dockerfile"
expect "dockerfile matched as a path suffix of a given file" 0 "" "$tmp/sub/ok.Dockerfile" "$tmp/c.yml"
(cd "$tmp" && printf 'services:\n  a:\n    build:\n      dockerfile: ok.Dockerfile\n' > rel.yml && rc=0 && out="$(bash "$guard" ok.Dockerfile rel.yml 2>&1)" || rc=$?; [ "${rc:-0}" -eq 0 ]) && pass=$((pass + 1)) || { echo "FAIL dockerfile matched by exact relative path"; fails=$((fails + 1)); }
expect "dockerfile not matched when the file is not given" 1 "c.yml:5:" "$tmp/ok.Dockerfile" "$tmp/c.yml"

printf 'FROM node:22-slim@%s AS base\n' "$D" > "$tmp/good.Dockerfile"
printf 'FROM node:22-slim AS prod\n' > "$tmp/bad.Dockerfile"
expect "several files: an offender in the second is reported" 1 "bad.Dockerfile:1:" "$tmp/good.Dockerfile" "$tmp/bad.Dockerfile"
expect "missing file is a usage error" 2 "file not found" "$tmp/nope.Dockerfile"

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
