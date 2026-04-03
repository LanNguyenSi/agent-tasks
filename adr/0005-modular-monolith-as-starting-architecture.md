# ADR 0005: Modular Monolith as Starting Architecture

## Status
Accepted

## Context
Für den aktuellen Scope müssen Auth, Tokens, Tasks, Projekte und Integrationen schnell iterierbar umgesetzt werden, ohne frühzeitige verteilte Systemkomplexität.

## Decision
Wir starten mit einem modularen Monolithen und klaren Modulgrenzen (`route -> service -> repository`).

## Consequences
- Schnellere Delivery bei geringerem Betriebsaufwand
- Klare Extraktionspfade für spätere Service-Splits
- Disziplin bei Modulgrenzen bleibt notwendig, damit kein "Big Ball of Mud" entsteht
