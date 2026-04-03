# TASKS

## Critical Path

001 -> 002 -> 003 -> 015

## wave-1

Lock scope, assumptions, and engineering baseline.

### 001 Write project charter and architecture baseline

- Priority: P0
- Category: foundation
- Depends on: none
- Summary: Capture the product scope, users, constraints, architecture shape, and open questions.

### 002 Set up repository and delivery baseline

- Priority: P0
- Category: foundation
- Depends on: 001
- Summary: Create the repository structure, quality checks, and basic documentation needed for implementation.

## wave-2

Deliver the first critical capabilities and required controls.

### 003 Implement GitHub OAuth Login für Menschen

- Priority: P0
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: GitHub OAuth Login für Menschen.

### 004 Implement Dedizierte API-Tokens für Agenten (kein Session-basierter Zugriff)

- Priority: P0
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Dedizierte API-Tokens für Agenten (kein Session-basierter Zugriff).

## wave-3

Expand feature coverage once the core path is in place.

### 005 Implement Projektsynchronisation aus GitHub (Repos, Issues, PRs)

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Projektsynchronisation aus GitHub (Repos, Issues, PRs).

### 006 Implement Manuelle Projekterstellung möglich

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Manuelle Projekterstellung möglich.

### 007 Implement Task-Erstellung durch Menschen und Agenten

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Task-Erstellung durch Menschen und Agenten.

### 008 Implement Task-Claiming durch Menschen und Agenten

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Task-Claiming durch Menschen und Agenten.

### 009 Implement Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung)

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung).

### 010 Implement Teams und Projekte als zentrale Mandanten-/Struktureinheit

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Teams und Projekte als zentrale Mandanten-/Struktureinheit.

### 011 Implement Audit-Trail für alle relevanten Aktionen

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Audit-Trail für alle relevanten Aktionen.

### 012 Implement Board-Ansicht für Tasks (Kanban-style)

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Board-Ansicht für Tasks (Kanban-style).

### 013 Implement Review-Handoff zwischen Agenten und Menschen

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Review-Handoff zwischen Agenten und Menschen.

### 014 Implement Policy-gesteuerte Zugriffsrechte: was dürfen Agenten tun?

- Priority: P1
- Category: feature
- Depends on: 001, 002
- Summary: Design and implement the capability for: Policy-gesteuerte Zugriffsrechte: was dürfen Agenten tun?.

## wave-4

Harden, verify, and prepare the system for release.

### 015 Add integration and error-handling coverage

- Priority: P1
- Category: quality
- Depends on: 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014
- Summary: Verify the critical path, failure handling, and integration boundaries with tests.
