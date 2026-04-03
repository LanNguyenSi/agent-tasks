# ADR 0007: Integrations Behind Internal Boundaries

## Status
Accepted

## Context
GitHub OAuth, Repository-Sync und Webhook-Verarbeitung bringen externe Fehlermodi, Latenzen und Rate-Limits mit.

## Decision
Externe Integrationen werden hinter internen Modulen gekapselt; Fehler- und Retry-Semantik wird explizit modelliert.

## Consequences
- Bessere Testbarkeit und kontrollierbare Failure-Paths
- Provider-Wechsel oder Mocking wird einfacher
- Etwas mehr Initialaufwand in den Modul-Schnittstellen
