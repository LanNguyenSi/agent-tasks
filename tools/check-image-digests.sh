#!/usr/bin/env bash
# check-image-digests.sh
#
# Guard: every external base image of the production images must be pinned by
# digest (`name:tag@sha256:<64 hex>`), so a base-image change arrives as a
# reviewed Renovate pull request and not silently through `build --pull` on
# the next deploy.
#
# Compose file (argument ending in .yml or .yaml): Compose resolves its own
# YAML (anchors, merges, extends, includes, `build: ./dir` shorthand, every
# profile) via `docker compose config --format json --no-interpolate`, and a
# small python3 reader checks every service of that resolved output:
#   - no `build`: `image` must be `name:tag@sha256:<64 hex>`;
#   - with `build`: `image` next to it is an offender (with `pull_policy:
#     always`, `up` runs the pulled image and not the built one), the context
#     must be a local directory inside the compose file's directory,
#     `dockerfile_inline` is an offender, an `additional_contexts` value other
#     than a local path, `service:` or `target:` form is an offender, and the
#     Dockerfile (context joined with `dockerfile`, default `Dockerfile`) must
#     be a file inside the compose file's directory, symlinks followed; that
#     file is then scanned like a Dockerfile argument. The set of Dockerfiles
#     comes from the resolved output, so a new service is covered without
#     editing this script.
#   A compose file with no services at all is an offender. Offenders print as
#   `service <name>: <message>` or `no services: <message>`. Without arguments
#   the compose file is docker-compose.prod.yml at the repository root.
#
# Dockerfile (any other argument): every `FROM` (case-insensitive keyword,
# space or tab after it, `--platform=` style flags and `AS <name>` parsed, a
# leading UTF-8 BOM and CRLF line endings tolerated). `FROM <earlier stage
# alias>` (alias compared case-insensitively) and `FROM scratch` are internal.
# A `FROM` whose reference is missing or is a line continuation is an
# unreadable offender; a reference that interpolates a variable (`$`) cannot
# be pinned and is reported like an unpinned one. Offenders print as
# `file:line: message`.
#
# Out of scope: `COPY --from=<external image>`, the `# syntax=` directive, and
# a keyword split across a continuation (`FR\` + `OM x`).
#
# Usage: tools/check-image-digests.sh [compose.yml | Dockerfile ...]
# Exit 0 when all are pinned, 1 with an offender line each, 2 when a file is
# missing, docker compose or python3 is unavailable or fails, or the reader
# ends without its `RESOLVED <n>` line (never a pass).
set -eo pipefail

if [ "$#" -eq 0 ]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  set -- "$root/docker-compose.prod.yml"
fi

for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "$f: file not found" >&2
    exit 2
  fi
done

status=0

