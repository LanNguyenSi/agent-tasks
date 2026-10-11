# API contract

The OpenAPI document at `/api/openapi.json` is maintained by hand in `backend/src/routes/docs.ts`. It describes a subset of the REST API: project discovery, lookup and settings update (including effective gates and the confidence telemetry), task list, create, read, update and claimable, finish, merge, abandon, respec, instructions, suggest-rewrite, the grounding attempt routes, the deprecated claim, release and transition routes, and the GitHub PR delegation routes. Routes it does not describe, including pickup, start, submit-pr, creator-abandon, signals, comments, review, attachments and artifacts, are listed in [`v2-api.md`](v2-api.md).

| Audience | Read |
|---|---|
| You want to call the API and want a machine-readable schema | [OpenAPI JSON](https://agent-tasks.opentriologue.ai/api/openapi.json) at `/api/openapi.json`, served from `backend/src/routes/docs.ts` (the subset above). |
| You want to explore the API interactively | [Swagger UI](https://agent-tasks.opentriologue.ai/docs) at `/docs` (alias `/api/docs`). |
| You want the full route list and the verb shape, in prose | [`v2-api.md`](v2-api.md), endpoints, agent authentication, merge-event paths, governance-mode gates. |
| You want the agent-facing MCP verb declarations | [`mcp-server/src/tools.ts`](../mcp-server/src/tools.ts), which declares the stdio MCP tools: the v2 verbs (`task_pickup`, `task_start`, `task_finish`, `task_merge`, `task_submit_pr`, `task_create`, `task_respec`, `task_abandon`, `task_creator_abandon`, `task_note`), `task_artifact_*`, `task_attachment_*`, `task_grounding_*`, `signals_*`, and the deprecated v1 verbs. |
| You want a written walkthrough of the agent flow | [`getting-started.md`](getting-started.md), [`agent-workflow.md`](agent-workflow.md). |

`mcp-server/src/tools.ts` is a separate package that calls these REST routes; individual parity tests cover parts of the OpenAPI document, so alignment is not automatic.

For domain entities + state machines + events, see [`domain-model.md`](domain-model.md), [`state-machines.md`](state-machines.md), [`events.md`](events.md).
