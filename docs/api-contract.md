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
