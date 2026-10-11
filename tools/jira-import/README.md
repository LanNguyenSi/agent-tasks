# Jira Import CLI

Import Jira issues into agent-tasks via the batch import endpoint.

## Setup

```bash
# Set credentials via environment variables (tokens should NEVER be passed as CLI args):
export JIRA_URL=https://your-org.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_TOKEN=ATATT...
export AGENT_TASKS_URL=https://agent-tasks.opentriologue.ai
export AGENT_TASKS_TOKEN=<human session token>
export PROJECT_ID=<uuid>
```

The importer sets a status on every issue (see Field Mapping). The import endpoint rejects a whole batch from an agent token (`at_...`) with `400 backlog_routing_enforced` when any item has a status other than `backlog`, so run the tool with a human session token: the value of your `session` cookie, sent as `Authorization: Bearer`. A session token expires after 7 days.

## Usage

```bash
# Import all open issues from a Jira project
npx tsx tools/jira-import/jira-import.ts --jql "project = PROJ AND status != Done"

# Preview without importing
npx tsx tools/jira-import/jira-import.ts --jql "project = PROJ" --dry-run

# Show help
npx tsx tools/jira-import/jira-import.ts --help
```

## Field Mapping

| Jira | agent-tasks |
|------|-------------|
| Key (PROJ-123) | `externalRef` |
| Summary | `title` |
| Description (ADF) | `description` (auto-extracted to plain text) |
| Priority | `priority` (Highest->CRITICAL, High->HIGH, etc.) |
| Status Category | `status` (new->open, indeterminate->in_progress, done->done) |
| Labels | `labels` |
| Issue Type | `labels` (as `type:bug`, `type:story`, etc.) |
| Due Date | `dueAt` |

## Deduplication

Uses Jira issue key as `externalRef`. Re-running the same import skips already-imported issues.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `JIRA_URL` | Jira base URL (e.g. `https://your-org.atlassian.net`) |
| `JIRA_EMAIL` | Email for Jira API authentication |
| `JIRA_TOKEN` | Jira API token ([create one](https://id.atlassian.com/manage-profile/security/api-tokens)) |
| `JIRA_JQL` | Default JQL query (overridden by `--jql` flag) |
| `AGENT_TASKS_URL` | agent-tasks API base URL |
| `AGENT_TASKS_TOKEN` | Human session token (agent tokens are rejected, see Setup) |
| `PROJECT_ID` | Target project UUID in agent-tasks |
