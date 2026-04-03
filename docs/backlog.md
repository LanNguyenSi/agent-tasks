# Backlog

Dieser Backlog ist inhaltlich auf dem früheren Planungsstand aufgebaut und enthält wieder die zentralen Steuerungsfelder je Task.

## Übersicht

| ID | Titel | Wave | Priority | Category | Depends On | Blocks |
|---|---|---|---|---|---|---|
| 001 | Write project charter and architecture baseline | wave-1 | P0 | foundation | None | 002-014 |
| 002 | Set up repository and delivery baseline | wave-1 | P0 | foundation | 001 | 003-014 |
| 003 | Implement GitHub OAuth Login für Menschen | wave-2 | P0 | feature | 001, 002 | 015 |
| 004 | Implement Dedizierte API-Tokens für Agenten (kein Session-basierter Zugriff) | wave-2 | P0 | feature | 001, 002 | 015 |
| 005 | Implement Projektsynchronisation aus GitHub (Repos, Issues, PRs) | wave-3 | P1 | feature | 001, 002 | 015 |
| 006 | Implement Manuelle Projekterstellung möglich | wave-3 | P1 | feature | 001, 002 | 015 |
| 007 | Implement Task-Erstellung durch Menschen und Agenten | wave-3 | P1 | feature | 001, 002 | 015 |
| 008 | Implement Task-Claiming durch Menschen und Agenten | wave-3 | P1 | feature | 001, 002 | 015 |
| 009 | Implement Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung) | wave-3 | P1 | feature | 001, 002 | 015 |
| 010 | Implement Teams und Projekte als zentrale Mandanten-/Struktureinheit | wave-3 | P1 | feature | 001, 002 | 015 |
| 011 | Implement Audit-Trail für alle relevanten Aktionen | wave-3 | P1 | feature | 001, 002 | 015 |
| 012 | Implement Board-Ansicht für Tasks (Kanban-style) | wave-3 | P1 | feature | 001, 002 | 015 |
| 013 | Implement Review-Handoff zwischen Agenten und Menschen | wave-3 | P1 | feature | 001, 002 | 015 |
| 014 | Implement Policy-gesteuerte Zugriffsrechte: was dürfen Agenten tun? | wave-3 | P1 | feature | 001, 002 | 015 |
| 015 | Add integration and error-handling coverage | wave-4 | P1 | quality | 003-014 | None |

## Wave 1

### 001 Write project charter and architecture baseline
- Summary: Capture the product scope, users, constraints, architecture shape, and open questions.
- Problem: Rough requirements need a shared baseline before implementation can be reviewed and sequenced.
- Solution: Create charter, architecture overview, and initial ADRs.
- Acceptance:
  - Charter includes summary, users, features, constraints, unresolved questions.
  - Architecture overview states recommended starting shape and tradeoffs.
  - Initial ADRs exist for highest-leverage early decisions.

### 002 Set up repository and delivery baseline
- Summary: Create repository structure, quality checks, and baseline documentation.
- Problem: Execution fragments without shared repo, checks, and workflow expectations.
- Solution: Establish test path, delivery workflow expectations, and starter docs.
- Acceptance:
  - Repeatable local test command exists.
  - Core delivery expectations are documented for humans and agents.
  - Repo structure is sufficient to start implementation waves.

## Wave 2

### 003 Implement GitHub OAuth Login für Menschen
- Summary: Deliver reviewable, testable GitHub OAuth login for humans.
- Problem: Initial scope is not fulfillable without human OAuth login.
- Solution: Add focused auth module with explicit integration boundaries.
- Scope anchors:
  - Auth service, middleware and validation modules.
  - Auth endpoints (`register/login/me` in original plan template).
  - Schema and auth test coverage.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 004 Implement Dedizierte API-Tokens für Agenten (kein Session-basierter Zugriff)
- Summary: Deliver dedicated scoped API tokens for agents.
- Problem: Initial scope requires non-session based, policy-controllable agent access.
- Solution: Add focused module for token issuance, validation, revocation.
- Scope anchors:
  - Token service/repository module.
  - Integration test for token lifecycle.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

## Wave 3

### 005 Implement Projektsynchronisation aus GitHub (Repos, Issues, PRs)
- Summary: Add GitHub project synchronization and health visibility.
- Problem: Scope is incomplete without automated GitHub-backed project sync.
- Solution: Add focused integration module with explicit boundary to GitHub APIs.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 006 Implement Manuelle Projekterstellung möglich
- Summary: Add manual project creation flow.
- Problem: Scope needs manual project path independent of GitHub sync.
- Solution: Add focused project creation module.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 007 Implement Task-Erstellung durch Menschen und Agenten
- Summary: Enable task creation by human and agent actors.
- Problem: Scope requires mixed-actor task authoring.
- Solution: Add focused task-creation module with access constraints.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 008 Implement Task-Claiming durch Menschen und Agenten
- Summary: Enable claim flow for both actor types.
- Problem: Scope requires controlled ownership transitions on tasks.
- Solution: Add focused claiming module with clear validation and permissions.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 009 Implement Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung)
- Summary: Add configurable workflow and policy rules.
- Problem: Scope requires configurable governance beyond hardcoded flow.
- Solution: Add focused workflow-rules module with explicit boundaries.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 010 Implement Teams und Projekte als zentrale Mandanten-/Struktureinheit
- Summary: Implement tenant structure around teams and projects.
- Problem: Scope requires clear multitenant boundaries and role assignments.
- Solution: Add focused team/project tenancy module.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 011 Implement Audit-Trail für alle relevanten Aktionen
- Summary: Add audit trail for critical actions.
- Problem: Scope requires traceability and non-silent mutation logging.
- Solution: Add focused audit module plus query/view path.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.
  - Audit records capture actor, action, timestamp consistently.

### 012 Implement Board-Ansicht für Tasks (Kanban-style)
- Summary: Add Kanban-style task board view.
- Problem: Scope requires structured visual task operations.
- Solution: Add focused board module.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 013 Implement Review-Handoff zwischen Agenten und Menschen
- Summary: Add explicit review handoff between actor types.
- Problem: Scope requires controlled transition from implementation to review ownership.
- Solution: Add focused review-handoff module with audit integration.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

### 014 Implement Policy-gesteuerte Zugriffsrechte: was dürfen Agenten tun?
- Summary: Add policy-driven authorization for agent actions.
- Problem: Scope requires fine-grained control over agent behavior.
- Solution: Add focused policy module.
- Acceptance:
  - Capability is available via intended application surface.
  - Core validation, error handling, persistence are covered by tests.

## Wave 4

### 015 Add integration and error-handling coverage
- Summary: Verify critical path, failure handling, and integration boundaries.
- Problem: Silent regressions remain likely without explicit integration/error-path coverage.
- Solution: Add integration, contract and error-path focused tests.
- Acceptance:
  - Critical path behavior is exercised by automated tests.
  - Integration and error paths fail loudly instead of degrading silently.
  - Known edge cases are represented in tests.
