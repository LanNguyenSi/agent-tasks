# Delivery Plan

## Execution Waves

## wave-1

Lock scope, assumptions, and engineering baseline.

- 001 Write project charter and architecture baseline
- 002 Set up repository and delivery baseline

## wave-2

Deliver the first critical capabilities and required controls.

- 003 Implement GitHub OAuth Login für Menschen
- 004 Implement Dedizierte API-Tokens für Agenten (kein Session-basierter Zugriff)

## wave-3

Expand feature coverage once the core path is in place.

- 005 Implement Projektsynchronisation aus GitHub (Repos, Issues, PRs)
- 006 Implement Manuelle Projekterstellung möglich
- 007 Implement Task-Erstellung durch Menschen und Agenten
- 008 Implement Task-Claiming durch Menschen und Agenten
- 009 Implement Konfigurierbare Workflow-Regeln (Statusübergänge, Review-Pflicht, Deployment-Verantwortung)
- 010 Implement Teams und Projekte als zentrale Mandanten-/Struktureinheit
- 011 Implement Audit-Trail für alle relevanten Aktionen
- 012 Implement Board-Ansicht für Tasks (Kanban-style)
- 013 Implement Review-Handoff zwischen Agenten und Menschen
- 014 Implement Policy-gesteuerte Zugriffsrechte: was dürfen Agenten tun?

## wave-4

Harden, verify, and prepare the system for release.

- 015 Add integration and error-handling coverage

## Dependency Edges

- 001 -> 002
- 001 -> 003
- 002 -> 003
- 001 -> 004
- 002 -> 004
- 001 -> 005
- 002 -> 005
- 001 -> 006
- 002 -> 006
- 001 -> 007
- 002 -> 007
- 001 -> 008
- 002 -> 008
- 001 -> 009
- 002 -> 009
- 001 -> 010
- 002 -> 010
- 001 -> 011
- 002 -> 011
- 001 -> 012
- 002 -> 012
- 001 -> 013
- 002 -> 013
- 001 -> 014
- 002 -> 014
- 003 -> 015
- 004 -> 015
- 005 -> 015
- 006 -> 015
- 007 -> 015
- 008 -> 015
- 009 -> 015
- 010 -> 015
- 011 -> 015
- 012 -> 015
- 013 -> 015
- 014 -> 015

## Critical Path

001 -> 002 -> 003 -> 015
