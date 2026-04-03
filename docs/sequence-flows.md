# Sequence Flows

## Übersicht
Dieses Dokument beschreibt die wichtigsten dynamischen Abläufe im System.

## 1. GitHub OAuth und initialer Project Sync
Siehe: `../diagrams/sequence-github-oauth-sync.mmd`

## 2. Agent erstellt und claimt Task
Siehe: `../diagrams/sequence-agent-create-claim.mmd`

## 3. Handoff zu Review und Deploy-Entscheidung
Siehe: `../diagrams/sequence-review-deploy.mmd`

## Hinweise
- Alle Flows müssen Audit-Events erzeugen
- Alle sicherheitsrelevanten Aktionen müssen Rechte/Scopes prüfen
- Wiederholte Webhooks und Sync-Events müssen idempotent behandelt werden
