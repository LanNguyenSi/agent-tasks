---
type: module
title: "mcp-server: stdio MCP wrapper over the REST API"
description: "Publishes the v2 verb surface as MCP tools over a fixed bearer token; SERVER_VERSION is a hand-maintained constant, not derived from package.json."
tags: [mcp, stdio, npm-package]
timestamp: 2026-08-12T09:01:18Z
sources:
  - mcp-server/src/index.ts
  - mcp-server/src/server.ts
  - mcp-server/src/client.ts
  - mcp-server/src/tools.ts
  - mcp-server/src/errors.ts
  - mcp-server/src/primer.ts
  - mcp-server/package.json
---

Published as `@agent-tasks/mcp-server` (npm, public). Entry point `mcp-server/src/index.ts` reads `AGENT_TASKS_TOKEN` (required, throws if absent), `AGENT_TASKS_BASE_URL` (optional, default `https://agent-tasks.opentriologue.ai`, `DEFAULT_BASE_URL` in `server.ts`), and `AGENT_TASKS_MCP_LEGACY` (optional, `"1"` to register the pruned v1 verb set, see below), then calls `runStdioServer`.

`mcp-server/src/server.ts` builds an `McpServer` (`@modelcontextprotocol/sdk`) named `SERVER_NAME = "agent-tasks-mcp"` at `SERVER_VERSION = "0.12.0"`, wires it to a `StdioServerTransport`, and registers every tool from `buildTools(client, options?)` (`tools.ts`); `createServer`/`runStdioServer` both take the same optional `{ legacy?: boolean }` and pass it straight through. `mcp-server/src/client.ts` (`AgentTasksClient`) is a thin fetch wrapper: every request sends `Authorization: Bearer <token>` and `Accept: application/json`; non-2xx responses throw `AgentTasksApiError(status, body, message)`.

**Tool surface** (`tools.ts`, one `name:` per registered tool) mirrors the backend v2 verbs 1:1, plus one local-only tool. rc-v1-C007 split `buildTools`'s output into a DEFAULT set (23 tools, registered unconditionally) and a LEGACY set (`tools.ts`'s `LEGACY_VERB_NAMES`, 14 tools, registered only when `options.legacy` is true): every verb still carrying the `[DEPRECATED` description prefix moved to the legacy set, except four kept in default for a documented reason each (`tasks_get`, upgraded into the read-verb surface by rc-v1-C006; `tasks_comment`, the receipt-converted `task_note` alias; `signals_poll`/`signals_ack`, still the only signal-inbox surface). Handler code is unchanged for all 37; this is a registration-time filter only. DEFAULT: `task_pickup`, `task_start`, `task_finish`, `task_create`, `task_respec`, `task_abandon`, `task_submit_pr`, `task_merge`, `task_note`, `task_artifact_create/list/get`, `task_attachment_list/get`, `projects_get_effective_gates`, `project_tasks`, `tasks_get`, `tasks_comment`, `signals_poll/ack`, `pull_requests_create/merge`, and `workflow_primer` (`primer.ts`; served locally from a fixed string, no backend call, so it has no backend route to mirror). LEGACY-ONLY (`AGENT_TASKS_MCP_LEGACY=1`): `projects_list`, `projects_get`, `tasks_list/instructions/create/claim/release/transition/update`, `review_approve/request_changes/claim/release`, `pull_requests_comment`. `errors.ts`'s `project_addressing_conflict`/`unknown_project_slug` catalog entries were updated in the same task so their `allowedNext` no longer names the now-legacy-gated `projects_list`; `recipe` still mentions it as the flag-gated option. Legacy-set verbs are exempt from `docs/response-contract-v1.md`'s response-shape rules ("Legacy-flag exemption" in that doc): they exist for compatibility only.

**Version constant risk**: `SERVER_VERSION` in `server.ts` (`"0.12.0"`) is a separate literal from `mcp-server/package.json#version` (also currently `"0.12.0"`), there is no test in `mcp-server/tests/` asserting they match (checked: `client.test.ts`, `tools.test.ts`, neither references `SERVER_VERSION`). Contrast with `mcp-bridge.md`, which has an explicit drift-guard test for its own version constant. Bumping the package version for a release requires manually bumping `SERVER_VERSION` too; nothing enforces it. Neither was bumped for rc-v1-C007 (registration-gating change, matching the pattern of the earlier rc-v1-C002 through C006 tasks in this same initiative, which also landed without a version/CHANGELOG bump).

Related: `mcp-bridge.md`, `task-lifecycle.md`, `release-flow.md`, `architecture.md`.
