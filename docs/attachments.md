# Task Attachments

Human-uploaded files attached to a task: small **images** (jpeg, png, gif,
webp) and **text** documents (plain, markdown, csv). The bytes live on a disk
volume; the database stores metadata only. This is distinct from `TaskArtifact`
(typed, agent-produced outputs) and is human-only: agents do not upload files,
they create artifacts.

A `TaskAttachment` row can be one of two things:

- An **uploaded file**, created via `POST /api/tasks/{id}/attachments/upload`.
  Its `url` is `/uploads/<uuid>.<ext>` and the bytes are served back by the
  `raw` endpoint.
- A **URL pointer**, created via `POST /api/tasks/{id}/attachments`. Its `url`
  is an arbitrary external link and agent-tasks stores no bytes for it.

## Data model

| Field             | Type     | Notes                                                                       |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `id`              | uuid     |                                                                             |
| `taskId`          | uuid     | Cascade-deleted with the task.                                              |
| `name`            | string   | 1 to 255 chars. Display label shown in the UI.                              |
| `url`             | string   | `/uploads/<uuid>.<ext>` for uploads, or an external URL for pointers.       |
| `mimeType`        | string?  | Sniffed media type of an uploaded file. Null for URL pointers.              |
| `sizeBytes`       | int      | Byte length of the stored file. `0` for URL pointers.                       |
| `type`            | string   | `IMAGE` or `DOCUMENT`. Defaults to `DOCUMENT`.                              |
| `createdByUserId` | uuid?    | The human who created the attachment.                                       |
| `createdAt`       | datetime |                                                                             |

## Storage and limits

- **Size cap:** 5 MiB per file, for images and text alike. Larger uploads are
  rejected with `413`.
- **Allowed types:** `image/jpeg`, `image/png`, `image/gif`, `image/webp`,
  `text/plain`, `text/markdown`, `text/csv`. Anything else is rejected with
  `400`.
- **No SVG, PDF or JSON in v1.** SVG is excluded deliberately because it can
  carry embedded JavaScript (stored-XSS). PDF and JSON are out of scope.
- **Storage location:** the `UPLOAD_DIR` directory (`/app/uploads` in
  containers), backed by the `agent_tasks_uploads` named volume in production.
  This volume is **not** covered by the Postgres backups and must be added to
  the backup scope separately.
- **No per-task aggregate cap today.** A count/size cap across all of a task's
  attachments is tracked as a separate follow-up.

## Security model

- **Content sniffing, not the client Content-Type.** The stored and served
  media type comes from a magic-byte sniff of the file contents. An upload
  whose declared `Content-Type` disagrees with its bytes (for example a `.png`
  that is really a GIF, or a `text/plain` that is really a PNG) is rejected
  with `400`. Text uploads must additionally decode as valid UTF-8.
- **Filenames.** The on-disk filename is a random UUID plus an extension
  derived from the sniffed type. The original name is kept only in the `name`
  column, so a malicious filename cannot drive path traversal.
- **Serving.** The `raw` endpoint sets `X-Content-Type-Options: nosniff`,
  `Cache-Control: private`, and `Content-Disposition: inline` for images or
  `attachment` for text. It refuses to serve anything outside `UPLOAD_DIR`.
- **Auth.** Every endpoint requires a web session or a Bearer token with
  access to the task's project. Because the `raw` endpoint accepts the session
  cookie, a web `<img src>` works directly with no query-string token.
- **CSV / text is untrusted content.** Stored text and CSV are served back
  verbatim (with `nosniff` and an `attachment` disposition, so a browser never
  renders them). Treat a downloaded CSV as hostile: a cell beginning with `=`,
  `+`, `-`, or `@` can trigger formula execution if opened directly in a
  spreadsheet. Consumers that re-export to a spreadsheet should sanitize.

## REST endpoints

All endpoints require a Bearer token or a web session with access to the
task's project.

### `POST /api/tasks/{id}/attachments/upload`

Upload an image or text file. Human-only. Requires project write access
(`PROJECT_VIEWER` is read-only).

Request: `multipart/form-data` with a `file` part and an optional `name` text
field (defaults to the uploaded filename). Do not set the multipart
`Content-Type` boundary by hand; the HTTP client does that.

```bash
curl -X POST https://agent-tasks.opentriologue.ai/api/tasks/$TASK/attachments/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@screenshot.png" \
  -F "name=Login screen"
```

Response: `201 { "attachment": { ... } }`. Errors: `400` (missing/empty file,
disallowed type, content/Content-Type mismatch), `413` (over 5 MiB), `403`
(no write access), `404` (task not found).

### `POST /api/tasks/{id}/attachments`

Register a URL-pointer attachment (an external link, no bytes stored).
Human-only, requires write access.

```json
{ "name": "Design doc", "url": "https://example.com/doc" }
```

Response: `201 { "attachment": { ... } }`

### `GET /api/tasks/{id}/attachments`

List attachment metadata (most-recent first). Agents need `tasks:read`. Bytes
are never included; use `raw` (download) or `content` (agent-read) for those.

### `GET /api/tasks/{id}/attachments/{attachmentId}/raw`

Stream the stored bytes of an uploaded attachment. Agents need `tasks:read`.
Returns `404` for URL-pointer attachments (no bytes), for an attachment that
belongs to a different task, or when the backing file is missing.

### `GET /api/tasks/{id}/attachments/{attachmentId}/content`

Read an attachment as agent-consumable content rather than raw bytes: a UTF-8
text excerpt for text files, or base64 for images. Agents need `tasks:read`.

Query params: `includeBase64` (`true`/`1`/`yes`), `textByteLimit` (default
200000, max 800000), `base64ByteLimit` (default 65536, max 512000). Values
above the max are rejected with `400 bad_request`. `base64ByteLimit` caps the
returned base64 text length, not the raw file-byte size.

Response: `200 { "attachment": { id, taskId, name, mimeType, sizeBytes, type }, "content": { ... } }`
where `content` carries:

- `status`: `ready`, `missing` (URL-pointer or file gone), `unsupported`
  (mime not in the allowlist), or `error`.
- `encoding`: `utf-8` for a text excerpt, `base64` for an image, else null.
- `text` / `excerpt` (text files), `truncated`, `bytesRead`, `fileSize`.
- `base64` / `base64Included` / `base64Truncated`. Base64 is returned only when
  `includeBase64` is set and the file is within `base64ByteLimit`.

### `DELETE /api/tasks/{id}/attachments/{attachmentId}`

Delete. Human-only. Only the uploader or a project admin may delete. Removes
the database row and, for uploaded files, the backing file on disk.

## Listing

The full task view (`GET /api/tasks/{id}`) includes `attachments` with all
metadata fields and the `createdByUser` summary, most-recent first. File bytes
are never inlined in the task payload; fetch them from the `raw` endpoint.

## MCP tools

Agents read attachments through two read-only v2 verbs (no agent upload or
delete; agents produce `TaskArtifact`s for their own output):

- `task_attachment_list` — attachment metadata for a task.
- `task_attachment_get` — one attachment's content (text excerpt or, with
  `includeBase64`, base64), backed by the `content` endpoint above.

Use case: a human uploads a spec or an application document (handy for
non-GitHub projects), and an agent reads it with `task_attachment_get` to
process it.

## Audit log

The upload emits an `AuditLog` entry with action `task.attachment.uploaded`
(payload: `attachmentId`, `name`, `mimeType`, `sizeBytes`, `type`). Deletion
emits `task.attachment.deleted` (payload: `attachmentId`, `name`). The
URL-pointer create path emits no audit event.
