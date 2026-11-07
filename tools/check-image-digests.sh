#!/usr/bin/env bash
# check-image-digests.sh
#
# Guard: every external base image of the production images must be pinned by
# digest (`name:tag@sha256:<64 hex>`), so a base-image change arrives as a
# reviewed Renovate pull request and not silently through `build --pull` on
# the next deploy.
#
# Checked:
#   - Dockerfile: every `FROM` (case-insensitive keyword, space or tab after
#     it, `--platform=` style flags and `AS <name>` parsed, a leading UTF-8 BOM
#     and CRLF line endings tolerated). A `FROM <earlier stage alias>` (alias
#     compared case-insensitively) and `FROM scratch` are internal and skipped.
#   - Compose file (.yml or .yaml): every `image:` key. Fails closed: a line
#     where the key `image` appears quoted (`"image":`), with a space before
#     the colon (`image :`) or inside a flow mapping (`{image: x}`, also behind
#     an anchor or `services: {db: {...}}`) is an offender, because this
#     awk parser reads only the plain block form `image: <value>` (value plain
#     or quoted, optional trailing `# comment`). A nested key that is merely
#     named `image` (for example under `environment:`) is therefore also
#     reported; that false failure is accepted (the safe direction).
#   - Compose `build.dockerfile:` values must name one of the other files
#     given on the command line (matched as a path suffix), and
#     `dockerfile_inline` is refused, so an image build cannot bypass the
#     checked Dockerfiles.
# A reference that interpolates a variable (`$`) cannot be pinned and is
# reported like an unpinned one.
#
# Out of scope: a Dockerfile keyword split across a line continuation
# (`FR\` + `OM x`), `COPY --from=<external image>`, and compose files other
# than the ones listed. The digest length is checked with a length test, not a
# `{64}` interval, so the script also runs on awks without regex intervals.
#
# Usage: tools/check-image-digests.sh [file ...]
#   no arguments: backend/Dockerfile frontend/Dockerfile Dockerfile.migrate
#                 docker-compose.prod.yml, relative to the repository root.
# Exit 0 when all are pinned, 1 with `file:line: message` per offender, 2 on a
# usage error (missing file).
set -eo pipefail

if [ "$#" -eq 0 ]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  set -- "$root/backend/Dockerfile" "$root/frontend/Dockerfile" \
    "$root/Dockerfile.migrate" "$root/docker-compose.prod.yml"
fi

for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "$f: file not found" >&2
    exit 2
  fi
done

all="$(IFS="|"; printf '%s' "$*")"
status=0
for f in "$@"; do
  case "$f" in
    *.yml | *.yaml) mode=compose ;;
    *) mode=dockerfile ;;
  esac
  rc=0
  out="$(awk -v file="$f" -v mode="$mode" -v all="$all" -v bom="$(printf '\357\273\277')" '
    function pinned(ref,    p, rest, hex) {
      p = index(ref, "@")
      if (p == 0 || index(ref, "$") > 0) return 0
      rest = substr(ref, p + 1)
      if (substr(ref, 1, p - 1) !~ /^[^@]+:[^@:\/]+$/) return 0
      if (substr(rest, 1, 7) != "sha256:") return 0
      hex = substr(rest, 8)
      return (length(hex) == 64 && hex ~ /^[0-9a-f]+$/)
    }
    function check(ref, line) {
      if (pinned(ref)) return
      printf "%s:%d: image \"%s\" is not pinned as name:tag@sha256:<digest>\n", file, line, ref
      bad = 1
    }
    function unquote(v) {
      if (v ~ /^"/) { sub(/^"/, "", v); sub(/".*$/, "", v) }
      else if (v ~ /^\047/) { sub(/^\047/, "", v); sub(/\047.*$/, "", v) }
      else sub(/[ \t]+$/, "", v)
      return v
    }
    function listed(v,    n, a, i) {
      sub(/^\.\//, "", v)
      n = split(all, a, "|")
      for (i = 1; i <= n; i++)
        if (a[i] == v || (length(a[i]) > length(v) && substr(a[i], length(a[i]) - length(v)) == "/" v)) return 1
      return 0
    }
    {
      sub(/\r$/, "")
      s = $0
      if (NR == 1 && substr(s, 1, length(bom)) == bom) s = substr(s, length(bom) + 1)
      sub(/^[ \t]+/, "", s)
      if (mode == "compose") {
        if (s ~ /^#/) next
        c = s
        sub(/[ \t]+#.*$/, "", c)
        if (c ~ /(^|[{,][ \t]*)["\047]?dockerfile_inline["\047]?[ \t]*:/) {
          printf "%s:%d: dockerfile_inline is not allowed (build from a checked Dockerfile)\n", file, NR
          bad = 1
        }
        if (c ~ /(^|[{,][ \t]*)["\047]?dockerfile["\047]?[ \t]*:/) {
          if (c ~ /^dockerfile:[ \t]*[^ \t]/) {
            v = c; sub(/^dockerfile:[ \t]*/, "", v); v = unquote(v)
            if (!listed(v)) {
              printf "%s:%d: dockerfile \"%s\" is not among the checked files\n", file, NR, v
              bad = 1
            }
          } else {
            printf "%s:%d: dockerfile key in a form this guard cannot read\n", file, NR
            bad = 1
          }
        }
        if (c ~ /(^|[{,][ \t]*)["\047]?image["\047]?[ \t]*:/) {
          if (c ~ /^image:[ \t]*[^ \t]/) {
            v = c; sub(/^image:[ \t]*/, "", v)
            check(unquote(v), NR)
          } else {
            printf "%s:%d: image key in a form this guard cannot read (quoted, spaced, flow mapping or empty value)\n", file, NR
            bad = 1
          }
        }
        next
      }
      if (toupper(substr(s, 1, 4)) != "FROM" || substr(s, 5, 1) !~ /[ \t]/) next
      n = split(s, w, /[ \t]+/)
      i = 2
      while (i <= n && w[i] ~ /^--/) i++
      ref = w[i]
      if (ref == "") next
      isalias = (toupper(w[i + 1]) == "AS" && w[i + 2] != "")
      if (ref == "scratch" || (tolower(ref) in stage)) {
        if (isalias) stage[tolower(w[i + 2])] = 1
        next
      }
      check(ref, NR)
      if (isalias) stage[tolower(w[i + 2])] = 1
    }
    END { exit bad }
  ' "$f")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$out"
    status=1
  fi
done
exit "$status"
