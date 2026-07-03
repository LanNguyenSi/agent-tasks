---
type: module
title: "mcp-bridge: zero-setup CLI wrapper"
description: "Resolves a bearer token (env, then OS keychain, then file) and hands off to mcp-server's stdio runtime; its own version constant is drift-guarded by a test."
tags: [mcp, cli, token-store]
timestamp: 2026-07-03T00:00:00Z
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
2. OS keychain via `keytar` → `KeytarStore`. Dynamically imported and runtime-probed (`getPassword` called once) because on Linux without `libsecret-1` the module can import cleanly but throw on first call; any import/probe failure falls through.
3. File fallback → `FileStore` at `$XDG_CONFIG_HOME/agent-tasks/bridge-token` (or `~/.config/agent-tasks/bridge-token`), written atomically (`tmp` file + `rename`) with `0o600`/`0o700` perms (best-effort on non-POSIX filesystems).

Once a token is resolved, `serve` calls `runStdioServer({ token, baseUrl })` imported directly from `@agent-tasks/mcp-server`, the bridge does not reimplement the MCP protocol, it only owns credential resolution and the `login`/`logout`/`status` UX (`mcp-bridge/src/login.ts`).

**Version constant**: `PACKAGE_VERSION = "0.7.2"` in `cli.ts` is asserted equal to `package.json#version` by `mcp-bridge/tests/cli-version.test.ts` (a "drift guard", the comment in `cli.ts` says bump both together). `mcp-bridge/package.json` pins `@agent-tasks/mcp-server` at an exact version (`"0.10.0"`, no `^`); see `release-flow.md` for why this pin has to already be published before the bridge itself is published.

Related: `mcp-server.md`, `release-flow.md`.
