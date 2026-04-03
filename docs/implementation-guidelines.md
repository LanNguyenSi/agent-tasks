# Implementation Guidelines

## Architekturansatz
DDD light / modularer Monolith.

## Empfohlene Module
- Identity
- Teams
- Agents
- Projects
- Tasks
- Boards
- Workflows
- Audit
- Integrations

## Empfehlungen
- Keine Business-Regeln in Controller legen
- Workflow-Validierung zentral kapseln
- Task-Claiming konfliktfest implementieren
- GitHub-Sync idempotent gestalten
- Audit-Log nicht optional behandeln

## Teststrategie
- Unit-Tests für Regeln und Policies
- Integrationstests für API + Persistence
- Contract-Tests für externe Integrationen
- End-to-End-Tests für Kernflüsse:
  - Login
  - Project Sync
  - Task Create
  - Claim
  - Review Handoff
  - Deploy Policy Check
