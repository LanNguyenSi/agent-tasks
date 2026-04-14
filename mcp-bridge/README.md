# @agent-tasks/mcp-bridge

Zero-setup MCP bridge for [agent-tasks](https://agent-tasks.opentriologue.ai) — distributes the governed backend as a single `npx` command so any MCP-capable client (Claude Code, triologue, …) can claim, transition, and inspect tasks without touching REST.

See the [agent-tasks positioning README](https://github.com/LanNguyenSi/agent-tasks#readme) for where this sits in the Project OS pipeline.

## Quickstart

```sh
npx -y @agent-tasks/mcp-bridge login --token "$MY_TOKEN"        # store once (or run plain 'login' for an interactive masked prompt)
claude mcp add agent-tasks -- npx -y @agent-tasks/mcp-bridge    # register with Claude Code
```

That's it — the agent now sees `tasks_*`, `signals_*`, and `projects_*` tools. All governance (claim gates, preconditions, review locks, audit trails) is enforced by the remote backend; the bridge is a thin stdio transport with a token cache.

> **Note:** passing `--token` on the command line may end up in shell history. Prefer the interactive `login` prompt (input is masked) when possible. For non-interactive use from a secret manager, pipe stdin — e.g. `pass show agent-tasks | agent-tasks-mcp-bridge login` — rather than putting the token on the command line.

## Commands

| Command  | What it does                                                        |
| -------- | ------------------------------------------------------------------- |
| *(none)* | Start the MCP server over stdio (default — used by MCP clients)     |
| `login`  | Validate a token against the backend, store it in the keychain      |
| `logout` | Remove the stored token                                             |
| `status` | Check that the stored token is still valid                          |

## Token storage

1. `AGENT_TASKS_TOKEN` env var (if set, wins; cannot be overwritten by `login`)
2. OS keychain via `keytar` (macOS Keychain, Windows Credential Vault, libsecret)
3. File fallback at `${XDG_CONFIG_HOME:-~/.config}/agent-tasks/bridge-token` (mode `0600`) — used when the keytar native module is unavailable

## Overriding the backend

```sh
AGENT_TASKS_BASE_URL=https://staging.example.com npx -y @agent-tasks/mcp-bridge
```

## Uninstalling

`npm uninstall` / removing the `npx` cache does **not** delete the token from the OS keychain. Run `agent-tasks-mcp-bridge logout` first, or delete the keychain entry for service `agent-tasks-mcp-bridge` manually.

## License

Same as the parent repo.
