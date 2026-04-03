# Architecture

## Empfohlene Sicht
Modularer Monolith oder klar strukturierte Services mit:
- Web UI
- Backend API
- Auth / Identity
- Workflow Engine
- GitHub Sync / Webhook Handling
- Notification / Event Layer
- Database

## Diagramme
- Systemarchitektur: `../diagrams/architecture-overview.mmd`
- Domänenübersicht: `../diagrams/domain-overview.mmd`

## Technische Prinzipien
- GitHub OAuth als primärer Human-Login
- Agenten mit separaten API-Tokens
- GitHub-Projekte werden synchronisiert, manuelle Projekte bleiben möglich
- Workflow-Regeln sind konfigurierbar, nicht hartkodiert
- Kritische Aktionen sind policy-gesteuert
