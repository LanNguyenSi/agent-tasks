# Changelog

All notable changes to `@agent-tasks/mcp-bridge` are documented here.

## 0.8.1

### Changed

- **`@agent-tasks/mcp-server` dependency bumped to `0.14.0`.** Ships the
  backlog-status v1 MCP surface to npx consumers: backlog-aware status
  filters, the `backlog_routing_enforced` / `backlog_not_promoted` teaching
  errors, the "awaits operator promotion" receipt hint, and the primer's
  backlog section.
- mcp-bridge typechecks against mcp-server source, unblocking fresh
  worktrees (#452); test-file typecheck runs in CI (#464).

## 0.8.0

### Changed

- **`@agent-tasks/mcp-server` dependency bumped to `0.13.0`** (rc-v1-C008).
  Ships **Response Contract v1** to npx consumers, a breaking change of the
  served tool surface: the eight write verbs return small receipts by default
  (`include: ["task"]` opts back into the full object per call), `task_start`
  returns a receipt plus a compact per-task slice, `tasks_get` returns a
  summary projection, every error is a teaching error
  (`{ code, message, recipe, allowedNext }`), the initialize handshake
  carries an onboarding primer alongside the new `workflow_primer` verb, and
  the default registration is pruned to 23 tools (0.12.0 served 36). See the
  `@agent-tasks/mcp-server` 0.13.0 CHANGELOG for the full rc-v1 series.

### Added

- **`AGENT_TASKS_MCP_LEGACY` passthrough** (rc-v1-C007, #440): the bridge CLI
  reads the flag from its own environment and forwards it to the spawned
  server, so bridge users can re-register the 14 pruned v1 verbs without
  bypassing the bridge. Documented in the usage text and README, proven by a
  test that spawns the real built binary.

## 0.7.3

### Changed

- **`@agent-tasks/mcp-server` dependency bumped to `0.12.0`** (#412). Ships the current tool set to npx consumers: `task_respec` (respec an open, unclaimed task's description/templateData and get a fresh confidence score) from 0.12.0, and `deliverableRepo` support from 0.11.0. Until this release the published bridge pinned `0.10.0`, so a fresh `npx @agent-tasks/mcp-bridge` served the older tool set regardless of what the server had shipped.

## 0.7.2

### Security

- **`tsx` devDependency bumped to `^4.22.4`** (#342). Clears esbuild advisories GHSA-gv7w-rqvm-qjhr and GHSA-g7r4-m6w7-qqqr; `tsx >=4.22.0` resolves `esbuild ~0.28.x` (patched range).

### Changed

- **`@agent-tasks/mcp-server` dependency pinned to `0.10.0`** (#359, #361, #377, #342). Aligns to the current server release, which adds the `reclassify` flag on `task_pickup` and `task_start`, documents the `task_finish` result field as free-text, reconciles the MCP README and server-version constant with the code, and clears the esbuild advisories.
