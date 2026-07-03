---
type: module
title: "mcp-server: stdio MCP wrapper over the REST API"
description: "Publishes the v2 verb surface as MCP tools over a fixed bearer token; SERVER_VERSION is a hand-maintained constant, not derived from package.json."
tags: [mcp, stdio, npm-package]
timestamp: 2026-07-03T10:59:39Z
sources:
  - mcp-server/src/index.ts
  - mcp-server/src/server.ts
  - mcp-server/src/client.ts
  - mcp-server/src/tools.ts
  - mcp-server/package.json
---

Published as `@agent-tasks/mcp-server` (npm, public). Entry point `mcp-server/src/index.ts` reads `AGENT_TASKS_TOKEN` (required, throws if absent) and `AGENT_TASKS_BASE_URL` (optional, default `https://agent-tasks.opentriologue.ai`, `DEFAULT_BASE_URL` in `server.ts`), then calls `runStdioServer`.

`mcp-server/src/server.ts` builds an `McpServer` (`@modelcontextprotocol/sdk`) named `SERVER_NAME = "agent-tasks-mcp"` at `SERVER_VERSION = "0.10.0"`, wires it to a `StdioServerTransport`, and registers every tool from `buildTools(client)` (`tools.ts`). `mcp-server/src/client.ts` (`AgentTasksClient`) is a thin fetch wrapper: every request sends `Authorization: Bearer <token>` and `Accept: application/json`; non-2xx responses throw `AgentTasksApiError(status, body, message)`.

**Tool surface** (`tools.ts`, one `name:` per registered tool) mirrors the backend v2 verbs 1:1: `task_pickup`, `task_start`, `task_finish`, `task_create`, `task_abandon`, `task_submit_pr`, `task_merge`, `task_note`, `task_artifact_create/list/get`, `task_attachment_list/get`, plus the classic-REST-shaped `projects_list`, `projects_get`, `projects_get_effective_gates`, `project_tasks`, `tasks_list/get/instructions/create/claim/release/transition/update/comment`, `review_approve/request_changes/claim/release`, `signals_poll/ack`, `pull_requests_create/merge/comment`.

**Version constant risk**: `SERVER_VERSION` in `server.ts` (`"0.10.0"`) is a separate literal from `mcp-server/package.json#version` (also currently `"0.10.0"`), there is no test in `mcp-server/tests/` asserting they match (checked: `client.test.ts`, `tools.test.ts`, neither references `SERVER_VERSION`). Contrast with `mcp-bridge.md`, which has an explicit drift-guard test for its own version constant. Bumping the package version for a release requires manually bumping `SERVER_VERSION` too; nothing enforces it.

Related: `mcp-bridge.md`, `task-lifecycle.md`, `release-flow.md`, `architecture.md`.
