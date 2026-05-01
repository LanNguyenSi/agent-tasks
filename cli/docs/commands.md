# Command reference

All commands accept `--json` (machine-readable JSON) and most accept `--quiet` (IDs only, for scripting).

The CLI has two surfaces:

- **v2 verb API (preferred):** `pickup`, `tasks start`, `tasks finish`, `tasks abandon`, `tasks submit-pr`. These mirror the agent-tasks MCP tools and are the canonical shape for agent automation.
- **v1 aliases (deprecated):** `tasks claim`, `tasks release`, `tasks status`, `review *`. They still work but emit a one-line stderr deprecation warning. They will be removed in a future release.

## Signals (inbox)

```bash
# Poll for unread signals (default)
agent-tasks signals

# Show acknowledged signals
agent-tasks signals --acknowledged

# Show all signals (read + unread)
agent-tasks signals --all

# Limit number of signals returned (default: 50)
agent-tasks signals --limit 10

# Output formats
agent-tasks signals --json
agent-tasks signals --quiet

# Acknowledge a signal
agent-tasks ack <signal-id>
```

## Pickup (v2)

`pickup` returns the next thing the agent should handle. The result has a `kind` of `signal`, `review`, `work`, or `idle`.

```bash
agent-tasks pickup
agent-tasks pickup --json
agent-tasks pickup --quiet   # signal id or task id only
```

## Tasks (v2 verbs)

```bash
# Begin work: atomic claim + transition. Returns task, project, and expectedFinishState.
# Use `tasks instructions <id>` to fetch the agent-facing instructions blob.
agent-tasks tasks start <task-id>

# Attach branch + PR after `gh pr create`
agent-tasks tasks submit-pr <task-id> \
  --branch feat/my-branch \
  --pr-url https://github.com/acme/repo/pull/42 \
  --pr-number 42

# Finish a work claim, moves the task to the workflow's expectedFinishState
agent-tasks tasks finish <task-id> \
  --result "Implemented X, tests green" \
  --pr-url https://github.com/acme/repo/pull/42

# Finish a review claim, approve or request changes
agent-tasks tasks finish <task-id> --outcome approve --result "LGTM"
agent-tasks tasks finish <task-id> --outcome request_changes --result "Please add tests"

# Auto-merge after approve
agent-tasks tasks finish <task-id> --outcome approve --auto-merge --merge-method squash

# Bail out of an active claim without finishing
agent-tasks tasks abandon <task-id>
```

`tasks finish` flag rules:

| Flag | Allowed with | Notes |
|------|--------------|-------|
| `--result <text>` | both | Result summary |
| `--pr-url <url>` | work-claim only | Must be a github.com PR |
| `--outcome <approve\|request_changes>` | review-claim only | Mutually exclusive with `--pr-url` |
| `--auto-merge` | approve only | Rejected with `request_changes` |
| `--merge-method <merge\|squash\|rebase>` | with `--auto-merge` | Default: squash |

## Tasks (read + create)

```bash
# List claimable tasks
agent-tasks tasks list

# Fetch a single task by id
agent-tasks tasks get <task-id>

# Create a task (project can be a slug or UUID)
agent-tasks tasks create my-project --title "Fix the bug"
agent-tasks tasks create my-project \
  --title "Import from Jira" \
  --priority HIGH \
  --description "Full description" \
  --external-ref "jira-PROJ-42" \
  --label imported --label backend

# Update task fields directly (rarely needed, prefer `tasks submit-pr` / `tasks finish`)
agent-tasks tasks update <task-id> --branch feat/my-branch --pr-url https://... --pr-number 42

# Add a comment
agent-tasks tasks comment <task-id> "Fixed the bug, ready for review"

# Get task instructions (agent context)
agent-tasks tasks instructions <task-id>
```

`tasks create` flags:

| Flag | Description |
|------|-------------|
| `-t, --title <title>` | Required |
| `-d, --description <text>` | |
| `-p, --priority <LOW\|MEDIUM\|HIGH\|CRITICAL>` | |
| `-w, --workflow <id>` | Workflow UUID |
| `--due-at <iso>` | ISO 8601 due date |
| `--external-ref <ref>` | Idempotency key for imports |
| `-l, --label <label>` | Repeatable |

## Projects

```bash
# List all projects visible to your token
agent-tasks projects list

# Fetch a single project by slug or UUID
agent-tasks projects get my-project
agent-tasks projects get 11111111-1111-1111-1111-111111111111

# Show which workflow gates apply to a project (and why)
agent-tasks projects effective-gates my-project
```

## GitHub delegation

These commands drive the agent-tasks server's GitHub delegation endpoints, a team member with `allowAgentPr*` consent acts on the agent's behalf, so the agent itself does not need a GitHub token.

```bash
# Create a PR linked to a task
agent-tasks github pr create \
  --task <task-id> \
  --owner LanNguyenSi --repo agent-tasks \
  --head feat/my-branch --base master \
  --title "feat: do the thing" \
  --body "Fixes the bug"

# Merge a PR (default method: squash)
agent-tasks github pr merge <pr-number> \
  --task <task-id> \
  --owner LanNguyenSi --repo agent-tasks \
  --method squash

# Comment on a PR
agent-tasks github pr comment <pr-number> "LGTM" \
  --task <task-id> \
  --owner LanNguyenSi --repo agent-tasks
```

## Deprecated v1 commands

| Deprecated | Replacement |
|------------|-------------|
| `tasks claim <id>` | `tasks start <id>` |
| `tasks release <id>` | `tasks abandon <id>` |
| `tasks status <id> <state>` | `tasks start <id>` / `tasks finish <id>` |
| `review approve <id>` | `tasks finish <id> --outcome approve` |
| `review request-changes <id>` | `tasks finish <id> --outcome request_changes` |
| `review claim <id>` | `tasks start <id>` (polymorphic on review-state tasks) |
| `review release <id>` | `tasks abandon <id>` |

The first invocation of a deprecated command in a process emits a single stderr line; subsequent calls in the same process are silent.

## Output formats

All list commands support:

- `--json`: machine-readable JSON
- `--quiet`: IDs only (one per line, for piping into other commands)
