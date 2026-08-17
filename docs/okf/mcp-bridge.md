---
type: module
title: "mcp-bridge: zero-setup CLI wrapper"
description: "Resolves a bearer token (env, then OS keychain, then file) and hands off to mcp-server's stdio runtime; its own version constant is drift-guarded by a test."
tags: [mcp, cli, token-store]
timestamp: 2026-08-17T18:01:17Z
sources:
  - mcp-bridge/src/cli.ts
  - mcp-bridge/src/token-store.ts
  - mcp-bridge/src/login.ts
  - mcp-bridge/package.json
  - mcp-bridge/tests/cli-version.test.ts
---

Published as `@agent-tasks/mcp-bridge`. Bin entry `mcp-bridge/src/cli.ts` parses `argv[2]` into one of `serve` (default, no args), `login [--token <t>]`, `logout`, `status`, `--version`, `--help`. `--version` fast-exits (prints `PACKAGE_VERSION` and returns) *before* token-store resolution or any network call, deliberately, so tooling that probes installed MCP binaries (e.g. a `min_version` doctor check) doesn't hit a probe timeout.

**Token resolution order** (`mcp-bridge/src/token-store.ts`, `resolveTokenStore`):
1. `AGENT_TASKS_TOKEN` env var (or an explicit `envToken` override) → `EnvStore`, read-only (its `set`/`clear` throw, telling the caller to unset the env var to use the keychain).
2. OS keychain via `keytar` → wrapped in a `MultiSourceStore` alongside the file store, replacing the older one-time-startup-probe design (`#403`, 2026-07-14): `keytar` is dynamically imported once at `resolveTokenStore` time (a bare `import()` + `getPassword` property-existence check, no actual call), but a successful import does not commit permanently to keytar — every `get`/`set`/`clear` call tries the keychain first and transparently falls back to the file store on ANY failure or empty result (a native binding that loads fine but throws on first real use, e.g. a missing D-Bus session on Linux, degrades gracefully call-by-call instead of only being caught at import time).
3. File fallback → `FileStore` at `$XDG_CONFIG_HOME/agent-tasks/bridge-token` (or `~/.config/agent-tasks/bridge-token`), written atomically (`tmp` file + `rename`) with `0o600`/`0o700` perms (best-effort on non-POSIX filesystems).

Once a token is resolved, `serve` calls `runStdioServer({ token, baseUrl }, { legacy: process.env.AGENT_TASKS_MCP_LEGACY === "1" })` imported directly from `@agent-tasks/mcp-server` (the `legacy` option was added in `#440`/rc-v1-C007, so the AGENT_TASKS_MCP_LEGACY opt-in the bridge's own `--help` documents actually reaches the mcp-server runtime instead of being dropped), the bridge does not reimplement the MCP protocol, it only owns credential resolution and the `login`/`logout`/`status` UX (`mcp-bridge/src/login.ts`).

**Version constant**: `PACKAGE_VERSION = "0.8.0"` in `cli.ts` is asserted equal to `package.json#version` by `mcp-bridge/tests/cli-version.test.ts` (a "drift guard", the comment in `cli.ts` says bump both together). `mcp-bridge/package.json` pins `@agent-tasks/mcp-server` at an exact version (`"0.13.0"`, no `^`); see `release-flow.md` for why this pin has to already be published before the bridge itself is published.

Related: `mcp-server.md`, `release-flow.md`.
