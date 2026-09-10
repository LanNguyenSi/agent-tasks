---
type: runbook
title: "Cutting a release: three tag axes, one publish workflow"
description: "v* triggers a GitHub Release; mcp-server-v*/mcp-bridge-v* both drive publish-npm.yml, which requires mcp-server to already be published before mcp-bridge."
tags: [release, ci, npm, tags]
timestamp: 2026-09-10T06:30:38Z
sources:
  - .github/workflows/release.yml
  - .github/workflows/publish-npm.yml
  - .github/workflows/ci.yml
  - mcp-bridge/package.json
---

Three independent tag axes, two workflow files:

- **`v*`** (root release) → `.github/workflows/release.yml`: runs the shared `ci.yml` first (`workflow_call`), then extracts the version from the tag (`${GITHUB_REF_NAME#v}`), pulls the matching `## [x.y.z]` section out of `CHANGELOG.md` (`awk`), and publishes it as a GitHub Release via `softprops/action-gh-release@v3`. No npm publish happens here.
- **`mcp-server-v*`** and **`mcp-bridge-v*`** → the *same* single workflow, `.github/workflows/publish-npm.yml`, which branches on the tag prefix (`case "$tag" in mcp-server-v*) ... mcp-bridge-v*) ... esac`) to pick the npm workspace and the expected version.

**`publish-npm.yml` steps** (in order): checkout, Node 22 + npm registry setup, `npm ci`, identify the workspace and expected version from the tag prefix, verify `<workspace>/package.json#version` equals the tag-derived version (fails the job otherwise), then, **only for the `mcp-bridge` workspace**, a preflight that reads `mcp-bridge/package.json#dependencies["@agent-tasks/mcp-server"]` (an exact pin, e.g. `"0.14.0"`, no `^`) and runs `npm view "@agent-tasks/mcp-server@<pinned>" version`; if that lookup fails the job aborts with "Publish mcp-server first (tag: mcp-server-v<pinned>)."

Then build (`mcp-server` always built first, then the target workspace), upgrade to npm@11 (`publish-npm.yml:74-81`; npm Trusted Publishing/OIDC needs npm >= `11.5.1`, since Node 22 bundles npm 10), and publish: `npm publish --workspace=<target> --access public --provenance`, authenticated via the job's GitHub OIDC token (`permissions.id-token: write`) matched against each package's npmjs.com Trusted Publisher entry, no npm token secret involved. The publish step wraps that command in a retry loop (`publish-npm.yml:101-129`, each try logged as `"npm publish attempt ${attempt}/${max}"`), up to 3 attempts with exponential backoff, that treats a version already on the registry as success and, on a final failure, prints a triage hint distinguishing a transient Sigstore Rekor 409 (re-run the failed job, Actions -> the failed run -> Re-run failed jobs, or delete and re-push the tag) from a persistent 403/404 (the Trusted Publisher entry is missing or misconfigured).

**Practical consequence, cut order is not optional**: bumping `mcp-bridge`'s dependency pin to a new `mcp-server` version and tagging `mcp-bridge-vX` before `mcp-server-vX` is actually published on npm will hard-fail the bridge's own publish job at the preflight step.

**Concrete steps to cut a release**:
1. Root (`v*`): bump the relevant `package.json`(s), add a `## [x.y.z]` section to `CHANGELOG.md`, commit, `git tag vX.Y.Z`, push the tag.
2. `mcp-server` package: bump `mcp-server/package.json#version` **and** the separate `SERVER_VERSION` constant in `mcp-server/src/server.ts` (since `#396`, 2026-07-04, this pair *is* test-enforced equal by `mcp-server/tests/server-version.test.ts`, the same drift-guard pattern as the bridge's own version test, see `mcp-server.md`), commit, `git tag mcp-server-vX.Y.Z`, push. Wait for `publish-npm.yml` to go green (or check `npm view @agent-tasks/mcp-server version`).
3. `mcp-bridge` package: if depending on a new `mcp-server` version, bump the exact pin in `mcp-bridge/package.json#dependencies`. Bump `mcp-bridge/package.json#version` **and** `PACKAGE_VERSION` in `mcp-bridge/src/cli.ts` (this pair *is* test-enforced by `mcp-bridge/tests/cli-version.test.ts`). Commit, `git tag mcp-bridge-vX.Y.Z`, push, only after step 2's tag has actually published.

Related: `mcp-server.md`, `mcp-bridge.md`, `deploy.md`.
