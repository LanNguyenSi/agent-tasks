# Jira Import CLI

Import Jira issues into agent-tasks via the batch import endpoint.

## Usage

```bash
npx tsx tools/jira-import/jira-import.ts \
  --jira-url https://your-org.atlassian.net \
  --jira-email you@example.com \
  --jira-token ATATT... \
  --jql "project = PROJ AND status != Done" \
  --agent-tasks-url https://agent-tasks.opentriologue.ai \
  --agent-tasks-token at_... \
  --project-id <uuid> \
  [--dry-run]
```

Or use environment variables: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `AGENT_TASKS_URL`, `AGENT_TASKS_TOKEN`, `PROJECT_ID`.

## Field Mapping

| Jira | agent-tasks |
|------|-------------|
| Key (PROJ-123) | `externalRef` |
| Summary | `title` |
| Description | `description` (ADF auto-extracted) |
| Priority | `priority` (Highest→CRITICAL, High→HIGH, etc.) |
| Status Category | `status` (new→open, indeterminate→in_progress, done→done) |
| Labels | `labels` |
| Issue Type | `labels` (as `type:bug`, `type:story`, etc.) |
| Due Date | `dueAt` |

## Deduplication

Uses Jira issue key as `externalRef`. Re-running the same import skips already-imported issues.

## Dry Run

Use `--dry-run` to preview what would be imported without making any changes.
