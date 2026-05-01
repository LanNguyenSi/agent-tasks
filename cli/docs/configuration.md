# Configuration

`@agent-tasks/cli` reads its endpoint and token from environment variables, with a JSON config file as fallback. Priority: env vars > config file > error.

## Environment variables

```bash
export AGENT_TASKS_ENDPOINT=https://agent-tasks.opentriologue.ai
export AGENT_TASKS_TOKEN=at_...
```

This is the recommended setup for agents. The CLI fails fast with a clear error if either variable is missing and no config file is present.

## Config file

If env vars are not set, the CLI looks for a JSON file at:

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

Tokens are minted by the agent-tasks server. See the [agent-tasks repo](https://github.com/LanNguyenSi/agent-tasks) for the token-issuance flow (typically: log in to the server UI, generate a personal token scoped to the projects you operate on).

## Verifying configuration

```bash
agent-tasks projects list
```

If the endpoint and token are valid, this prints one row per project the token can see. A 401 means the token is wrong or expired; a connection error means the endpoint URL is wrong or the server is unreachable.
