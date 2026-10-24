---
type: module
title: "cli: the agent-tasks REST command-line client"
description: "@agent-tasks/cli wraps the REST API in commander verbs: v2 verbs plus deprecated v1 aliases, client-side task-id prefix resolution over the claimable search, Idempotency-Key handling, two tasks-list modes, env-over-file config with a permission warning, and no npm publish workflow."
tags: [cli, client, rest, config, idempotency]
timestamp: 2026-10-24T09:11:35Z
sources:
  - cli/package.json
  - cli/src/index.ts
  - cli/src/api.ts
  - cli/src/resolve.ts
  - cli/src/config.ts
  - cli/src/format.ts
  - backend/src/routes/tasks.ts
  - .github/workflows/publish-npm.yml
---

**Workspace**: `cli` is the fifth npm workspace, `@agent-tasks/cli` at version `0.3.0` (`cli/package.json:3#"version"`), with the bin `agent-tasks` (built to `dist/index.js`), Node 22 or later, and `commander` as its only runtime dependency. `cli/src/index.ts` defines the commands, `cli/src/api.ts` is a thin `fetch` client, `cli/src/resolve.ts` resolves task-id prefixes, `cli/src/config.ts` loads the endpoint and token, and `cli/src/format.ts` renders output. It talks only to the REST API, with `Authorization: Bearer` on every request; it has no MCP surface (see `architecture.md` for the client paths). A non-2xx answer throws `ApiError`, and the top-level handler prints the status and the JSON body and exits 1.

**Config precedence** (`cli/src/config.ts:4#"Priority: env vars > config file > defaults"`): `AGENT_TASKS_ENDPOINT` and `AGENT_TASKS_TOKEN` win per key over the config file. The file is the first that exists of `~/.agent-tasks.json` and `~/.config/agent-tasks/config.json` (`cli/src/config.ts:39-42#"config.json"`); only its `endpoint` and `token` keys are read, and a file that is not valid JSON counts as empty. A missing endpoint or token is an error with exit 1, and a trailing slash is stripped from the endpoint. On POSIX systems, a config file readable or writable by group or other prints a warning with a `chmod 600` hint to stderr and still loads; the CLI never writes the file.

**Verbs**: the v2 surface mirrors the MCP verbs: `pickup`, `tasks start`, `tasks finish` (work claim with `--pr-url`, review claim with `--outcome`, optional `--auto-merge` and `--merge-method`), `tasks abandon` and `tasks submit-pr`. Alongside are `signals`, `ack`, `tasks list|get|create|update|respec|comment|instructions`, `projects list|get|effective-gates` and `github pr create|merge|comment`. The v1 commands `tasks claim|status|release` and `review approve|request-changes|claim|release` still call their v1 routes (`/claim`, `/transition`, `/release`, `/review`, `/review/claim`, `/review/release`) and print one `[deprecated]` line per command and process to stderr naming the v2 replacement. `tasks claim --force` is the confidence-gate override: it needs `--force-reason` of at least 10 characters (checked in `checkForceFlags` before any request; `--force-reason` without `--force` is an error), which the CLI sends as the `forceReason` query parameter next to `force=true`, and the server still requires the `confidence:override` token scope. Every command with `--json` and `--quiet` refuses both together before any network call (`getMode`); table output shows the first 8 characters of each task id, which the prefix resolver accepts.

**Task-id prefix resolution** (`cli/src/resolve.ts`, `searchTaskPool` in `cli/src/api.ts`): the `<task-id>` argument of the `tasks` subcommands and of `review approve|request-changes` accepts a full UUID, used as is without a network call, or a prefix. `review claim|release` and the `--task` option of the `github pr` commands pass the value unchanged. A prefix is matched case-insensitively against `GET /api/tasks/claimable` called with every status including `backlog`, which switches that endpoint to its team-scoped explicit search, sorted newest first, 200 tasks per page, for at most 10 pages (`cli/src/api.ts:242-243#"SEARCH_TASK_POOL_MAX_PAGES"`). One match resolves; none or several exit 1, with the candidate list for an ambiguous prefix and a note when the page cap stopped the search; a failed search (for example a human in several teams) exits 1 naming the prefix search and asking for the full UUID. Resolving a backlog task's id grants no claim (see `claim-model.md`).

**Operation keys** (`cli/src/api.ts:28-29#"PR_OPERATION_KEY_PATTERN"`): `tasks finish`, `tasks abandon` and `github pr merge` send an `Idempotency-Key` header that must match the stricter pattern (letters, digits and `._:-`, 1 to 128 characters); `github pr create` accepts printable ASCII without spaces, 1 to 255 characters. Both PR commands also send the key as the `idempotencyKey` body field. Without `--operation-key` each invocation generates a fresh UUID, so a plain re-run is a new operation; to make a retry idempotent the caller passes the same key again. An invalid key fails before any network call, including the prefix lookup. The `--operation-key` help of `tasks finish` and `tasks abandon` states that the backend deduplicates by the key only on a grounding-provisioned task.

**`tasks list` modes**: without `--project` it calls `GET /api/tasks/claimable` with no parameters, the claimable slice, and the backend's default page of 25 rows applies (`backend/src/routes/tasks.ts:1631#"parsedLimit"`); `--status`, `--priority`, `--labels`, `--unclaimed` and `--limit` are rejected there. With `--project` (slug or UUID) it browses `GET /api/projects/:id/tasks` with those filters, validates statuses (including `backlog`) and the case-sensitive priorities before the request, defaults to 50 rows and lets the backend clamp the limit to 500 (`backend/src/routes/tasks.ts:1065#"Math.min(parsed, 500)"`). Table output looks up the project record to fill the PROJECT column; JSON and quiet output with a UUID skip that lookup. A 403 or 404 on the project lookup is reported as project not found.

**Release status**: no workflow publishes the CLI to npm. `.github/workflows/publish-npm.yml` runs only for `mcp-server-v*` and `mcp-bridge-v*` tags, although `cli/package.json` carries a public `publishConfig` and a `prepublishOnly` build (see `release-flow.md`). The `--version` string is a literal in `cli/src/index.ts`, kept equal to the package version by hand.

Related: `architecture.md`, `claim-model.md`, `release-flow.md`, `auth.md`.
