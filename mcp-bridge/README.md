# @agent-tasks/mcp-bridge

Zero-setup MCP bridge for [agent-tasks](https://agent-tasks.opentriologue.ai) — distributes the governed backend as a single `npx` command so any MCP-capable client (Claude Code, triologue, …) can claim, transition, and inspect tasks without touching REST.

See the [agent-tasks README](https://github.com/LanNguyenSi/agent-tasks#readme) for how the bridge relates to mcp-server and the backend.

## Quickstart

```sh
npx -y @agent-tasks/mcp-bridge login --token "$MY_TOKEN"        # store once (or run plain 'login' for an interactive masked prompt)
claude mcp add agent-tasks -- npx -y @agent-tasks/mcp-bridge    # register with Claude Code
```

The agent now sees the v2 `task_*` workflow verbs (`task_pickup`, `task_start`, `task_finish`, ...), `workflow_primer`, `tasks_get`, `project_tasks`, `projects_get_effective_gates`, `signals_poll`/`signals_ack` and the `pull_requests_create`/`pull_requests_merge` delegation tools; see [mcp-server's tool list](https://github.com/LanNguyenSi/agent-tasks/tree/master/mcp-server#tools). All governance (claim gates, preconditions, review locks, audit trails) is enforced by the remote backend; the bridge is a thin stdio transport with a token cache.

> **Note:** passing `--token` on the command line may end up in shell history. Prefer the interactive `login` prompt (input is masked) when possible. For non-interactive use from a secret manager, pipe stdin, for example `pass show agent-tasks | npx -y @agent-tasks/mcp-bridge login`, rather than putting the token on the command line.

## Commands

| Command  | What it does                                                        |
| -------- | ------------------------------------------------------------------- |
| *(none)* or `serve` | Start the MCP server over stdio (default, used by MCP clients) |
| `login`  | Validate a token against the backend, store it in the keychain      |
| `logout` | Remove the stored token                                             |
| `status` | Check that the stored token is still valid                          |
| `--version` | Print the package version and exit (no token lookup, no network) |
| `--help` | Show usage                                                          |

## Token storage

1. `AGENT_TASKS_TOKEN` env var (if set, wins; cannot be overwritten by `login`)
2. OS keychain via `keytar` (macOS Keychain, Windows Credential Vault, libsecret)
3. File fallback at `${XDG_CONFIG_HOME:-~/.config}/agent-tasks/bridge-token` (mode `0600`) — used when the keytar native module is unavailable

## Overriding the backend

```sh
AGENT_TASKS_BASE_URL=https://staging.example.com npx -y @agent-tasks/mcp-bridge
```

## Legacy v1 verbs

`@agent-tasks/mcp-server` (the package this bridge wraps) prunes 14
still-deprecated v1 verbs from its default tool registration (rc-v1-C007;
see [`mcp-server/README.md`](https://github.com/LanNguyenSi/agent-tasks/tree/master/mcp-server#tools)
for the full list and their v2 replacements). Set `AGENT_TASKS_MCP_LEGACY=1`
in the bridge process's environment to register the full legacy set (40 tools) instead:

```sh
AGENT_TASKS_MCP_LEGACY=1 npx -y @agent-tasks/mcp-bridge
```

## Uninstalling

`npm uninstall` / removing the `npx` cache does **not** delete the token from the OS keychain. Run `npx -y @agent-tasks/mcp-bridge logout` first, or delete the keychain entry for service `agent-tasks-mcp-bridge` manually.

## License

MIT, see [../LICENSE](../LICENSE).
