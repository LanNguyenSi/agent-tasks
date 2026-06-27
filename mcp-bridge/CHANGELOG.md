# Changelog

All notable changes to `@agent-tasks/mcp-bridge` are documented here.

## 0.7.2

### Security

- **`tsx` devDependency bumped to `^4.22.4`** (#342). Clears esbuild advisories GHSA-gv7w-rqvm-qjhr and GHSA-g7r4-m6w7-qqqr; `tsx >=4.22.0` resolves `esbuild ~0.28.x` (patched range).

### Changed

- **`@agent-tasks/mcp-server` dependency pinned to `0.10.0`** (#359, #361, #377, #342). Aligns to the current server release, which adds the `reclassify` flag on `task_pickup` and `task_start`, documents the `task_finish` result field as free-text, reconciles the MCP README and server-version constant with the code, and clears the esbuild advisories.
