# ADR 0006: Relational Database as Primary Store

## Status
Accepted

## Context
Die Kernobjekte (Teams, Projekte, Tasks, Token, Memberships, Audit) sind stark relational und benötigen konsistente Transaktionen.

## Decision
PostgreSQL ist der primäre Datenspeicher, Zugriff über Prisma.

## Consequences
- Gute Datenkonsistenz und klare Modellierung von Beziehungen
- Etablierte Migrations- und Query-Werkzeuge
- Zusätzliche Speichermodelle nur bei klarem Bedarf als Ergänzung, nicht als Ersatz
