# LLM rewrite helper (Suggest improvement)

An opt-in, advisory-only endpoint that asks an LLM to rewrite a task's
description so it addresses the task's own confidence findings. Per
[ADR-0011](adr/0011-split-confidence-scoring-into-quality-analysis-and-claim-policy.md):
LLMs are advisory only, never gating. `POST /tasks/:id/suggest-rewrite`
never writes to the task -- it returns a suggestion for a human to review;
applying it is the caller's own, separate `PATCH /tasks/:id`.

## Configuration

Two env vars, both optional:

```bash
# Required to enable the endpoint at all. Unset -> every project gets a 503.
ANTHROPIC_API_KEY=sk-ant-...

# Optional model override. Default: claude-haiku-4-5.
AGENT_TASKS_REWRITE_MODEL=claude-haiku-4-5
```

Setting `ANTHROPIC_API_KEY` makes the endpoint *available*; it does not
turn it on for any project. Each project must also opt in:

```bash
curl -X PATCH https://agent-tasks.example/api/projects/$PROJECT_ID \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"aiHelpersEnabled": true}'
```

`aiHelpersEnabled` defaults to `false`. An off project's endpoint 404s
identically to a missing task, so the feature is invisible unless
explicitly opted in -- no `ANTHROPIC_API_KEY` touch, no external egress,
ever happens for it. Only team admins can flip this flag; the change is
audited (`project.updated`, `changes.aiHelpersEnabled`).

## Request / response

```bash
curl -X POST https://agent-tasks.example/api/tasks/$TASK_ID/suggest-rewrite \
  -H "Authorization: Bearer $TOKEN"
```

```jsonc
{
  "suggestion": "Rewritten description text...",
  "changedSignals": ["missing_acceptance_criteria", "vague_scope"]
}
```

`changedSignals` lists the confidence-finding `code` values (see the
Confidence schema's `findings`) the suggestion addresses. Nothing is
applied automatically -- `PATCH /tasks/:id` with `suggestion` as the new
`description` yourself, after a human reviews the diff. The web UI's
"Suggest improvement" button (on the Improvement panel) does exactly that,
behind a before/after diff modal with an explicit Apply step.

## Errors

| Status | `error`                | When |
| ------ | ---------------------- | ---- |
| 404    | (task-not-found shape) | Task does not exist, or the project has `aiHelpersEnabled: false` |
| 503    | `llm_not_configured`   | Server has no `ANTHROPIC_API_KEY` configured |
| 502    | `llm_request_failed`   | The Anthropic API call failed, or its response was not parseable JSON |
| 502    | `llm_response_truncated` | The response hit the model's output-token limit before finishing |

## Security posture

- **Advisory only, structurally.** The request declares no `tools` --
  a tool-less call cannot invoke `task_finish`, `task_start`, or any other
  mutating verb. The route handler itself never calls a mutating Prisma
  verb (`create`/`update`/`upsert`/`delete`); this is enforced by a source
  scan at CI time (`backend/tests/unit/suggest-rewrite-no-mutation-guard.test.ts`),
  not just by convention.
- **Prompt injection mitigation.** The task's title, description, and
  findings are untrusted, user-or-agent-writable content. They are wrapped
  in explicit `<task_title>`/`<task_description>`/`<findings>` tags with an
  instruction that tagged content is data, never instructions -- the same
  trust-boundary posture this repo applies to repository/task content
  generally. This reduces, but does not eliminate, prompt-injection risk;
  the tool-less/advisory-only design above is the structural backstop that
  does not depend on the model obeying the delimiter.
- **Rate-limited.** `POST /tasks/:id/suggest-rewrite` is capped at 10
  requests/minute per (caller IP, path) in `app.ts` -- it is a paid,
  externally-billed call, and the Anthropic SDK's own defaults (10-minute
  timeout, 2 retries, and a timed-out request IS retried) could otherwise
  let one burst tie up disproportionate server time and API spend. The
  server-side client itself also trims those SDK defaults down to a 30s
  timeout and a single retry.
- **No key material in error responses.** A 503 tells the caller the
  helper "is not configured on this server" without naming the env var;
  the env var name is documented here and in the OpenAPI spec, and logged
  server-side, for whoever operates the deployment.
