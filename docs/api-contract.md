# API contract

There is a single source of truth, served live by the running backend, and one prose narrative beside it.

| Audience | Read |
|---|---|
| You want to call the API and want a machine-readable schema | [OpenAPI JSON](https://agent-tasks.opentriologue.ai/api/openapi.json) at `/api/openapi.json`, generated from `backend/src/routes/docs.ts`. |
| You want to explore the API interactively | [Swagger UI](https://agent-tasks.opentriologue.ai/docs) at `/docs` (alias `/api/docs`). |
| You want a curated overview of the verb shape, in prose | [`v2-api.md`](v2-api.md) — endpoints, agent authentication, merge-event paths, governance-mode gates. |
| You want the agent-facing MCP verb declarations | [`mcp-server/src/tools.ts`](../mcp-server/src/tools.ts), the source of truth for `task_pickup`, `task_start`, `task_finish`, `task_merge`, `task_submit_pr`, `task_artifact_*`, `signals_*`, and the deprecated v1 verbs. |
| You want a written walkthrough of the agent flow | [`getting-started.md`](getting-started.md), [`agent-workflow.md`](agent-workflow.md). |

This page exists only as a pointer because a static markdown copy of the API would drift within a release. The OpenAPI doc, the Swagger UI, and `mcp-server/src/tools.ts` ship from the same backend and stay aligned by construction.

For domain entities + state machines + events, see [`domain-model.md`](domain-model.md), [`state-machines.md`](state-machines.md), [`events.md`](events.md).
