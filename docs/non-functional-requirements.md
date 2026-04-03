# Non-Functional Requirements

## Sicherheit
- GitHub OAuth für Humans
- Agent-Zugriff nur über Tokens mit Scopes
- Token-Rotation und Widerruf
- Auditierbarkeit aller kritischen Aktionen

## Skalierung
- Mehrmandantenfähig pro Team
- Sync- und Webhook-Verarbeitung asynchron möglich
- Idempotente Verarbeitung wiederholter Events

## Konsistenz
- Optimistic Locking bei konkurrierenden Änderungen
- Konfliktbehandlung bei parallelem Claiming

## Beobachtbarkeit
- strukturierte Logs
- Metriken für Sync, Claims, Transitionen, Fehler
- Tracing über Request-/Event-Korrelation

## Wartbarkeit
- modulare Architektur
- klar getrennte Fachdomänen
- testbare Workflow-Regeln

## UX
- klare Zustände und Verantwortlichkeiten
- Nachvollziehbarkeit pro Task
- gute Fehlermeldungen bei Regelverletzungen
