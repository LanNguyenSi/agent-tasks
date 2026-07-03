---
type: runbook
title: "Cutting a release: three tag axes, one publish workflow"
description: "v* triggers a GitHub Release; mcp-server-v*/mcp-bridge-v* both drive publish-npm.yml, which requires mcp-server to already be published before mcp-bridge."
tags: [release, ci, npm, tags]
timestamp: 2026-07-03T10:59:39Z
sources:
  - .github/workflows/release.yml
  - .github/workflows/publish-npm.yml
  - .github/workflows/ci.yml
  - mcp-bridge/package.json
---

Three independent tag axes, two workflow files:

- **`v*`** (root release) → `.github/workflows/release.yml`: runs the shared `ci.yml` first (`workflow_call`), then extracts the version from the tag (`${GITHUB_REF_NAME#v}`), pulls the matching `## [x.y.z]` section out of `CHANGELOG.md` (`awk`), and publishes it as a GitHub Release via `softprops/action-gh-release@v2`. No npm publish happens here.
- **`mcp-server-v*`** and **`mcp-bridge-v*`** → the *same* single workflow, `.github/workflows/publish-npm.yml`, which branches on the tag prefix (`case "$tag" in mcp-server-v*) ... mcp-bridge-v*) ... esac`) to pick the npm workspace and the expected version.

**`publish-npm.yml` steps** (in order): checkout, Node 22 + npm registry setup, `npm ci`, verify `<workspace>/package.json#version` equals the tag-derived version (fails the job otherwise), then, **only for the `mcp-bridge` workspace**, a preflight that reads `mcp-bridge/package.json#dependencies["@agent-tasks/mcp-server"]` (an exact pin, e.g. `"0.10.0"`, no `^`) and runs `npm view "@agent-tasks/mcp-server@<pinned>" version`; if that lookup fails the job aborts with "Publish mcp-server first (tag: mcp-server-v<pinned>)." Then build (`mcp-server` always built first, then the target workspace) and `npm publish --workspace=<target> --access public --provenance`.

**Practical consequence, cut order is not optional**: bumping `mcp-bridge`'s dependency pin to a new `mcp-server` version and tagging `mcp-bridge-vX` before `mcp-server-vX` is actually published on npm will hard-fail the bridge's own publish job at the preflight step.

**Concrete steps to cut a release**:
1. Root (`v*`): bump the relevant `package.json`(s), add a `## [x.y.z]` section to `CHANGELOG.md`, commit, `git tag vX.Y.Z`, push the tag.
2. `mcp-server` package: bump `mcp-server/package.json#version` **and** the separate `SERVER_VERSION` constant in `mcp-server/src/server.ts` (not test-enforced equal, see `mcp-server.md`), commit, `git tag mcp-server-vX.Y.Z`, push. Wait for `publish-npm.yml` to go green (or check `npm view @agent-tasks/mcp-server version`).
3. `mcp-bridge` package: if depending on a new `mcp-server` version, bump the exact pin in `mcp-bridge/package.json#dependencies`. Bump `mcp-bridge/package.json#version` **and** `PACKAGE_VERSION` in `mcp-bridge/src/cli.ts` (this pair *is* test-enforced by `mcp-bridge/tests/cli-version.test.ts`). Commit, `git tag mcp-bridge-vX.Y.Z`, push, only after step 2's tag has actually published.

Related: `mcp-server.md`, `mcp-bridge.md`, `deploy.md`.
