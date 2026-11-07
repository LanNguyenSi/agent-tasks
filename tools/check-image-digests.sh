#!/usr/bin/env bash
# check-image-digests.sh
#
# Guard: every external base image of the production images must be pinned by
# digest (`name:tag@sha256:<64 hex>`), so a base-image change arrives as a
# reviewed Renovate pull request and not silently through `build --pull` on
# the next deploy.
#
# Checked: every `FROM` in a Dockerfile (a `FROM <earlier stage alias>` and
# `FROM scratch` are internal and skipped) and every `image:` key of a compose
# file. Comment lines, blank lines and a trailing `# comment` are ignored; a
# `--platform=` flag, quotes around a compose value and `AS <name>` are parsed.
# A reference that interpolates a variable (`${...}`) cannot be pinned and is
# reported like an unpinned one.
#
# Usage: tools/check-image-digests.sh [file ...]
#   no arguments: backend/Dockerfile frontend/Dockerfile Dockerfile.migrate
#                 docker-compose.prod.yml, relative to the repository root.
#   A file ending in .yml or .yaml is read as compose, anything else as a
#   Dockerfile.
# Exit 0 when all are pinned, 1 with `file:line: message` per offender, 2 on a
# usage error (missing file).
set -eo pipefail

if [ "$#" -eq 0 ]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  set -- "$root/backend/Dockerfile" "$root/frontend/Dockerfile" \
    "$root/Dockerfile.migrate" "$root/docker-compose.prod.yml"
fi

status=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "$f: file not found" >&2
    exit 2
  fi
  case "$f" in
    *.yml | *.yaml) mode=compose ;;
    *) mode=dockerfile ;;
  esac
  out="$(awk -v file="$f" -v mode="$mode" '
    function check(ref, line) {
      if (ref ~ /^[^@]+:[^@:\/]+@sha256:[0-9a-f]{64}$/ && ref !~ /\$/) return
      printf "%s:%d: image \"%s\" is not pinned as name:tag@sha256:<digest>\n", file, line, ref
      bad = 1
    }
    {
      sub(/\r$/, "")
      s = $0
      sub(/^[ \t]+/, "", s)
      if (s == "" || s ~ /^#/) next
      if (mode == "compose") {
        if (s !~ /^image:[ \t]*/) next
        sub(/^image:[ \t]*/, "", s)
        if (s ~ /^"/) { sub(/^"/, "", s); sub(/".*$/, "", s) }
        else if (s ~ /^\x27/) { sub(/^\x27/, "", s); sub(/\x27.*$/, "", s) }
        else { sub(/[ \t]+#.*$/, "", s); sub(/[ \t]+$/, "", s) }
        check(s, NR)
        next
      }
      if (toupper(substr(s, 1, 5)) != "FROM " && toupper(substr(s, 1, 5)) != "FROM\t") next
      n = split(s, w, /[ \t]+/)
      i = 2
      while (i <= n && w[i] ~ /^--/) i++
      ref = w[i]
      if (ref == "") next
      if (ref == "scratch" || (tolower(ref) in stage)) {
        if (toupper(w[i + 1]) == "AS" && w[i + 2] != "") stage[tolower(w[i + 2])] = 1
        next
      }
      check(ref, NR)
      if (toupper(w[i + 1]) == "AS" && w[i + 2] != "") stage[tolower(w[i + 2])] = 1
    }
    END { exit bad }
  ' "$f")" || rc=$?
  if [ "${rc:-0}" -ne 0 ]; then
    printf '%s\n' "$out"
    status=1
  fi
  rc=0
done
exit "$status"