scan_dockerfile() {
  local f="$1" out rc=0
  out="$(awk -v file="$f" -v bom="$(printf '\357\273\277')" '
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
    {
      sub(/\r$/, "")
      s = $0
      if (NR == 1 && substr(s, 1, length(bom)) == bom) s = substr(s, length(bom) + 1)
      sub(/^[ \t]+/, "", s)
      if (toupper(substr(s, 1, 4)) != "FROM") next
      rest = substr(s, 5)
      if (rest ~ /^[ \t]*\\$/) {
        printf "%s:%d: FROM reference is on a continuation line, which this guard cannot read\n", file, NR
        bad = 1
        next
      }
      if (rest != "" && rest !~ /^[ \t]/) next
      n = split(s, w, /[ \t]+/)
      i = 2
      while (i <= n && w[i] ~ /^--/) i++
      ref = w[i]
      if (ref == "") {
        printf "%s:%d: FROM has no image reference\n", file, NR
        bad = 1
        next
      }
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
}

# Reads `docker compose config --format json` on stdin. Prints
# `OFFENDER<TAB>message` and `DOCKERFILE<TAB>path` lines and a final
# `RESOLVED <n>` line, or exits 3 unless `services` is a non-empty mapping.
read -r -d '' reader <<'PY' || true
import json, os, re, sys

root = os.path.realpath(sys.argv[1])
PIN = re.compile(r"[^@\s$]+:[^@:/\s$]+@sha256:[0-9a-f]{64}")

def inside(path):
    p = os.path.realpath(path)
    return p == root or p.startswith(root + os.sep)

def offender(name, msg):
    print("OFFENDER\tservice %s: %s" % (name, msg))

def plain_context(value):
    return isinstance(value, str) and (os.path.isabs(value) or value.startswith(("service:", "target:")))

data = json.load(sys.stdin)
services = data.get("services") if isinstance(data, dict) else None
if not isinstance(services, dict) or not services:
    sys.exit(3)
seen = set()
for name in sorted(services):
    svc = services[name] or {}
    build = svc.get("build")
    if build is None:
        image = svc.get("image")
        if not isinstance(image, str) or not PIN.fullmatch(image):
            offender(name, 'image "%s" is not pinned as name:tag@sha256:<digest>' % (image,))
        continue
    if "image" in svc:
        offender(name, 'image "%s" next to build is not allowed (with pull_policy: always, up runs the pulled image)' % (svc["image"],))
    if "dockerfile_inline" in build:
        offender(name, "dockerfile_inline is not allowed (build from a checked Dockerfile)")
    for key, value in sorted((build.get("additional_contexts") or {}).items()):
        if not plain_context(value):
            offender(name, 'additional_contexts "%s" is "%s", not a local path, service: or target: form' % (key, value))
    context = build.get("context")
    if not isinstance(context, str) or not os.path.isabs(context):
        offender(name, 'build context "%s" is not a local directory' % (context,))
        continue
    if not inside(context):
        offender(name, 'build context "%s" is outside "%s"' % (context, root))
        continue
    path = os.path.join(context, build.get("dockerfile") or "Dockerfile")
    if not inside(path):
        offender(name, 'Dockerfile "%s" is outside "%s"' % (path, root))
    elif not os.path.isfile(path):
        offender(name, 'Dockerfile "%s" does not exist' % path)
    elif path not in seen:
        seen.add(path)
        print("DOCKERFILE\t" + path)
print("RESOLVED %d" % len(services))
PY

scan_compose() {
  local f="$1" json lines kind payload rc=0
  if ! command -v docker > /dev/null 2>&1 || ! docker compose version > /dev/null 2>&1; then
    echo "$f: docker compose is required to resolve the compose file and is not available" >&2
    exit 2
  fi
  if ! command -v python3 > /dev/null 2>&1; then
    echo "$f: python3 is required and is not available" >&2
    exit 2
  fi
  if ! json="$(docker compose --profile '*' -f "$f" config --format json --no-interpolate 2> /dev/null)"; then
    echo "$f: docker compose config failed:" >&2
    docker compose --profile '*' -f "$f" config --format json --no-interpolate 2>&1 >/dev/null | sed 's/^/  /' >&2 || true
    exit 2
  fi
  lines="$(printf '%s' "$json" | python3 -I -c "$reader" "$(cd "$(dirname "$f")" && pwd)")" || rc=$?
  if [ "$rc" -eq 3 ]; then
    printf '%s: no services: the resolved output has no non-empty services mapping\n' "$f"
    status=1
    return 0
  fi
  if [ "$rc" -ne 0 ]; then
    echo "$f: could not read the resolved compose output" >&2
    exit 2
  fi
  case "${lines##*$'\n'}" in
    "RESOLVED "[1-9]*) ;;
    *)
      echo "$f: the reader ended without a RESOLVED line" >&2
      exit 2
      ;;
  esac
  while IFS=$'\t' read -r kind payload; do
    case "$kind" in
      OFFENDER)
        printf '%s: %s\n' "$f" "$payload"
        status=1
        ;;
      DOCKERFILE) scan_dockerfile "$payload" ;;
    esac
  done <<< "$lines"
}

for f in "$@"; do
  case "$f" in
    *.yml | *.yaml) scan_compose "$f" ;;
    *) scan_dockerfile "$f" ;;
  esac
done
exit "$status"
