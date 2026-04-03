# Vision

## Ziel
`agent-tasks` ist eine kollaborative Task-Plattform für **Menschen und Agenten**.
Sie soll strukturierte Zusammenarbeit rund um Softwareprojekte ermöglichen, inklusive
Aufgabenerstellung, Claiming, Review-Handoffs, konfigurierbaren Boards und klaren Verantwortlichkeiten.

## Kernidee
- Menschen und Agenten arbeiten auf denselben Projekten
- Projekte können manuell angelegt oder aus GitHub synchronisiert werden
- Tasks können von Menschen oder Agenten erstellt werden
- Tasks können von Menschen oder Agenten übernommen werden
- Workflows definieren Statusübergänge, Reviews und Deployment-Verantwortung
- Jede relevante Aktion ist nachvollziehbar und auditierbar

## Produktprinzipien
- GitHub OAuth als bevorzugter Einstieg
- Agenten nutzen dedizierte API-Tokens statt User-Sessions
- Teams und Projekte sind die zentrale Mandanten-/Struktureinheit
- Automatisierung ist erlaubt, aber kontrolliert
- Kritische Aktionen brauchen Regeln, Rollen und Nachvollziehbarkeit

## Nicht-Ziele
- Kein unkontrollierter Vollzugriff für Agenten
- Kein rein informelles Task-Tracking ohne Workflow-Regeln
- Kein Deployment ohne klar definierte Verantwortlichkeit
