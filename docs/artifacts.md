# Task Artifacts

Typed, agent-produced outputs attached to a task — build logs, test reports,
coverage summaries, generated code, diffs. Distinct from `TaskAttachment`,
which is a human-uploaded metadata pointer with no semantics.

The motivating use case is multi-stage agent pipelines: Stage N reads the
artifacts produced by Stage N-1 to decide what to do next (e.g. a reviewer
agent reads the build-log artifact to know whether the build was green).

## Data model

| Field              | Type     | Notes                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------- |
| `id`               | uuid     |                                                                       |
| `taskId`           | uuid     | Cascade-deleted with the task.                                        |
| `type`             | enum     | `build_log`, `test_report`, `generated_code`, `coverage`, `diff`, `other`. |
| `name`             | string   | 1–255 chars. Filename-style label shown in the UI.                   |
| `description`      | string?  | ≤1000 chars. Optional human-readable note.                            |
| `content`          | text?    | Inline payload. Capped at **1 MiB (1 048 576 bytes)**.                |
| `url`              | string?  | External pointer (S3, GitHub release, …) when content is not inline.  |
| `mimeType`         | string?  | Optional. Used as the MIME hint when downloading.                     |
| `sizeBytes`        | int      | UTF-8 byte length of `content`; `0` if only `url` is set.             |
| `createdByUserId`  | uuid?    | Set when a human creates the artifact.                                |
| `createdByAgentId` | uuid?    | Set when an agent creates the artifact (agent-token id).              |
| `createdAt`        | datetime |                                                                       |

Either `content` or `url` must be supplied — never both empty.

## Storage limits

- **Inline (`content`):** 1 MiB per artifact. Rejected with `413` if exceeded.
- **External (`url`):** no size cap enforced by agent-tasks; the referenced
  store is responsible for lifecycle.
- **Per-task count cap:** once a task reaches its count cap the next `POST`
  is rejected with `429`. Default: 100 artifacts per task.
  Override globally with the env var `ARTIFACT_MAX_COUNT_PER_TASK`.
  Override per-project via the `Project.artifactCountCap` column (see below).
- **Per-task aggregate bytes cap:** the sum of all `sizeBytes` values for
  a task's artifacts must not exceed the cap. A new artifact that would push
  the total over the cap is rejected with `413`. Default: 52 428 800 bytes
  (50 MiB). Override globally with `ARTIFACT_MAX_TOTAL_BYTES_PER_TASK`.
  Override per-project via `Project.artifactBytesCap`.

### Per-project overrides

Two nullable columns on `Project` let operators set lower (or higher) limits
for a specific project without changing the server-wide env var:

| Column              | Type   | Default (when null)               |
| ------------------- | ------ | --------------------------------- |
| `artifactCountCap`  | `Int?` | `ARTIFACT_MAX_COUNT_PER_TASK` (100) |
| `artifactBytesCap`  | `Int?` | `ARTIFACT_MAX_TOTAL_BYTES_PER_TASK` (50 MiB) |

Set them via a direct DB update or a future admin API endpoint. A `null`
value — or a stray non-positive value — means "use the env-var default," so a
mis-set `0`/negative cap can never silently block every artifact.

## REST endpoints

All endpoints require a Bearer token or a web session with access to the
task's project.

### `POST /api/tasks/{id}/artifacts`

Create an artifact. Agents need the `tasks:update` scope.

Request body:

```json
{
  "type": "test_report",
  "name": "vitest.log",
  "description": "Smoke tests from commit abc123",
  "content": "PASS src/foo.test.ts\n…",
  "mimeType": "text/plain"
}
```

Response: `201 { "artifact": { … } }`

### `GET /api/tasks/{id}/artifacts`

List artifact metadata (most-recent first). Agents need `tasks:read`.
Optional query param `?type=build_log` filters by type.

> Metadata only — the `content` column is **not** returned by the list
> endpoint. Fetch a single artifact by id to get the inline payload.

### `GET /api/tasks/{id}/artifacts/{artifactId}`

Fetch one artifact including its `content`. Agents need `tasks:read`.

### `DELETE /api/tasks/{id}/artifacts/{artifactId}`

Delete. Only the creator (same user or same agent token) or a project admin
may delete an artifact.

## MCP tools

The v2 MCP surface exposes three verbs:

- `task_artifact_create` — mirror of `POST /tasks/:id/artifacts`.
- `task_artifact_list` — metadata-only list with optional `type` filter.
- `task_artifact_get` — fetch one artifact with `content`.

Example agent flow:

```text
task_start(taskId)
  … run tests …
task_artifact_create({
  taskId,
  type: "test_report",
  name: "vitest.log",
  content: capturedOutput
})
task_finish({ taskId, outcome: "approve" })
```

A reviewer agent picking up the same task can then call `task_artifact_list`
to discover the test report and `task_artifact_get` to read it before
deciding on `approve` vs. `request_changes`.

## Audit log

Every create/delete emits an `AuditLog` entry with action
`task.artifact.created` / `task.artifact.deleted` and a payload including
`artifactId`, `artifactType`, and `sizeBytes` (on create).
