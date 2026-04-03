# Project Charter: agent-tasks

## Summary

agent-tasks ist eine kollaborative Task-Plattform für Menschen und Agenten. Sie ermöglicht strukturierte Zusammenarbeit rund um Softwareprojekte, inklusive Aufgabenerstellung, Claiming, Review-Handoffs, konfigurierbaren Boards und klaren Verantwortlichkeiten. Agenten arbeiten mit dedizierten API-Tokens, Menschen mit GitHub OAuth. Alle Aktionen sind auditierbar und policy-gesteuert.

## Target Users

- Software-Teams die AI-Agenten in ihren Workflow einbinden
- AI-Agenten (Ice, Lava) die Tasks autonom übernehmen und implementieren
- Tech Leads die Workflows und Policies konfigurieren

## Core Features

- GitHub OAuth Login für Menschen
- Dedizierte API-Tokens für Agenten (kein Session-basierter Zugriff)
- Projektsynchronisation aus GitHub (Repos, Issues, PRs)
- Manuelle Projekterstellung möglich
- Task-Erstellung durch Menschen und Agenten
- Task-Claiming durch Menschen und Agenten
- Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung)
- Teams und Projekte als zentrale Mandanten-/Struktureinheit
- Audit-Trail für alle relevanten Aktionen
- Board-Ansicht für Tasks (Kanban-style)
- Review-Handoff zwischen Agenten und Menschen
- Policy-gesteuerte Zugriffsrechte: was dürfen Agenten tun?

## Constraints

- Kein unkontrollierter Vollzugriff für Agenten
- Kein rein informelles Task-Tracking ohne Workflow-Regeln
- Kein Deployment ohne klar definierte Verantwortlichkeit
- Workflow-Regeln konfigurierbar, nicht hartkodiert

## Non-Functional Requirements

- Audit-Trail: alle relevanten Aktionen nachvollziehbar
- Policy-basierte Zugriffskontrolle
- GitHub Webhook-Verarbeitung zuverlässig
- API-First: alle Funktionen via REST API verfügbar
- Docker-basiertes Deployment

## Delivery Context

- Planner profile: platform
- Intake completeness: complete
- Phase: phase_1
- Path: core
- Data sensitivity: moderate

## Applicable Playbooks

- /root/.openclaw/workspace/git/agent-planforge/playbooks/planning-and-scoping.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/01-project-setup.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/02-architecture.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/03-team-roles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/04-design-principles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/05-development-workflow.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/06-testing-strategy.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/07-quality-assurance.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/08-documentation.md

## Missing Information

- None

## Follow-Up Questions

- None

## Open Questions

- TypeScript/Node.js oder Python als Backend-Stack?
- Welche Workflow-Engine für State-Machines (hardkodiert vs. konfigurierbar)?
- Monolith oder Service-Trennung für Auth/Webhook-Handling?
