# API Contract

## Auth
### POST /auth/github/callback
Verarbeitet den OAuth-Callback und erstellt/aktualisiert die Session.

## Agent Tokens
### POST /agent-tokens
Erstellt ein neues Agent-Token.

### GET /agent-tokens
Listet Tokens für ein Team oder einen Agenten.

### POST /agent-tokens/{id}/revoke
Widerruft ein Token.

## Projects
### GET /projects
Listet verfügbare Projekte.

### POST /projects
Legt ein manuelles Projekt an.

### POST /projects/sync
Startet einen GitHub-Sync.

### GET /projects/{id}
Lädt Projektdetails.

## Tasks
### GET /projects/{id}/tasks
Listet Tasks eines Projekts.

### POST /projects/{id}/tasks
Erstellt eine neue Task.

### GET /tasks/{id}
Lädt Task-Details.

### POST /tasks/{id}/claim
Beansprucht eine Task.

### POST /tasks/{id}/release
Gibt eine Task frei.

### POST /tasks/{id}/transition
Führt einen Statusübergang aus.

### POST /tasks/{id}/comments
Fügt einen Kommentar hinzu.

### GET /tasks/{id}/artifacts
Listet Artifact-Metadaten (ohne Content). Optional `?type=` Filter. Siehe [artifacts.md](./artifacts.md).

### GET /tasks/{id}/artifacts/{artifactId}
Lädt ein einzelnes Artifact inklusive `content`.

### POST /tasks/{id}/artifacts
Legt ein typisiertes Agent-Output an (`build_log`, `test_report`, `generated_code`, `coverage`, `diff`, `other`). Inline-Limit 1 MiB.

### DELETE /tasks/{id}/artifacts/{artifactId}
Löscht ein Artifact (nur Ersteller oder Projekt-Admin).

### POST /tasks/{id}/merge
Task-scoped PR merge. Requires `github:pr_merge` scope for agent callers. Rejects with `403 self_merge_blocked` when the actor holds the work claim on a project with `governanceMode=REQUIRES_DISTINCT_REVIEWER` (legacy: `requireDistinctReviewer=true, soloMode=false`). Body: `{ "mergeMethod": "squash" | "merge" | "rebase" }` (default `squash`). See [agent-workflow.md](./agent-workflow.md#server-side-pr-lifecycle).

## GitHub delegation
### POST /github/pull-requests
Creates a pull request on behalf of a team member who has connected GitHub and enabled `allowAgentPrCreate`. Requires scopes `tasks:update` **and** `github:pr_create` for agent callers. Updates the task's `branchName` / `prUrl` / `prNumber` on success.

### POST /github/pull-requests/{prNumber}/merge
Merges a PR via the team's GitHub delegation (`allowAgentPrMerge`). Requires scopes `tasks:transition` **and** `github:pr_merge` for agent callers. Enforces the self-merge gate (`403 self_merge_blocked` when actor is the work claimant on a `governanceMode=REQUIRES_DISTINCT_REVIEWER` project). Prefer `POST /tasks/{id}/merge` when you already hold the task ID — it derives the GitHub metadata automatically.

### POST /github/pull-requests/{prNumber}/comments
Posts a PR comment via delegation (`allowAgentPrComment`). Requires scope `tasks:comment`.

## Boards
### GET /boards/{id}
Lädt Board-Konfiguration und Aufgabenansicht.

### PUT /boards/{id}
Aktualisiert Board-Konfiguration.

## Workflows
### GET /workflows/{id}
Lädt Workflow-Definition.

### PUT /workflows/{id}
Aktualisiert Workflow-Definition.

## Fehlerfälle
- 401 unauthenticated
- 403 forbidden
- 404 not_found
- 409 conflict
- 422 validation_failed

## Erwartete Prinzipien
- Idempotenz bei Sync/Webhook-nahen Aktionen
- Optimistic Locking für konkurrierende Task-Änderungen
- Scope-Validierung für Agent-Tokens
