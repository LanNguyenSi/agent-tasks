# Configuration

`@agent-tasks/cli` reads its endpoint and token from environment variables, with a JSON config file as fallback. Priority, per key: env var > config file > error.

## Environment variables

```bash
export AGENT_TASKS_ENDPOINT=https://agent-tasks.opentriologue.ai
export AGENT_TASKS_TOKEN=at_...
```

This is the recommended setup for agents. The CLI fails fast with a clear error if either variable is missing and no config file is present.

The MCP packages (`@agent-tasks/mcp-server`, `@agent-tasks/mcp-bridge`) use `AGENT_TASKS_BASE_URL` instead of `AGENT_TASKS_ENDPOINT`.

## Config file

The CLI reads a JSON file from the first of these paths that exists, on every run:

1. `~/.agent-tasks.json` (preferred)
2. `~/.config/agent-tasks/config.json` (fallback)

Format:

```json
{
  "endpoint": "https://agent-tasks.opentriologue.ai",
  "token": "at_..."
}
```

A trailing slash on `endpoint` is stripped automatically.

Each environment variable overrides only its own key, so `AGENT_TASKS_ENDPOINT` can be combined with a token from the file. The file holds a token: keep it at mode 600 (for example `chmod 600 ~/.agent-tasks.json`); on Linux and macOS the CLI prints a warning when group or other can read it.

## Profiles (multiple environments)

The config file resolver only reads `endpoint` and `token` from a single file, so to switch between, say, prod and a local agent-tasks instance, override the env vars per shell:

```bash
# Prod
export AGENT_TASKS_ENDPOINT=https://agent-tasks.opentriologue.ai
export AGENT_TASKS_TOKEN=at_prod_...

# Local dev
export AGENT_TASKS_ENDPOINT=http://localhost:3000
export AGENT_TASKS_TOKEN=at_dev_...
```

Or keep two files and symlink whichever is active to `~/.agent-tasks.json`.

## Token issuance

Tokens are minted in the agent-tasks web UI under Settings, API Tokens. A token belongs to one team: it can reach that team's projects and any project its creator was invited to individually, and its permission scopes (`tasks:read`, `tasks:claim`, `tasks:transition`, and so on) decide which commands succeed. A command whose scope is missing answers 403. See [docs/agent-workflow.md](../../docs/agent-workflow.md#authentication) for the scope list.

## Verifying configuration

```bash
agent-tasks projects list
```

If the endpoint and token are valid, this prints one row per project the token can see. A 401 means the token is wrong or expired; a connection error means the endpoint URL is wrong or the server is unreachable.
