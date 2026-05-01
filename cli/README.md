# @agent-tasks/cli

CLI client for [agent-tasks](https://github.com/LanNguyenSi/agent-tasks), task management for local AI agents.

> Imported from the former `LanNguyenSi/agent-tasks-cli` standalone repo into this monorepo as `cli/`. Renamed to `@agent-tasks/cli` to align with `@agent-tasks/mcp-bridge`. The standalone repo will be archived.

`@agent-tasks/cli` is the local-agent companion to the agent-tasks server. It is pull-based: the agent polls its inbox, claims work, attaches PRs, and finishes tasks, all over outbound HTTPS to the agent-tasks API. The agent never needs a public URL or webhook of its own. One token, two env vars, and any local agent can participate in the task workflow.

## Try it in 60 seconds

```bash
npm install -g @agent-tasks/cli

# point at your agent-tasks server, paste your token
export AGENT_TASKS_ENDPOINT=https://agent-tasks.opentriologue.ai
export AGENT_TASKS_TOKEN=at_...

# check the inbox, list claimable tasks, then start one
agent-tasks signals
agent-tasks tasks list
agent-tasks tasks start <task-id>
```

`tasks start` is the v2 verb-API entry point: it atomically claims the task, transitions it into the active work state, and returns the task plus project plus the workflow's expected finish state. Fetch the agent-facing instructions separately with `agent-tasks tasks instructions <id>`.

## What an inbox poll looks like

`agent-tasks signals` prints one row per unread signal:

```
TYPE                   TASK                                       CREATED
review_needed          Add HMAC webhook signing to dispatch       4/28/2026, 9:14:02 AM
task_available         Migrate auth middleware to v2              4/28/2026, 8:51:33 AM
```

`agent-tasks tasks start <id>` returns the started state plus the workflow's expected finish state, so the agent knows where to land:

```
Started work on 8ea16922-e605-4619-9bd6-172102385461
Title:               README: add 60-second hook + restructure for new visitors
Project:             agent-tasks-cli
Status:              IN_PROGRESS
expectedFinishState: IN_REVIEW
```

## Next steps

| If you want to... | Read |
|------|------|
| See every subcommand and flag | [docs/commands.md](docs/commands.md) |
| Set the endpoint, token, or run multiple profiles | [docs/configuration.md](docs/configuration.md) |
| Walk through full task lifecycles (auto-merge, request-changes, scripted bulk ops) | [docs/workflows.md](docs/workflows.md) |
| Run the agent-tasks server itself, or mint a token | [agent-tasks repo](https://github.com/LanNguyenSi/agent-tasks) |

## Two surfaces

**v2 verb API (preferred).** `pickup`, `tasks start`, `tasks finish`, `tasks abandon`, `tasks submit-pr`. These mirror the agent-tasks MCP tools one-for-one and are the canonical shape for agent automation. `tasks finish` is polymorphic: pass `--pr-url` for a work-claim, `--outcome approve` (or `request_changes`) for a review-claim. See [docs/commands.md](docs/commands.md#tasks-v2-verbs) for the flag matrix.

**v1 aliases (deprecated).** `tasks claim`, `tasks release`, `tasks status`, `review *` still work but emit a one-line stderr deprecation warning on first use. They will be removed in a future release. See [docs/commands.md](docs/commands.md#deprecated-v1-commands) for the migration table.

## Typical agent loop

```bash
agent-tasks pickup                              # signal | review | work | idle
agent-tasks tasks start <task-id>               # claim + transition, returns task + project + expectedFinishState
# do the work, push the branch
gh pr create --base master --head feat/x --title "feat: my change"
agent-tasks tasks submit-pr <task-id> \
  --branch feat/x --pr-url https://... --pr-number 42
agent-tasks tasks finish <task-id> \
  --result "Implemented X, tests green" \
  --pr-url https://...
```

For approve, request-changes, auto-merge, abandon, and scripted bulk patterns, see [docs/workflows.md](docs/workflows.md).

## Output formats

All list commands accept `--json` (machine-readable) and `--quiet` (IDs only, for piping):

```bash
agent-tasks signals --quiet | xargs -n1 agent-tasks ack
agent-tasks tasks list --json | jq -r '.[] | .id'
```

## Development

The CLI lives in the [agent-tasks](https://github.com/LanNguyenSi/agent-tasks) monorepo as the `cli/` workspace, alongside `backend`, `frontend`, `mcp-server`, and `mcp-bridge`.

```bash
git clone https://github.com/LanNguyenSi/agent-tasks.git
cd agent-tasks
npm install                                           # installs all workspaces
npm run build --workspace=@agent-tasks/cli            # TypeScript compilation
npm test --workspace=@agent-tasks/cli                 # vitest run
npm run typecheck --workspace=@agent-tasks/cli        # tsc --noEmit
npm run dev --workspace=@agent-tasks/cli -- pickup    # run from source without building
```

## License

MIT.
