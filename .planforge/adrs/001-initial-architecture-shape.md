# ADR-001: Initial Architecture Shape

## Context

Project: agent-tasks

Summary: agent-tasks ist eine kollaborative Task-Plattform für Menschen und Agenten. Sie ermöglicht strukturierte Zusammenarbeit rund um Softwareprojekte, inklusive Aufgabenerstellung, Claiming, Review-Handoffs, konfigurierbaren Boards und klaren Verantwortlichkeiten. Agenten arbeiten mit dedizierten API-Tokens, Menschen mit GitHub OAuth. Alle Aktionen sind auditierbar und policy-gesteuert.

## Decision

Start with modular monolith as the default architecture.

## Consequences

### Positive

- Faster alignment on a high-leverage decision.
- Better reviewability for future changes.

### Negative

- This decision may need revision as requirements sharpen.

### Follow-Up

- Validate this ADR during the first implementation wave.
- Update if significant scope or risk assumptions change.
